#!/usr/bin/env python3
"""Read product pages into wardrobe items.

One function does the work:

    item = fetch_product("https://shop.example/p/123")

It tries `requests` first, because a plain GET that gets the real markup is by
far the fastest and most accurate route — the page's own schema.org JSON-LD is
exact, where anything inferred is a guess. Only when that comes back without a
product does it fall back to a headless browser, which is slower but runs the
page's JavaScript.

For many URLs, `fetch_products()` runs them in a small thread pool with a
random delay between requests, because hammering a retailer from one address
is how an address gets blocked.

This runs on your machine, not in the web page: a browser cannot fetch another
site, which is the whole reason the in-page version has to go through proxies.
Write the output to a file and load it with Wardrobe → Data → Import.

    python tools/fetch_products.py URL [URL ...] -o wardrobe-import.json
    python tools/fetch_products.py --input urls.txt -o wardrobe-import.json --workers 4

Only `requests` is required. A headless browser is used if `playwright` or
`selenium` happens to be installed, and is simply skipped if not.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html as htmllib
import json
import random
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional

try:
    import requests
except ImportError:                                            # pragma: no cover
    requests = None


# ── vocabulary, matching the app so the output imports cleanly ───────────────

CATEGORIES = ["top", "bottom", "dress", "outerwear", "footwear", "accessory",
              "jewellery", "bag", "activewear", "traditional"]
FORMALITIES = ["loungewear", "casual", "smart-casual", "business", "formal"]
SEASONS = ["summer", "monsoon", "winter", "all-season"]

CATEGORY_WORDS = [
    ("footwear", ["shoe", "sneaker", "trainer", "loafer", "sandal", "boot", "heel",
                  "flip flop", "slipper", "derby", "oxford shoe", "chappal", "juti",
                  "mojari"]),
    ("outerwear", ["jacket", "coat", "blazer", "overcoat", "puffer", "parka",
                   "windcheater", "cardigan", "hoodie", "sweatshirt", "sweater",
                   "pullover", "shrug"]),
    ("bottom", ["jeans", "trouser", "pant", "chino", "short", "skirt", "cargo",
                "jogger", "legging", "palazzo", "pyjama", "track pant", "dhoti",
                "churidar", "salwar"]),
    ("dress", ["dress", "gown", "jumpsuit", "frock"]),
    ("traditional", ["kurta", "saree", "sari", "lehenga", "sherwani", "anarkali",
                     "kurti", "ethnic", "achkan", "nehru jacket", "dupatta"]),
    ("bag", ["bag", "backpack", "rucksack", "tote", "clutch", "sling", "wallet",
             "handbag", "duffel"]),
    ("jewellery", ["ring", "necklace", "earring", "bracelet", "chain", "pendant",
                   "bangle", "watch", "anklet"]),
    ("activewear", ["sports bra", "active", "gym", "training tee", "running"]),
    ("accessory", ["belt", "cap", "hat", "scarf", "stole", "sunglass", "tie",
                   "sock", "glove", "muffler"]),
    ("top", ["shirt", "t-shirt", "tshirt", "tee", "top", "polo", "blouse", "vest",
             "camisole", "crop"]),
]

COLOURS = [
    "black", "charcoal", "grey", "gray", "silver", "white", "off-white", "ivory",
    "cream", "beige", "tan", "camel", "khaki", "taupe", "brown", "chocolate",
    "navy", "blue", "sky", "indigo", "denim", "teal", "turquoise", "green",
    "olive", "sage", "mint", "forest", "yellow", "mustard", "amber", "orange",
    "coral", "peach", "rust", "terracotta", "red", "maroon", "burgundy", "wine",
    "pink", "blush", "rose", "mauve", "purple", "lavender", "plum", "magenta",
]

MATERIALS = ["cotton", "linen", "silk", "wool", "denim", "leather", "polyester",
             "rayon", "viscose", "nylon", "satin", "velvet", "chiffon", "georgette",
             "khadi", "jute", "cashmere", "corduroy", "fleece", "mesh", "suede",
             "canvas", "lycra", "spandex", "modal", "chambray", "tweed"]

PATTERNS = ["solid", "printed", "striped", "checked", "checkered", "plaid",
            "floral", "polka", "embroidered", "graphic", "colourblocked",
            "colorblocked", "textured", "ribbed", "washed", "distressed"]

FORMALITY_WORDS = [
    ("formal", ["sherwani", "gown", "tuxedo", "wedding", "bridal", "ceremonial"]),
    ("business", ["formal", "office", "business", "blazer", "suit", "derby"]),
    ("loungewear", ["lounge", "pyjama", "night", "track", "gym", "sports",
                    "running", "active"]),
    ("smart-casual", ["semi-formal", "party", "smart", "chino", "polo"]),
]

SEASON_WORDS = [
    ("winter", ["wool", "fleece", "puffer", "thermal", "sweater", "coat",
                "cashmere", "corduroy", "tweed"]),
    ("summer", ["linen", "cotton", "shorts", "sleeveless", "chiffon", "mesh"]),
    ("monsoon", ["waterproof", "rain", "quick dry", "windcheater"]),
]

# Shops serve a different page to something that announces itself as a script.
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Cache-Control": "no-cache",
}


class FetchError(Exception):
    """The page could not be read by any available route."""


# ── parsing ──────────────────────────────────────────────────────────────────

def _first(value: Any) -> str:
    if isinstance(value, list):
        return _first(value[0]) if value else ""
    if isinstance(value, dict):
        return value.get("name") or value.get("url") or ""
    return value or ""


def _number(value: Any) -> Optional[float]:
    """The price, out of whatever the page formats it as.

    Stripping non-digits turns "Rs. 1,299.00" into ".1299" — match the number
    instead of filtering characters.
    """
    m = re.search(r"\d[\d,]*(?:\.\d+)?", str(value if value is not None else ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def _jsonld_products(text: str) -> List[dict]:
    """Every schema.org Product on the page, flattened through @graph."""
    out: List[dict] = []
    for block in re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            text, re.S | re.I):
        try:
            parsed = json.loads(block.strip())
        except (ValueError, TypeError):
            continue
        queue = parsed if isinstance(parsed, list) else [parsed]
        while queue:
            node = queue.pop(0)
            if not isinstance(node, dict):
                continue
            if isinstance(node.get("@graph"), list):
                queue.extend(node["@graph"])
            types = node.get("@type")
            types = types if isinstance(types, list) else [types]
            if any(str(t).lower() == "product" for t in types):
                out.append(node)
    return out


def _embedded_product(text: str) -> Optional[dict]:
    """The bootstrap JSON these sites ship for their own scripts.

    Myntra, Ajio and most large retailers render client-side, so the markup has
    no product in it — but the data is right there in __NEXT_DATA__ or a state
    blob. Walk it for the first object carrying both a name and a price.
    """
    blocks: List[str] = []
    m = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
                  text, re.S | re.I)
    if m:
        blocks.append(m.group(1))
    m = re.search(r"__(?:INITIAL_STATE|PRELOADED_STATE|NUXT)__\s*=\s*(\{.*?\})\s*[;<]",
                  text, re.S)
    if m:
        blocks.append(m.group(1))

    for raw in blocks:
        try:
            root = json.loads(raw)
        except (ValueError, TypeError):
            continue
        queue, seen = [root], 0
        while queue and seen < 5000:
            node = queue.pop(0)
            seen += 1
            if isinstance(node, list):
                queue.extend(node[:200])
                continue
            if not isinstance(node, dict):
                continue
            name = node.get("name") or node.get("productName") or node.get("title")
            price = (node.get("price") or node.get("sellingPrice")
                     or node.get("finalPrice") or node.get("mrp"))
            if isinstance(name, str) and len(name) > 3 and price is not None:
                return {"name": name, "price": price,
                        "brand": _first(node.get("brand")),
                        "description": node.get("description") or "",
                        "image": _first(node.get("image") or node.get("imageUrl"))}
            queue.extend(node.values())
    return None


def _microdata(text: str) -> Optional[dict]:
    def grab(prop: str) -> str:
        m = re.search(
            r'itemprop=["\']%s["\'][^>]*(?:content=["\']([^"\']*)["\']|>\s*([^<]{1,200}))'
            % re.escape(prop), text, re.I)
        return (m.group(1) or m.group(2) or "").strip() if m else ""

    name = grab("name")
    if not name:
        return None
    return {"name": name, "price": grab("price"), "brand": grab("brand"),
            "description": grab("description"), "image": grab("image")}


def _meta(text: str, prop: str) -> str:
    for pattern in (
            r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)',
            r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']%s["\']'):
        m = re.search(pattern % re.escape(prop), text, re.I)
        if m:
            return htmllib.unescape(m.group(1)).strip()
    return ""


def _keyword_fields(text: str) -> Dict[str, str]:
    """Retail titles are formulaic, so keyword extraction is reliable on them."""
    low = " " + re.sub(r"[^a-z0-9\- ]", " ", (text or "").lower()) + " "
    found: Dict[str, str] = {}

    for cat, words in CATEGORY_WORDS:
        # Longest first, so "t-shirt" wins over the "shirt" inside it.
        hits = [w for w in sorted(words, key=len, reverse=True) if w in low]
        if hits:
            found["category"] = cat
            found["subcategory"] = hits[0]
            break
    for c in sorted(COLOURS, key=len, reverse=True):
        if re.search(r"\b%s\b" % re.escape(c), low):
            found["colour"] = c
            break
    for m in MATERIALS:
        if m in low:
            found["material"] = m
            break
    for p in PATTERNS:
        if p in low:
            found["pattern"] = "checked" if p == "checkered" else p
            break
    for formality, words in FORMALITY_WORDS:
        if any(w in low for w in words):
            found["formality"] = formality
            break
    for season, words in SEASON_WORDS:
        if any(w in low for w in words):
            found["seasons"] = season
            break
    m = re.search(r"\bsize[:\s]+([a-z0-9]{1,4})\b", low)
    if m:
        found["size"] = m.group(1).upper()
    return found


def parse_product(text: str, url: str) -> Dict[str, Any]:
    """Build an item from a page body. Sources in order of how exact they are."""
    item: Dict[str, Any] = {"source_url": url}
    notes: List[str] = []

    products = _jsonld_products(text)
    if products:
        p = products[0]
        item["name"] = str(_first(p.get("name")))[:120]
        item["brand"] = str(_first(p.get("brand")))[:60]
        item["notes"] = str(_first(p.get("description")))[:400]
        item["image_url"] = str(_first(p.get("image")))
        offers = p.get("offers")
        offer = offers[0] if isinstance(offers, list) and offers else offers
        if isinstance(offer, dict):
            item["price"] = _number(offer.get("price"))
            item["currency"] = offer.get("priceCurrency") or "INR"
        notes.append("schema.org JSON-LD")
    else:
        emb = _embedded_product(text) or _microdata(text)
        if emb:
            item["name"] = str(emb.get("name") or "")[:120]
            item["brand"] = str(_first(emb.get("brand")))[:60]
            item["notes"] = str(emb.get("description") or "")[:400]
            item["image_url"] = str(_first(emb.get("image")))
            item["price"] = _number(emb.get("price"))
            notes.append("the page's own bootstrap data")

    if not item.get("name"):
        item["name"] = _meta(text, "og:title")
    if not item.get("name"):
        m = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
        item["name"] = htmllib.unescape(m.group(1)).strip() if m else ""
        if item["name"]:
            notes.append("the page title")
    if not item.get("image_url"):
        item["image_url"] = _meta(text, "og:image")
    if not item.get("notes"):
        item["notes"] = _meta(text, "description")[:400]
    if not item.get("brand"):
        item["brand"] = _meta(text, "og:site_name")

    item["name"] = (item.get("name") or "").strip()[:120]
    if not re.match(r"^https?://", item.get("image_url") or ""):
        item["image_url"] = ""

    basis = " ".join([item.get("name") or "", item.get("notes") or ""])
    for k, v in _keyword_fields(basis).items():
        if not item.get(k):
            item[k] = v

    if item.get("category") not in CATEGORIES:
        item["category"] = item.get("category") or ""
    if item.get("formality") not in FORMALITIES:
        item["formality"] = item.get("formality") or ""
    item.setdefault("seasons", "all-season")
    item.setdefault("currency", "INR")
    item["_read_from"] = ", ".join(notes) or "page metadata"
    return item


# ── fetching ─────────────────────────────────────────────────────────────────

def _looks_usable(item: Optional[dict]) -> bool:
    """A client-rendered shell parses to a title and nothing else."""
    if not item or not item.get("name"):
        return False
    return bool(item.get("price") or item.get("image_url")
                or item.get("category") or len(item.get("name", "")) > 12)


def _get_with_requests(url: str, *, session=None, proxies=None, verify=True,
                       timeout=20, retries=2) -> str:
    if requests is None:
        raise FetchError("The requests library is not installed: pip install requests")
    sess = session or requests.Session()
    last = None
    for attempt in range(retries + 1):
        try:
            r = sess.get(url, headers=HEADERS, proxies=proxies, verify=verify,
                         timeout=timeout, allow_redirects=True)
            if r.status_code in (403, 429, 503) and attempt < retries:
                # Backing off is worth more than retrying immediately: these
                # three are the shop telling us to slow down.
                time.sleep(1.5 * (attempt + 1) + random.random())
                last = "HTTP %d" % r.status_code
                continue
            r.raise_for_status()
            return r.text
        except Exception as exc:                               # noqa: BLE001
            last = str(exc)
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1) + random.random())
    raise FetchError("requests failed: %s" % last)


def _get_with_browser(url: str, timeout=30) -> str:
    """Render the page, for shops that build their product client-side."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pass
    else:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                page = browser.new_page(user_agent=HEADERS["User-Agent"])
                page.goto(url, timeout=timeout * 1000, wait_until="domcontentloaded")
                # The product usually arrives with a later XHR, so settle first.
                try:
                    page.wait_for_load_state("networkidle", timeout=8000)
                except Exception:                              # noqa: BLE001
                    pass
                return page.content()
            finally:
                browser.close()

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
    except ImportError:
        raise FetchError(
            "No headless browser available. Install one to read shops that render "
            "their pages with JavaScript:  pip install playwright && playwright "
            "install chromium")

    opts = Options()
    for flag in ("--headless=new", "--disable-gpu", "--no-sandbox",
                 "--window-size=1280,1600", "--user-agent=" + HEADERS["User-Agent"]):
        opts.add_argument(flag)
    driver = webdriver.Chrome(options=opts)
    try:
        driver.set_page_load_timeout(timeout)
        driver.get(url)
        time.sleep(2.5)                      # let the product XHR land
        return driver.page_source
    finally:
        driver.quit()


