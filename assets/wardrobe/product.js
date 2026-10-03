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

  // Tried in order. Each takes the target URL and must return its raw body.
  const PROXIES = [
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
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
      notes.push('No structured product data on that page; read its metadata instead.');
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

  // Try each proxy until one returns something that looks like a page.
  async function scrapeProduct(url, vocab, colourWords, onTry) {
    const tried = [];
    for (const build of PROXIES) {
      const via = build(url);
      const host = via.replace(/^https?:\/\//, '').split('/')[0];
      if (onTry) onTry(host);
      try {
        const res = await fetch(via, { headers: { Accept: 'text/html,*/*' } });
        if (!res.ok) { tried.push(host + ' (HTTP ' + res.status + ')'); continue; }
        const html = await res.text();
        if (!html || html.length < 200) { tried.push(host + ' (empty)'); continue; }

        const draft = parseProduct(html, url, vocab, colourWords);
        // A page that loads its content with JavaScript gives a shell with no
        // product in it. Without a name there is nothing worth confirming.
        if (!draft.name) { tried.push(host + ' (no product data)'); continue; }
        draft._notes.push('Fetched through ' + host + ', because a web page cannot ' +
                          'load another site directly.');
        return draft;
      } catch (e) {
        tried.push(host + ' (' + (e && e.message ? e.message : 'failed') + ')');
      }
    }
    const err = new Error('Could not read that page. Tried: ' + tried.join(', ') + '.');
    err.tried = tried;
    throw err;
  }

  return { scrapeProduct, parseProduct, keywordFields, jsonLdProducts, PROXIES };
})();
