'use strict';

/* Reading a retailer product page, in the browser.

   A port of lib/product.py: pull the page's schema.org JSON-LD Product block,
   fall back to its og: metadata, then infer the remaining fields from the title
   and description by keyword. That is a plain parse of data the retailer
   publishes — deterministic, free, and more faithful than asking a model to
   read the page.

   The one thing a browser cannot do is fetch the page: no retailer sends the
   CORS header that would allow it. So the request goes through a public read
   proxy. Only the URL you paste is sent there, never your wardrobe, and the
   list below is tried in order so one being down is not fatal.

   If every proxy fails, api.js falls back to Gemini's url_context tool, which
   fetches on Google's side. The scrape is tried first because it reads the
   real structured data rather than inferring from prose. */

const WProduct = (function () {

  // Tried in order, each returning the target's raw body. These fetch the
  // markup as served, which is what carries the structured data.
  const PROXIES = [
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  ];

  // Last resort for a shop that renders its product with JavaScript: a reader
  // that runs the page in a headless browser and returns the result as text.
  // No key, and no custom headers — those would force a CORS preflight that
  // the service need not answer.
  const READERS = [
    (u) => 'https://r.jina.ai/' + u,
  ];

  const CATEGORY_WORDS = [
    ['footwear', ['shoe', 'sneaker', 'trainer', 'loafer', 'sandal', 'boot', 'heel',
                  'flip flop', 'slipper', 'derby', 'oxford shoe', 'chappal', 'juti', 'mojari']],
    ['outerwear', ['jacket', 'coat', 'blazer', 'overcoat', 'puffer', 'parka',
                   'windcheater', 'cardigan', 'hoodie', 'sweatshirt', 'sweater',
                   'pullover', 'shrug']],
    ['bottom', ['jeans', 'trouser', 'pant', 'chino', 'short', 'skirt', 'cargo',
                'jogger', 'legging', 'palazzo', 'pyjama', 'track pant', 'dhoti',
                'churidar', 'salwar']],
    ['dress', ['dress', 'gown', 'jumpsuit', 'frock']],
    ['traditional', ['kurta', 'saree', 'sari', 'lehenga', 'sherwani', 'anarkali',
                     'kurti', 'ethnic', 'achkan', 'nehru jacket', 'dupatta']],
    ['bag', ['bag', 'backpack', 'rucksack', 'tote', 'clutch', 'sling', 'wallet',
             'handbag', 'duffel']],
    ['jewellery', ['ring', 'necklace', 'earring', 'bracelet', 'chain', 'pendant',
                   'bangle', 'watch', 'anklet']],
    ['activewear', ['sports bra', 'active', 'gym', 'training tee', 'running']],
    ['accessory', ['belt', 'cap', 'hat', 'scarf', 'stole', 'sunglass', 'tie',
                   'sock', 'glove', 'muffler']],
    ['top', ['shirt', 't-shirt', 'tshirt', 'tee', 'top', 'polo', 'blouse', 'vest',
             'camisole', 'crop']],
  ];

  const MATERIALS = ['cotton', 'linen', 'silk', 'wool', 'denim', 'leather', 'polyester',
    'rayon', 'viscose', 'nylon', 'satin', 'velvet', 'chiffon', 'georgette', 'khadi',
    'jute', 'cashmere', 'corduroy', 'fleece', 'mesh', 'suede', 'canvas', 'lycra',
    'spandex', 'modal', 'chambray', 'tweed'];

  const PATTERNS = ['solid', 'printed', 'striped', 'checked', 'checkered', 'plaid',
    'floral', 'polka', 'embroidered', 'graphic', 'colourblocked', 'colorblocked',
    'textured', 'ribbed', 'washed', 'distressed', 'self design', 'woven design'];

  const FORMALITY_WORDS = [
    ['formal', ['sherwani', 'gown', 'tuxedo', 'wedding', 'bridal', 'ceremonial']],
    ['business', ['formal', 'office', 'business', 'blazer', 'suit', 'derby']],
    ['loungewear', ['lounge', 'pyjama', 'night', 'track', 'gym', 'sports', 'running', 'active']],
    ['smart-casual', ['semi-formal', 'party', 'smart', 'chino', 'polo']],
  ];

  const SEASON_WORDS = [
    ['winter', ['wool', 'fleece', 'puffer', 'thermal', 'sweater', 'coat', 'cashmere',
                'corduroy', 'tweed']],
    ['summer', ['linen', 'cotton', 'shorts', 'sleeveless', 'chiffon', 'mesh']],
    ['monsoon', ['waterproof', 'rain', 'quick dry', 'windcheater']],
  ];

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Retail titles are formulaic, so keyword extraction is reliable on them.
  function keywordFields(text, colourWords) {
    const low = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\- ]/g, ' ') + ' ';
    const found = {};

    for (const [cat, words] of CATEGORY_WORDS) {
      // Longest first, so "t-shirt" wins over the "shirt" inside it.
      const hits = words.slice().sort((a, b) => b.length - a.length)
        .filter(w => low.indexOf(w) !== -1);
      if (hits.length) { found.category = cat; found.subcategory = hits[0]; break; }
    }
    for (const c of colourWords.slice().sort((a, b) => b.length - a.length)) {
      if (new RegExp('\\b' + esc(c) + '\\b').test(low)) { found.colour = c; break; }
    }
    for (const m of MATERIALS) if (low.indexOf(m) !== -1) { found.material = m; break; }
    for (const p of PATTERNS) {
      if (low.indexOf(p) !== -1) { found.pattern = p === 'checkered' ? 'checked' : p; break; }
    }
    for (const [f, words] of FORMALITY_WORDS) {
      if (words.some(w => low.indexOf(w) !== -1)) { found.formality = f; break; }
    }
    for (const [s, words] of SEASON_WORDS) {
      if (words.some(w => low.indexOf(w) !== -1)) { found.seasons = s; break; }
    }
    const m = low.match(/\bsize[:\s]+([a-z0-9]{1,4})\b/);
    if (m) found.size = m[1].toUpperCase();
    return found;
  }

  // Next.js and Nuxt sites — Myntra, Ajio and many others — ship the product as
  // JSON in a bootstrap script rather than as JSON-LD. Walk it for the first
  // object that looks like a product.
  function embeddedProduct(html) {
    const blocks = [];
    const next = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (next) blocks.push(next[1]);
    const state = html.match(/__(?:INITIAL_STATE|PRELOADED_STATE|NUXT)__\s*=\s*({[\s\S]*?})\s*[;<]/);
    if (state) blocks.push(state[1]);

    for (const raw of blocks) {
      let root;
      try { root = JSON.parse(raw); } catch (_) { continue; }
      const queue = [root];
      let seen = 0;
      while (queue.length && seen < 4000) {
        const node = queue.shift();
        seen++;
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { queue.push.apply(queue, node.slice(0, 200)); continue; }

        const name = node.name || node.productName || node.title;
        const priceish = node.price || node.sellingPrice || node.finalPrice || node.mrp;
        if (typeof name === 'string' && name.length > 3 && priceish !== undefined) {
          return { name: name, price: priceish,
                   brand: node.brand && (node.brand.name || node.brand) || '',
                   description: node.description || '',
                   image: node.image || node.imageUrl || '' };
        }
        for (const k of Object.keys(node)) queue.push(node[k]);
      }
    }
    return null;
  }

  // schema.org microdata, the older markup some shops still use.
  function microdata(html) {
    const grab = (prop) => {
      const re = new RegExp('itemprop=["\']' + prop +
        '["\'][^>]*(?:content=["\']([^"\']*)["\']|>\\s*([^<]{1,200}))', 'i');
      const m = html.match(re);
      return m ? String(m[1] || m[2] || '').trim() : '';
    };
    const name = grab('name');
    if (!name) return null;
    return { name: name, price: grab('price'), brand: grab('brand'),
             description: grab('description'), image: grab('image') };
  }

  // What a reader proxy returns is prose, not markup: no JSON-LD and no meta
  // tags. The title is still the first real line, and the keyword inference
  // works on text just as well as it did on a product title.
  function parseText(text, finalUrl, vocab, colourWords) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    let name = '';
    for (const l of lines) {
      const cleaned = l.replace(/^#+\s*/, '').replace(/^Title:\s*/i, '').trim();
      if (cleaned.length >= 6 && cleaned.length <= 140 && !/^https?:/i.test(cleaned)) {
        name = cleaned; break;
      }
    }
    if (!name) return null;

    const draft = { source_url: finalUrl, name: name.slice(0, 120) };
    const body = lines.join(' ').slice(0, 4000);

    // A currency marker makes this far safer than matching any number on the page.
    const pm = body.match(/(?:₹|Rs\.?|INR|\$|£|€)\s*([\d][\d,]*(?:\.\d{1,2})?)/i);
    if (pm) {
      const n = Number(pm[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0) draft.price = n;
    }
    // A reader returns images as ![alt](url). Take that first, since many CDN
    // urls carry no file extension for a bare pattern to recognise.
    const md = body.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
    const ext = body.match(/https?:\/\/[^\s)"']+\.(?:jpg|jpeg|png|webp)/i);
    if (md) draft.image_url = md[1];
    else if (ext) draft.image_url = ext[0];
    draft.notes = body.slice(0, 400);

    const guessed = keywordFields(name + ' ' + body.slice(0, 1200), colourWords);
    for (const k of Object.keys(guessed)) if (!draft[k]) draft[k] = guessed[k];

    if (vocab.categories.indexOf(draft.category) === -1) draft.category = draft.category || '';
    if (vocab.formalities.indexOf(draft.formality) === -1) draft.formality = draft.formality || '';
    if (!draft.seasons) draft.seasons = 'all-season';
    if (!draft.currency) draft.currency = 'INR';
    draft._notes = ['Read the rendered page as text.'];
    return draft;
  }

  function first(v) {
    if (Array.isArray(v)) return v.length ? first(v[0]) : '';
    if (v && typeof v === 'object') return v.name || v.url || '';
    return v || '';
  }

  // Every JSON-LD block on the page, flattened through @graph, keeping Products.
  function jsonLdProducts(doc) {
    const out = [];
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      let parsed;
      try { parsed = JSON.parse(n.textContent); } catch (_) { continue; }
      const queue = Array.isArray(parsed) ? parsed.slice() : [parsed];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) queue.push.apply(queue, node['@graph']);
        const t = node['@type'];
        const types = Array.isArray(t) ? t : [t];
        if (types.some(x => String(x).toLowerCase() === 'product')) out.push(node);
      }
    }
    return out;
  }

  const meta = (doc, prop) => {
    const el = doc.querySelector('meta[property="' + prop + '"], meta[name="' + prop + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  };

  function parseProduct(html, finalUrl, vocab, colourWords) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const draft = { source_url: finalUrl };
    const notes = [];

    const products = jsonLdProducts(doc);
    if (products.length) {
      const p = products[0];
      draft.name = String(first(p.name) || '').slice(0, 120);
      draft.brand = String(first(p.brand) || '').slice(0, 60);
      draft.notes = String(first(p.description) || '').slice(0, 400);
      draft.image_url = String(first(p.image) || '');
      let offer = p.offers;
      if (Array.isArray(offer)) offer = offer[0];
      if (offer && typeof offer === 'object') {
        const pm = String(offer.price === undefined ? '' : offer.price).match(/\d[\d,]*(?:\.\d+)?/);
        if (pm) draft.price = Number(pm[0].replace(/,/g, ''));
        draft.currency = offer.priceCurrency || 'INR';
      }
      notes.push('Read the structured product data the page publishes (schema.org JSON-LD).');
    } else {
      // No JSON-LD: try the bootstrap JSON these sites ship instead, then the
      // older microdata markup, before falling back to page metadata.
      const emb = embeddedProduct(html) || microdata(html);
      if (emb) {
        draft.name = String(emb.name || '').slice(0, 120);
        draft.brand = String(first(emb.brand) || '').slice(0, 60);
        draft.notes = String(emb.description || '').slice(0, 400);
        draft.image_url = String(first(emb.image) || '');
        const pm = String(emb.price === undefined ? '' : emb.price).match(/\d[\d,]*(?:\.\d+)?/);
        if (pm) draft.price = Number(pm[0].replace(/,/g, ''));
        notes.push('Read the product data the page embeds for its own scripts.');
      } else {
        notes.push('No structured product data on that page; read its metadata instead.');
      }
    }

    if (!draft.name) draft.name = meta(doc, 'og:title');
    if (!draft.name) draft.name = (doc.querySelector('title') || {}).textContent || '';
    if (!draft.image_url) draft.image_url = meta(doc, 'og:image');
    if (!draft.notes) draft.notes = meta(doc, 'description').slice(0, 400);
    if (!draft.brand) draft.brand = meta(doc, 'og:site_name');

    draft.name = String(draft.name || '').trim().slice(0, 120);
    if (!/^https?:\/\//i.test(draft.image_url || '')) draft.image_url = '';

    const guessed = keywordFields(
      [draft.name, draft.notes].filter(Boolean).join(' '), colourWords);
    for (const k of Object.keys(guessed)) if (!draft[k]) draft[k] = guessed[k];

    if (vocab.categories.indexOf(draft.category) === -1) draft.category = draft.category || '';
    if (vocab.formalities.indexOf(draft.formality) === -1) draft.formality = draft.formality || '';
    if (!draft.seasons) draft.seasons = 'all-season';
    if (!draft.currency) draft.currency = 'INR';

    draft._notes = notes;
    return draft;
  }

  // The <img> in the preview can point straight at the retailer's CDN, but an
  // item has to keep its own copy — the link would rot, and some CDNs refuse a
  // request that does not come from their own page. Pull the bytes through the
  // same proxies and hand back a data URL.
  async function fetchImage(url) {
    for (const build of PROXIES) {
      try {
        const res = await fetch(build(url));
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob || blob.size < 500) continue;
        if (blob.type && blob.type.indexOf('image') !== 0) continue;
        return await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('unreadable'));
          fr.readAsDataURL(blob);
        });
      } catch (_) { /* try the next one */ }
    }
    return '';
  }

  // Two passes. First the plain proxies, whose markup carries the structured
  // data and gives the most accurate read. Only if none of them yields a
  // product do we spend a slower request on a reader that renders the page.
  async function scrapeProduct(url, vocab, colourWords, onTry) {
    const tried = [];
    let lastText = '';

    const attempt = async (via, asText) => {
      const host = via.replace(/^https?:\/\//, '').split('/')[0];
      if (onTry) onTry(host);
      let body;
      try {
        const res = await fetch(via);
        if (!res.ok) { tried.push(host + ' (HTTP ' + res.status + ')'); return null; }
        body = await res.text();
      } catch (e) {
        tried.push(host + ' (' + (e && e.message ? e.message : 'blocked') + ')');
        return null;
      }
      if (!body || body.length < 200) { tried.push(host + ' (empty)'); return null; }

      const draft = asText
        ? parseText(body, url, vocab, colourWords)
        : parseProduct(body, url, vocab, colourWords);

      // A shop that renders client-side returns a shell with no product in it.
      // Without a name there is nothing worth asking the user to confirm.
      if (!draft || !draft.name) {
        lastText = lastText || body;
        tried.push(host + ' (no product data)');
        return null;
      }
      draft._notes.push('Fetched through ' + host + ', because a web page cannot ' +
                        'load another site directly.');
      draft._body = body;
      return draft;
    };

    for (const build of PROXIES) {
      const got = await attempt(build(url), false);
      if (got) return got;
    }
    for (const build of READERS) {
      const got = await attempt(build(url), true);
      if (got) return got;
    }

    const err = new Error('Could not read that page. Tried: ' + tried.join(', ') + '.');
    err.tried = tried;
    // Whatever text we did retrieve is still worth handing to the model, which
    // saves it fetching the page a second time.
    err.body = lastText;
    throw err;
  }

  return { scrapeProduct, fetchImage, parseProduct, parseText, keywordFields, jsonLdProducts,
           embeddedProduct, microdata, PROXIES, READERS };
})();