def fetch_product(url: str, *, session=None, proxies=None, verify=True,
                  timeout=20, retries=2, use_browser="auto") -> Dict[str, Any]:
    """Read one product page into an item dict.

    url         the product page
    session     an existing requests.Session, to reuse cookies and connections
    proxies     {"https": "http://user:pass@host:port"} if you route through one
    verify      False, or a path to a CA bundle, when a proxy re-signs TLS
    use_browser "auto" falls back to a headless browser when the plain fetch
                finds no product; "never" skips it; "always" goes straight there

    Returns the item, with "_read_from" and "_route" saying how it was read.
    Raises FetchError when no route produced a product.
    """
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url

    problems: List[str] = []
    item = None

    if use_browser != "always":
        try:
            body = _get_with_requests(url, session=session, proxies=proxies,
                                      verify=verify, timeout=timeout, retries=retries)
            item = parse_product(body, url)
            if _looks_usable(item):
                item["_route"] = "requests"
                return item
            problems.append("requests: page had no product data (likely rendered "
                            "client-side)")
        except FetchError as exc:
            problems.append(str(exc))

    if use_browser != "never":
        try:
            body = _get_with_browser(url, timeout=max(timeout, 30))
            rendered = parse_product(body, url)
            if _looks_usable(rendered):
                rendered["_route"] = "headless browser"
                return rendered
            problems.append("headless browser: still no product data")
            item = item or rendered
        except FetchError as exc:
            problems.append(str(exc))
        except Exception as exc:                               # noqa: BLE001
            problems.append("headless browser: %s" % exc)

    # A thin read is still better than nothing, as long as it has a name.
    if item and item.get("name"):
        item["_route"] = "partial"
        item["_problems"] = problems
        return item
    raise FetchError("; ".join(problems) or "nothing could read that page")


def fetch_products(urls: Iterable[str], *, workers=4, delay=(1.0, 3.0),
                   on_done=None, **kwargs) -> List[Dict[str, Any]]:
    """Read many pages, politely.

    A small pool with a random pause before each request. Both matter: enough
    parallelism to be quick, little enough — and irregular enough — not to look
    like a scraper worth blocking. One session per worker keeps cookies and
    connections alive, which also makes each request cheaper.

    Failures are returned as {"url": ..., "error": ...} rather than raised, so
    one dead link does not cost you the rest of the batch.
    """
    urls = [u for u in (u.strip() for u in urls) if u]
    results: List[Dict[str, Any]] = [None] * len(urls)         # type: ignore[list-item]
    local = __import__("threading").local()

    def work(index_url):
        index, url = index_url
        time.sleep(random.uniform(*delay))
        if requests is not None and not hasattr(local, "session"):
            local.session = requests.Session()
        try:
            out = fetch_product(url, session=getattr(local, "session", None), **kwargs)
        except Exception as exc:                               # noqa: BLE001
            out = {"url": url, "error": str(exc)}
        if on_done:
            on_done(url, out)
        return index, out

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for index, out in pool.map(work, list(enumerate(urls))):
            results[index] = out
    return results


# ── output ───────────────────────────────────────────────────────────────────

def to_import_file(items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """The shape Wardrobe → Data → Import reads.

    Everything beginning with "_" is working notes, not item data, so it is
    dropped here — but the file is plain JSON, so edit anything in it before
    importing.
    """
    out = []
    for n, item in enumerate(items, start=1):
        if not item or item.get("error"):
            continue
        row = {k: v for k, v in item.items() if not k.startswith("_")}
        row["id"] = n
        row["status"] = "available"
        row.setdefault("currency", "INR")
        row.setdefault("seasons", "all-season")
        row["notes"] = "\n\n".join(
            x for x in (row.get("notes"), "Bought from: " + row["source_url"]
                        if row.get("source_url") else "") if x)
        out.append(row)
    return {"schema": 1, "items": out, "wears": [], "outfits": [],
            "style_sources": [], "style_rules": []}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Read product pages into a wardrobe import file.")
    ap.add_argument("urls", nargs="*", help="product page URLs")
    ap.add_argument("--input", help="file of URLs, one per line")
    ap.add_argument("-o", "--out", help="write an import file here (default: stdout)")
    ap.add_argument("--workers", type=int, default=4, help="parallel requests (default 4)")
    ap.add_argument("--delay", default="1,3",
                    help="random pause before each request, seconds (default 1,3)")
    ap.add_argument("--proxy", help="e.g. http://user:pass@host:port")
    ap.add_argument("--cert", help="CA bundle, when a proxy re-signs TLS")
    ap.add_argument("--insecure", action="store_true", help="skip TLS verification")
    ap.add_argument("--browser", choices=["auto", "never", "always"], default="auto",
                    help="headless fallback (default auto)")
    args = ap.parse_args(argv)

    urls = list(args.urls)
    if args.input:
        with open(args.input, encoding="utf-8") as fh:
            urls += [l.strip() for l in fh if l.strip() and not l.startswith("#")]
    if not urls:
        ap.error("give at least one URL, or --input")

    lo, _, hi = args.delay.partition(",")
    delay = (float(lo), float(hi or lo))
    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None
    verify = False if args.insecure else (args.cert or True)

    def report(url, out):
        if out.get("error"):
            print("  failed  %s\n          %s" % (url, out["error"]), file=sys.stderr)
        else:
            print("  read    %-58s via %s" % (
                (out.get("name") or "?")[:58], out.get("_route")), file=sys.stderr)

    print("Reading %d page(s) with %d worker(s)…" % (len(urls), args.workers),
          file=sys.stderr)
    items = fetch_products(urls, workers=args.workers, delay=delay, on_done=report,
                           proxies=proxies, verify=verify, use_browser=args.browser)

    payload = to_import_file(items)
    failed = [i for i in items if i and i.get("error")]
    print("\n%d read, %d failed." % (len(payload["items"]), len(failed)), file=sys.stderr)

    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("Wrote %s — edit it if you like, then load it with "
              "Wardrobe → Data → Import." % args.out, file=sys.stderr)
    else:
        print(text)
    return 1 if failed and not payload["items"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
