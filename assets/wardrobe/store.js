'use strict';

/* Wardrobe store — the browser-side replacement for lib/store.py and
   lib/colour.py from the original app.

   Records are shaped exactly as the Python version returned them (snake_case,
   the same derived fields), because assets/wardrobe/app.js is that app's own
   UI, unmodified. Keeping the shapes identical is what lets it run untouched.

   Photos live in IndexedDB as data URLs rather than on disk. Garment cutout and
   product rendering are not here — those need rembg, PIL and numpy, so they
   stay in the local Python app. */

const WStore = (function () {

  const KEY = 'tm_wardrobe';            // shared with the rest of Task Matrix
  const CATEGORIES = ['top', 'bottom', 'dress', 'outerwear', 'footwear',
                      'accessory', 'jewellery', 'bag', 'activewear', 'traditional'];
  const STATUSES = ['available', 'laundry', 'lent', 'repair', 'stored'];
  const FORMALITIES = ['loungewear', 'casual', 'smart-casual', 'business', 'formal'];
  const SEASONS = ['summer', 'monsoon', 'winter', 'all-season'];

  // ── colour theory (lib/colour.py) ──────────────────────────────────────────
  const HUES = {
    red: 0, maroon: 0, burgundy: 0, crimson: 0, wine: 0,
    rust: 1, orange: 1, peach: 1, coral: 1, terracotta: 1,
    yellow: 2, mustard: 2, amber: 2, lemon: 2,
    lime: 3, chartreuse: 3,
    green: 4, emerald: 4, sage: 4, mint: 4, forest: 4,
    teal: 5, turquoise: 5, aqua: 5,
    cyan: 6, sky: 6, powder: 6,
    blue: 7, cobalt: 7, azure: 7, royal: 7,
    indigo: 8, denim: 8,
    purple: 9, violet: 9, lavender: 9, lilac: 9, plum: 9,
    magenta: 10, fuchsia: 10, mauve: 10, orchid: 10,
    pink: 11, rose: 11, blush: 11, salmon: 11, 'dusty-rose': 11,
  };
  const NEUTRALS = new Set(['black', 'white', 'off-white', 'ivory', 'cream', 'grey',
    'gray', 'charcoal', 'silver', 'beige', 'tan', 'khaki', 'camel', 'taupe', 'stone',
    'sand', 'brown', 'chocolate', 'navy', 'olive', 'nude', 'gold', 'bronze']);
  const DARK_NEUTRALS = new Set(['black', 'charcoal', 'navy', 'chocolate', 'brown']);
  const OCCASIONS = {
    loungewear: ['at home', 'gym', 'quick errands', 'travel day'],
    casual: ['coffee run', 'campus', 'weekend brunch', 'movie night', 'meeting friends', 'shopping'],
    'smart-casual': ['dinner out', 'date night', 'family function', 'relaxed office',
                     'house party', 'day trip'],
    business: ['office', 'client meeting', 'presentation', 'interview', 'conference'],
    formal: ['wedding', 'reception', 'ceremony', 'gala', 'award night'],
  };
  const CAPSULE_TARGET = { top: 8, bottom: 5, outerwear: 2, footwear: 3,
                           dress: 2, accessory: 3, bag: 2 };
  const OPTIONAL = new Set(['dress', 'traditional', 'jewellery', 'activewear']);

  function normalise(colour) {
    if (!colour) return '';
    const words = String(colour).toLowerCase().replace(/[^a-z\- ]/g, ' ')
      .split(/[\s\-]+/).filter(Boolean);
    for (const w of words) if (HUES[w] !== undefined || NEUTRALS.has(w)) return w;
    for (const w of words) {
      for (const known of Object.keys(HUES).concat([...NEUTRALS])) {
        if (w.indexOf(known) !== -1) return known;
      }
    }
    return words[0] || '';
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function harmony(a0, b0) {
    const a = normalise(a0), b = normalise(b0);
    if (!a || !b) return ['unknown', 50, 'Colour not recorded for one of these pieces.'];
    const an = NEUTRALS.has(a), bn = NEUTRALS.has(b);

    if (an && bn) {
      if (a === b) return ['tonal', 72, 'Same neutral top and bottom: a clean tonal ' +
        'look, but add texture or an accessory so it does not read flat.'];
      if (DARK_NEUTRALS.has(a) && DARK_NEUTRALS.has(b)) {
        return ['neutral', 78, 'Two dark neutrals (' + a + ' and ' + b +
                '): sharp and easy, especially after dark.'];
      }
      return ['neutral', 87, cap(a) + ' and ' + b + ' are both neutrals, so they always ' +
              'agree. Safe, though an outfit of only neutrals can be a little anonymous.'];
    }
    // One colour anchored by a neutral is the most wearable interesting outfit
    // there is — ranked above head-to-toe neutral, or a wardrobe full of black
    // buries everything with colour in it.
    if (an || bn) {
      const n = an ? a : b, c = an ? b : a;
      return ['anchored', 91, cap(n) + ' is a neutral, so it anchors the ' + c +
              ' without competing. Let the ' + c + ' be the focal point.'];
    }
    const ha = HUES[a], hb = HUES[b];
    if (ha === undefined || hb === undefined) {
      return ['unknown', 50, 'One of these colours is not in the colour map.'];
    }
    const dist = Math.min((ha - hb + 12) % 12, (hb - ha + 12) % 12);
    if (dist === 0) return ['monochrome', 80, 'Both sit in the ' + a + ' family: a ' +
      'monochrome pairing. Vary the shade or texture to keep it interesting.'];
    if (dist <= 2) return ['analogous', 84, cap(a) + ' and ' + b + ' are neighbours on ' +
      'the colour wheel, so they blend harmoniously without clashing.'];
    if (dist >= 5) return ['complementary', 82, cap(a) + ' and ' + b + ' sit opposite ' +
      'each other: high contrast and deliberately striking. Keep the rest quiet.'];
    return ['clash', 38, cap(a) + ' and ' + b + ' are too far apart to blend but too ' +
      'close to read as intentional contrast. Usually worth avoiding.'];
  }

  function occasionsFor(formality, colours) {
    const base = (OCCASIONS[formality] || OCCASIONS.casual).slice();
    const toks = new Set(colours.filter(Boolean).map(normalise));
    if (toks.has('white') || toks.has('cream') || toks.has('ivory')) base.push('daytime events');
    if (toks.has('black') || toks.has('navy') || toks.has('charcoal')) base.push('evening events');
    return base.slice(0, 6);
  }

  // ── persistence ────────────────────────────────────────────────────────────
  let data = { items: [], wears: [], outfits: [], rules: [], sources: [], seq: 1 };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && Array.isArray(raw.items)) {
      data = Object.assign(data, raw);
      data.outfits = raw.outfits || []; data.rules = raw.rules || [];
      data.sources = raw.sources || []; data.seq = raw.seq || 1;
    }
  } catch (_) { /* a corrupt blob must not take the page down */ }

  const photos = new Map();   // item id -> data URL, hydrated from IndexedDB

  function save() {
    localStorage.setItem(KEY, JSON.stringify(data));
    scheduleSync();
  }

  // Ids have to be unique across devices, not just within one. A counter from
  // 1 gives both your laptop and your phone an item 1, and merging them would
  // silently fold two garments into one — and misdirect the wear records
  // pointing at them. Time plus a per-tick counter collides only if two
  // devices create a record in the same millisecond at the same point in that
  // millisecond's sequence. Well inside Number's safe integer range.
  let tick = 0;
  function nextId() {
    tick = (tick + 1) % 1000;
    const id = Date.now() * 1000 + tick;
    data.seq = Math.max(data.seq || 1, id + 1);
    return id;
  }
  const today = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  };
  const live = (list) => (list || []).filter(r => !r.deleted);

  // ── photos in IndexedDB ────────────────────────────────────────────────────
  // localStorage would blow its quota after a handful of images.
  let db = null;
  function openDb() {
    return new Promise((resolve) => {
      if (db) return resolve(db);
      let req;
      try { req = indexedDB.open('wardrobe-photos', 1); }
      catch (_) { return resolve(null); }
      req.onupgradeneeded = () => req.result.createObjectStore('photos');
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => resolve(null);           // private mode, blocked storage
    });
  }

  async function loadPhotos() {
    const d = await openDb();
    if (!d) return;
    await new Promise((resolve) => {
      const tx = d.transaction('photos', 'readonly').objectStore('photos').openCursor();
      tx.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return resolve();
        photos.set(String(cur.key), cur.value);
        cur.continue();
      };
      tx.onerror = () => resolve();
    });
  }

  async function putPhoto(key, dataUrl) {
    photos.set(String(key), dataUrl);
    const d = await openDb();
    if (!d) return;
    await new Promise((resolve) => {
      const tx = d.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(dataUrl, String(key));
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  }

  async function dropPhoto(key) {
    photos.delete(String(key));
    const d = await openDb();
    if (!d) return;
    await new Promise((resolve) => {
      const tx = d.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(String(key));
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  }

  // ── Drive sync ─────────────────────────────────────────────────────────────
  // The same hidden appData folder the task list uses, in a file of its own.
  // Records merge by id with the newest write winning, and deletions are
  // tombstones rather than removals, so a delete on one device reaches the
  // others instead of the record reappearing from their copy.
  const SYNC_FILE = 'wardrobe.json';
  const COLLECTIONS = ['items', 'wears', 'outfits', 'rules', 'sources'];
  let syncTimer = null;
  let syncing = false;

  const stamp = (r) => Date.parse(r && r.updated_at || 0) || 0;

  function mergeList(mine, theirs) {
    const by = new Map();
    for (const rec of (mine || []).concat(theirs || [])) {
      if (!rec || rec.id === undefined || rec.id === null) continue;
      const prev = by.get(rec.id);
      if (!prev || stamp(rec) >= stamp(prev)) by.set(rec.id, rec);
    }
    return Array.from(by.values());
  }

  function mergeRemote(remote) {
    if (!remote || typeof remote !== 'object') return false;
    let changed = false;
    for (const name of COLLECTIONS) {
      const before = JSON.stringify(data[name] || []);
      data[name] = mergeList(data[name], remote[name]);
      if (JSON.stringify(data[name]) !== before) changed = true;
    }
    // Keep the counter ahead of anything that arrived, so a device that was
    // offline does not start handing out ids another one already used.
    for (const name of COLLECTIONS) {
      for (const rec of data[name]) {
        if (typeof rec.id === 'number') data.seq = Math.max(data.seq || 1, rec.id + 1);
      }
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify(data));
    return changed;
  }

  async function pull() {
    if (typeof WDrive === 'undefined' || !WDrive.connected()) return false;
    const remote = await WDrive.read(SYNC_FILE);
    return mergeRemote(remote);
  }

  async function push() {
    if (typeof WDrive === 'undefined' || !WDrive.connected()) return;
    await WDrive.write(SYNC_FILE, {
      schema: 1, updated_at: new Date().toISOString(),
      items: data.items, wears: data.wears, outfits: data.outfits,
      rules: data.rules, sources: data.sources,
    });
  }

  // Pull before pushing, or a device that has been away overwrites whatever
  // the others did while it was gone.
  async function syncNow() {
    if (syncing) return false;
    if (typeof WDrive === 'undefined' || !WDrive.connected()) return false;
    syncing = true;
    try {
      const changed = await pull();
      await push();
      return changed;
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncNow().catch(() => { /* a failed sync must not break the page */ });
    }, 1500);
  }

  // ── items ──────────────────────────────────────────────────────────────────
  function resolvePhoto(handle) {
    if (!handle) return '';
    if (handle.indexOf('idb:') !== 0) return handle;     // already a data URL
    return photos.get(handle.slice(4)) || '';
  }

  function wearsOf(id) {
    return live(data.wears).filter(w => w.item_id === id)
      .map(w => w.worn_on).sort().reverse();
  }

  // Matches store._row_to_item: the derived fields the UI reads.
  function decorate(it) {
    const wears = wearsOf(it.id);
    const price = (it.price === null || it.price === undefined || it.price === '')
      ? null : Number(it.price);
    const out = Object.assign({}, it, {
      seasons: Array.isArray(it.seasons) ? it.seasons
             : String(it.seasons || '').split(',').filter(Boolean),
      price: (price !== null && isFinite(price)) ? price : null,
      wear_count: wears.length,
      last_worn: wears[0] || null,
      // Stored as an "idb:<key>" handle so localStorage keeps holding only
      // small records; the image itself comes from IndexedDB.
      photo_path: resolvePhoto(it.photo_path),
    });
    out.cost_per_wear = (out.price && wears.length)
      ? Math.round((out.price / wears.length) * 100) / 100 : null;
    out.days_since_worn = wears.length
      ? Math.round((Date.parse(today()) - Date.parse(wears[0])) / 86400000) : null;
    return out;
  }

  function listItems(q) {
    q = q || {};
    let out = live(data.items);
    if (!q.include_retired) out = out.filter(i => !i.retired);
    if (q.category) out = out.filter(i => i.category === q.category);
    if (q.status) out = out.filter(i => i.status === q.status);
    if (q.formality) out = out.filter(i => i.formality === q.formality);
    out = out.map(decorate);
    if (q.season) {
      out = out.filter(i => i.seasons.indexOf(q.season) !== -1 ||
                            i.seasons.indexOf('all-season') !== -1);
    }
    if (q.search) {
      const s = String(q.search).toLowerCase();
      out = out.filter(i => [i.name, i.brand, i.colour, i.subcategory, i.notes]
        .some(v => (v || '').toLowerCase().indexOf(s) !== -1));
    }
    return out.sort((a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  function getItem(id) {
    const it = live(data.items).find(i => i.id === Number(id));
    return it ? decorate(it) : null;
  }

  // Mirrors store._sanitise: unknown values fall back rather than being stored.
  function sanitise(body, creating) {
    const pick = (k, allowed, dflt) => {
      const v = (body[k] || '').toString().trim();
      return allowed.indexOf(v) !== -1 ? v : dflt;
    };
    const rec = {};
    if (creating || 'name' in body) rec.name = String(body.name || '').trim() || 'Untitled';
    if (creating || 'category' in body) rec.category = pick('category', CATEGORIES, 'top');
    if (creating || 'status' in body) rec.status = pick('status', STATUSES, 'available');
    if (creating || 'formality' in body) rec.formality = pick('formality', FORMALITIES, 'casual');
    for (const k of ['subcategory', 'brand', 'size', 'colour', 'pattern', 'material',
                     'care', 'status_note', 'notes', 'currency', 'purchase_date',
                     'source', 'photo_path']) {
      if (creating || k in body) rec[k] = String(body[k] === undefined ? '' : body[k]).trim();
    }
    if (creating || 'price' in body) {
      const n = Number(body.price);
      rec.price = (body.price === '' || body.price === null || !isFinite(n)) ? null : n;
    }
    if (creating || 'retired' in body) rec.retired = body.retired ? 1 : 0;
    if (creating || 'seasons' in body) {
      let s = body.seasons;
      if (typeof s === 'string') s = s.split(',');
      s = (s || []).map(x => String(x).trim()).filter(x => SEASONS.indexOf(x) !== -1);
      rec.seasons = s.length ? s : ['all-season'];
    }
    if (creating) {
      if (!rec.currency) rec.currency = 'INR';
      if (!rec.source) rec.source = 'manual';
    }
    return rec;
  }

  function createItem(body) {
    const rec = Object.assign({ id: nextId(), created_at: new Date().toISOString() },
                              sanitise(body, true));
    rec.updated_at = rec.created_at;
    data.items.push(rec);
    save();
    return decorate(rec);
  }

  function updateItem(id, body) {
    const it = live(data.items).find(i => i.id === Number(id));
    if (!it) throw new Error('not found');
    Object.assign(it, sanitise(body, false));
    it.updated_at = new Date().toISOString();
    save();
    return decorate(it);
  }

  function deleteItem(id) {
    const it = live(data.items).find(i => i.id === Number(id));
    if (!it) return { ok: true };
    // Tombstoned rather than dropped, so the delete reaches other devices.
    it.deleted = true;
    it.updated_at = new Date().toISOString();
    if (it.photo_path && it.photo_path.indexOf('idb:') === 0) {
      dropPhoto(it.photo_path.slice(4));
    }
    save();
    return { ok: true };
  }

  // ── wears ──────────────────────────────────────────────────────────────────
  function logWear(itemId, wornOn, source, note) {
    const id = Number(itemId), on = wornOn || today();
    const dup = live(data.wears).some(w => w.item_id === id && w.worn_on === on);
    if (dup) return { ok: true, duplicate: true };
    data.wears.push({ id: nextId(), item_id: id, worn_on: on,
                      source: source || 'manual', note: note || '',
                      updated_at: new Date().toISOString() });
    save();
    return { ok: true };
  }

  function unlogWear(itemId, wornOn) {
    const w = live(data.wears).find(x => x.item_id === Number(itemId) && x.worn_on === wornOn);
    if (w) { w.deleted = true; w.updated_at = new Date().toISOString(); save(); }
    return { ok: true };
  }

  function wearHistory(itemId) {
    return live(data.wears).filter(w => w.item_id === Number(itemId))
      .sort((a, b) => b.worn_on.localeCompare(a.worn_on))
      .map(w => ({ worn_on: w.worn_on, source: w.source || 'manual', note: w.note || '' }));
  }

  // ── insights ───────────────────────────────────────────────────────────────
  const r2 = (n) => Math.round(n * 100) / 100;

  function stats() {
    const items = listItems();
    const cpw = items.filter(i => i.cost_per_wear !== null);
    const never = items.filter(i => i.wear_count === 0);
    const byCat = {}, byStatus = {};
    for (const i of items) {
      byCat[i.category] = (byCat[i.category] || 0) + 1;
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    }
    return {
      item_count: items.length,
      total_spend: r2(items.reduce((s, i) => s + (i.price || 0), 0)),
      worn_count: items.filter(i => i.wear_count > 0).length,
      never_worn_count: never.length,
      // Money sunk into things never worn — the figure a photo gallery cannot give.
      never_worn_value: r2(never.reduce((s, i) => s + (i.price || 0), 0)),
      not_worn_in_a_year: items.filter(i => i.days_since_worn !== null && i.days_since_worn > 365).length,
      total_wears: items.reduce((s, i) => s + i.wear_count, 0),
      avg_cost_per_wear: cpw.length
        ? r2(cpw.reduce((s, i) => s + i.cost_per_wear, 0) / cpw.length) : null,
      best_value: cpw.slice().sort((a, b) => a.cost_per_wear - b.cost_per_wear).slice(0, 5),
      worst_value: cpw.slice().sort((a, b) => b.cost_per_wear - a.cost_per_wear).slice(0, 5),
      by_category: byCat,
      by_status: byStatus,
    };
  }

  function gaps(season) {
    let items = listItems().filter(i => i.status !== 'stored');
    if (season) {
      items = items.filter(i => i.seasons.indexOf(season) !== -1 ||
                                i.seasons.indexOf('all-season') !== -1);
    }
    const counts = {};
    for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
    const out = [];
    for (const cat of Object.keys(CAPSULE_TARGET)) {
      const target = CAPSULE_TARGET[cat], have = counts[cat] || 0;
      if (have === 0 && OPTIONAL.has(cat)) continue;
      if (have < target) {
        out.push({ kind: 'gap', category: cat, have: have, target: target,
          message: 'Only ' + have + ' ' + cat + ' item(s); a workable wardrobe wants about ' + target + '.' });
      } else if (have > target * 2.5) {
        out.push({ kind: 'excess', category: cat, have: have, target: target,
          message: have + ' ' + cat + ' items is well past the ~' + target + ' you need — likely overbuying.' });
      }
    }
    for (const f of ['business', 'formal']) {
      const tops = items.filter(i => i.formality === f && (i.category === 'top' || i.category === 'dress'));
      const bots = items.filter(i => i.formality === f && (i.category === 'bottom' || i.category === 'dress'));
      if (!tops.length || !bots.length) {
        out.push({ kind: 'gap', category: f, have: tops.length + bots.length, target: 2,
          message: 'You cannot assemble a complete ' + f + ' outfit from available items.' });
      }
    }
    const byCatColour = {};
    for (const i of items) {
      if (!i.colour) continue;
      const c = i.colour.trim().toLowerCase();
      (byCatColour[i.category] = byCatColour[i.category] || {});
      byCatColour[i.category][c] = (byCatColour[i.category][c] || 0) + 1;
    }
    for (const cat of Object.keys(byCatColour)) {
      const cs = byCatColour[cat];
      const total = Object.values(cs).reduce((a, b) => a + b, 0);
      if (total < 5) continue;
      const top = Object.keys(cs).sort((a, b) => cs[b] - cs[a])[0];
      if (cs[top] / total >= 0.6) {
        out.push({ kind: 'monotony', category: cat, have: cs[top], target: total,
          message: cs[top] + ' of ' + total + ' ' + cat + ' items are ' + top + ' — little variety.' });
      }
    }
    return out;
  }

  // Grouped by category + colour: "four black tops" is the insight that changes
  // a purchase decision; demanding an exact subcategory match never fires.
  function duplicates(threshold) {
    threshold = threshold || 3;
    const groups = {};
    for (const i of listItems()) {
      const colour = (i.colour || '').trim().toLowerCase();
      if (!colour) continue;
      (groups[i.category + '\u0000' + colour] = groups[i.category + '\u0000' + colour] || []).push(i);
    }
    const out = [];
    for (const k of Object.keys(groups)) {
      const m = groups[k];
      if (m.length < threshold) continue;
      const parts = k.split('\u0000');
      const subs = [...new Set(m.map(x => (x.subcategory || '').trim().toLowerCase())
        .filter(Boolean))].sort();
      out.push({ category: parts[0], colour: parts[1], subcategory: subs.join(', '),
                 count: m.length, spend: r2(m.reduce((s, x) => s + (x.price || 0), 0)),
                 items: m });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // ── planning ───────────────────────────────────────────────────────────────
  function seasonForTemp(t) {
    if (t === null || t === undefined || t === '') return 'all-season';
    const n = Number(t);
    if (!isFinite(n)) return 'all-season';
    if (n >= 28) return 'summer';
    if (n <= 16) return 'winter';
    return 'monsoon';
  }

  function packing(days, tempC, rain) {
    days = Math.max(1, Math.min(parseInt(days, 10) || 1, 60));
    const season = seasonForTemp(tempC);
    const pool = listItems().filter(i =>
      (i.status === 'available' || i.status === 'laundry') &&
      (i.seasons.indexOf(season) !== -1 || i.seasons.indexOf('all-season') !== -1));

    const need = { top: Math.min(days, 7),
                   bottom: Math.max(1, Math.min(Math.round(days / 2.5), 4)),
                   footwear: 1, bag: 1 };
    const t = Number(tempC);
    const hasTemp = tempC !== '' && tempC !== null && tempC !== undefined && isFinite(t);
    if (hasTemp && t <= 18) need.outerwear = 1;
    if (rain) need.outerwear = Math.max(need.outerwear || 0, 1);

    const chosen = [], missing = [];
    for (const cat of Object.keys(need)) {
      const n = need[cat];
      const cands = pool.filter(i => i.category === cat)
        .sort((a, b) => a.wear_count - b.wear_count || a.name.localeCompare(b.name));
      chosen.push.apply(chosen, cands.slice(0, n));
      if (cands.length < n) missing.push({ category: cat, have: cands.length, need: n });
    }
    const wash = chosen.filter(i => i.status === 'laundry');
    return { days: days, season: season, items: chosen, missing: missing,
             wash_first: wash,
             note: chosen.length + ' pieces for ' + days + ' day(s). ' +
                   wash.length + ' need washing before you pack.' };
  }

  // Lower is better. Formality match dominates: a business trouser must never
  // win a casual slot just by being under-worn. Within a band we rotate.
  function suggest(tempC, rain, formality) {
    const season = seasonForTemp(tempC);
    const pool = listItems().filter(i => i.status === 'available' &&
      (i.seasons.indexOf(season) !== -1 || i.seasons.indexOf('all-season') !== -1));
    const want = Math.max(0, FORMALITIES.indexOf(formality || 'casual'));
    const score = (i) => {
      const fi = FORMALITIES.indexOf(i.formality);
      let s = (fi >= 0 ? Math.abs(fi - want) : 2) * 1000;
      if (i.days_since_worn === null) s -= 60;
      else if (i.days_since_worn < 7) s += 400;
      else s -= Math.min(i.days_since_worn, 180) / 2;
      return s + Math.min(i.wear_count, 60) / 2;
    };
    const pick = (cats, n) => pool.filter(i => cats.indexOf(i.category) !== -1)
      .sort((a, b) => score(a) - score(b)).slice(0, n || 1);

    const chosen = [], notes = [];
    const dress = pick(['dress']), tops = pick(['top']), bottoms = pick(['bottom']);
    if (dress.length && !(tops.length && bottoms.length)) chosen.push.apply(chosen, dress);
    else chosen.push.apply(chosen, tops.concat(bottoms));
    chosen.push.apply(chosen, pick(['footwear']));

    const t = Number(tempC);
    const hasTemp = tempC !== '' && tempC !== null && tempC !== undefined && isFinite(t);
    if (hasTemp && t <= 18) {
      chosen.push.apply(chosen, pick(['outerwear']));
      notes.push(t + ' C — added a layer.');
    }
    if (rain) notes.push('Rain expected: avoid suede/canvas footwear and light colours.');
    if (hasTemp && t >= 32) notes.push(t + ' C — favour cotton/linen and loose fits.');
    chosen.push.apply(chosen, pick(['bag']));
    if (!chosen.length) notes.push('Nothing available matched. Check laundry status or add items.');
    return { season: season, formality: formality || 'casual', items: chosen, notes: notes };
  }

  function bestExtra(pool, colours, targetFormality) {
    if (!pool.length) return null;
    const want = FORMALITIES.indexOf(targetFormality);
    const sc = (x) => {
      const vals = colours.filter(Boolean).map(c => harmony(x.colour, c)[1]);
      let base = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
      // Weighted heavily, or gym trainers win a business combo on colour alone.
      if (want >= 0 && FORMALITIES.indexOf(x.formality) >= 0) {
        base -= Math.abs(FORMALITIES.indexOf(x.formality) - want) * 30;
      }
      return base + (x.days_since_worn === null ? 4 : Math.min(x.days_since_worn, 60) / 20);
    };
    return pool.slice().sort((a, b) => sc(b) - sc(a))[0];
  }

  function activeRules() {
    const liveSrc = new Set(live(data.sources).filter(s => s.active !== 0 && s.active !== false)
      .map(s => s.id));
    return live(data.rules).filter(r => (r.active !== 0 && r.active !== false) &&
      (!r.source_id || liveSrc.has(r.source_id)));
  }

  function combos(tempC, formality, limit) {
    limit = limit || 8;
    let season = (tempC === null || tempC === undefined || tempC === '')
      ? null : seasonForTemp(tempC);
    if (season === 'all-season') season = null;

    let avail = listItems().filter(i => i.status === 'available');
    if (season) {
      avail = avail.filter(i => i.seasons.indexOf(season) !== -1 ||
                                i.seasons.indexOf('all-season') !== -1);
    }
    if (formality) {
      const want = Math.max(0, FORMALITIES.indexOf(formality));
      avail = avail.filter(i => FORMALITIES.indexOf(i.formality) < 0 ||
                                Math.abs(FORMALITIES.indexOf(i.formality) - want) <= 1);
    }

    const tops = avail.filter(i => i.category === 'top' || i.category === 'traditional');
    const bottoms = avail.filter(i => i.category === 'bottom');
    const dresses = avail.filter(i => i.category === 'dress');
    const shoes = avail.filter(i => i.category === 'footwear');
    const outers = avail.filter(i => i.category === 'outerwear');
    const extras = avail.filter(i => ['accessory', 'jewellery', 'bag'].indexOf(i.category) !== -1);

    const pairRules = activeRules()
      .map(r => ({ a: normalise(r.colour_a), b: normalise(r.colour_b), r: r }))
      .filter(p => p.a && p.b);

    const ruleAdjust = (colours, reasons) => {
      let delta = 0;
      const toks = colours.filter(Boolean).map(normalise);
      for (const p of pairRules) {
        if (toks.indexOf(p.a) === -1 || toks.indexOf(p.b) === -1) continue;
        const good = (p.r.verdict || 'good') === 'good';
        delta += (good ? 14 : -26) * (Number(p.r.weight) || 1);
        reasons.push((good ? 'Your saved style note: ' : 'Your saved style note warns: ') +
                     (p.r.text || (p.a + ' with ' + p.b)));
      }
      return delta;
    };

    const pairs = [];
    for (const t of tops) for (const b of bottoms) pairs.push([t, b]);
    for (const d of dresses) pairs.push([d, null]);

    const out = [];
    for (const pr of pairs) {
      const top = pr[0], bottom = pr[1];
      const core = bottom ? [top, bottom] : [top];
      const colours = core.map(x => x.colour);
      let label, score, why;
      if (bottom) { const h = harmony(top.colour, bottom.colour); label = h[0]; score = h[1]; why = h[2]; }
      else { label = 'single piece'; score = 80; why = 'A one-piece outfit, so there is no colour clash to manage.'; }
      const reasons = [why];

      const idx = core.map(i => FORMALITIES.indexOf(i.formality)).filter(n => n >= 0);
      if (idx.length && (Math.max.apply(null, idx) - Math.min.apply(null, idx)) >= 2) {
        score -= 22;
        reasons.push('These pieces sit far apart in formality, which reads inconsistent.');
      }
      for (const x of core) {
        if (x.days_since_worn === null) score += 5;
        else if (x.days_since_worn < 3) score -= 18;
        else score += Math.min(x.days_since_worn, 90) / 30;
      }
      const formalityOf = core.map(x => x.formality).filter(f => FORMALITIES.indexOf(f) >= 0)
        .sort((a, b) => FORMALITIES.indexOf(b) - FORMALITIES.indexOf(a))[0] || 'casual';

      const shoe = bestExtra(shoes, colours, formalityOf);
      const extra = bestExtra(extras, colours, formalityOf);
      const chosen = core.concat([shoe, extra].filter(Boolean));
      if (shoe) {
        const h = harmony(shoe.colour, (bottom || top).colour);
        score += (h[1] - 60) / 8;
        reasons.push('Footwear: ' + h[2]);
      }
      score += ruleAdjust(chosen.map(x => x.colour), reasons);

      const layer = bestExtra(outers, colours, formalityOf);
      out.push({ items: chosen, harmony: label,
        score: Math.round(Math.max(0, Math.min(100, score))), why: reasons,
        occasions: occasionsFor(formalityOf, chosen.map(x => x.colour)),
        formality: formalityOf,
        layer_hint: layer ? { id: layer.id, name: layer.name,
          note: 'If it turns cold, ' + layer.name + ' layers over this cleanly.' } : null });
    }

    out.sort((a, b) => b.score - a.score);
    // Keep the list varied: no single garment should dominate the page.
    const seen = {}, anchors = {}, res = [];
    for (const c of out) {
      const key = c.items.slice(0, 2).map(i => i.id).sort().join('-');
      const anchor = c.items[0].id;
      if (seen[key] || (anchors[anchor] || 0) >= 2) continue;
      seen[key] = 1; anchors[anchor] = (anchors[anchor] || 0) + 1;
      res.push(c);
      if (res.length >= limit) break;
    }
    return res;
  }

  // ── outfits ────────────────────────────────────────────────────────────────
  function listOutfits() {
    return live(data.outfits).map(o => {
      const items = (o.item_ids || []).map(getItem).filter(Boolean);
      return Object.assign({}, o, { items: items,
        total_price: r2(items.reduce((s, i) => s + (i.price || 0), 0)),
        blocked: items.filter(i => i.status !== 'available').map(i => i.name) });
    }).sort((a, b) => b.id - a.id);
  }

  function createOutfit(name, itemIds, occasion, notes) {
    const id = nextId();
    data.outfits.push({ id: id, name: name, item_ids: itemIds.map(Number),
      occasion: occasion || '', notes: notes || '',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    save();
    return id;
  }

  function deleteOutfit(id) {
    const o = live(data.outfits).find(x => x.id === Number(id));
    if (o) { o.deleted = true; o.updated_at = new Date().toISOString(); save(); }
    return { ok: true };
  }

  // Logs every piece, so cost per wear stays honest.
  function wearOutfit(id, wornOn) {
    const o = live(data.outfits).find(x => x.id === Number(id));
    if (!o) return 0;
    let n = 0;
    for (const iid of o.item_ids || []) {
      if (!logWear(iid, wornOn, 'outfit').duplicate) n++;
    }
    return n;
  }

  // ── style sources and rules ────────────────────────────────────────────────
  function listSources() {
    return live(data.sources).map(s => Object.assign({}, s,
      { rules: live(data.rules).filter(r => r.source_id === s.id) }))
      .sort((a, b) => b.id - a.id);
  }

  function addSource(meta, rules) {
    const sid = nextId();
    data.sources.push(Object.assign({ id: sid, kind: 'text', url: '', title: 'Pasted notes',
      summary: '', origin: 'manual', active: 1, added_at: new Date().toISOString(),
      updated_at: new Date().toISOString() }, meta || {}));
    for (const r of rules || []) {
      data.rules.push(Object.assign({ id: nextId(), source_id: sid, kind: 'colour_pair',
        colour_a: '', colour_b: '', verdict: 'good', occasion: '', text: '', weight: 1,
        origin: 'manual', active: 1, updated_at: new Date().toISOString() }, r));
    }
    save();
    return sid;
  }

  function setSourceActive(id, active) {
    const s = live(data.sources).find(x => x.id === Number(id));
    if (s) { s.active = active ? 1 : 0; s.updated_at = new Date().toISOString(); save(); }
    return { ok: true };
  }

  function setRuleActive(id, active) {
    const r = live(data.rules).find(x => x.id === Number(id));
    if (r) { r.active = active ? 1 : 0; r.updated_at = new Date().toISOString(); save(); }
    return { ok: true };
  }

  function deleteSource(id) {
    const s = live(data.sources).find(x => x.id === Number(id));
    if (s) { s.deleted = true; s.updated_at = new Date().toISOString(); }
    for (const r of live(data.rules)) {
      if (r.source_id === Number(id)) { r.deleted = true; r.updated_at = new Date().toISOString(); }
    }
    save();
    return { ok: true };
  }

  // Counts only rules actually in effect — a rule under a disabled source does
  // not count, or the UI reports influence that is not being applied.
  function ruleStats() {
    return { sources: live(data.sources).filter(s => s.active !== 0 && s.active !== false).length,
             rules: activeRules().length };
  }

  // ── import / export ────────────────────────────────────────────────────────
  function exportAll() {
    return { exported_at: new Date().toISOString(), schema: 1,
             items: live(data.items), wears: live(data.wears),
             outfits: live(data.outfits), style_sources: live(data.sources),
             style_rules: live(data.rules), photos: [], outfit_items: [] };
  }

  function exportCsv() {
    const cols = ['id', 'name', 'category', 'subcategory', 'brand', 'size', 'colour',
                  'material', 'formality', 'seasons', 'price', 'currency',
                  'purchase_date', 'status', 'wear_count', 'last_worn', 'cost_per_wear'];
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = Array.isArray(v) ? v.join('|') : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [cols.join(',')];
    for (const i of listItems({ include_retired: true })) {
      rows.push(cols.map(c => cell(i[c])).join(','));
    }
    return rows.join('\n');
  }

  // Accepts the local Python app's /api/export dump, or one of ours.
  function importAll(payload) {
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error('No "items" array in that file.');
    }
    const offset = data.seq;
    const mapId = (n) => offset + Number(n);
    for (const r of payload.items) {
      data.items.push(Object.assign({}, r, { id: mapId(r.id),
        seasons: Array.isArray(r.seasons) ? r.seasons
               : String(r.seasons || 'all-season').split(',').filter(Boolean),
        updated_at: new Date().toISOString() }));
      data.seq = Math.max(data.seq, mapId(r.id) + 1);
    }
    for (const r of payload.wears || []) {
      if (!r.worn_on) continue;
      data.wears.push({ id: nextId(), item_id: mapId(r.item_id), worn_on: r.worn_on,
        source: r.source || 'manual', note: r.note || '',
        updated_at: new Date().toISOString() });
    }
    for (const o of payload.outfits || []) {
      const ids = (payload.outfit_items || []).filter(x => x.outfit_id === o.id)
        .map(x => mapId(x.item_id));
      data.outfits.push(Object.assign({}, o, { id: nextId(),
        item_ids: o.item_ids ? o.item_ids.map(mapId) : ids,
        updated_at: new Date().toISOString() }));
    }
    for (const s of payload.style_sources || []) {
      const sid = nextId();
      data.sources.push(Object.assign({}, s, { id: sid, updated_at: new Date().toISOString() }));
      for (const r of (payload.style_rules || []).filter(x => x.source_id === s.id)) {
        data.rules.push(Object.assign({}, r, { id: nextId(), source_id: sid,
          updated_at: new Date().toISOString() }));
      }
    }
    save();
    return { items: payload.items.length, wears: (payload.wears || []).length };
  }

  return {
    CATEGORIES, STATUSES, FORMALITIES, SEASONS,
    normalise, harmony, occasionsFor,
    // Every colour word the matcher can recognise, for the rule extractor.
    HUES_FOR_MATCH: Object.keys(HUES).concat([...NEUTRALS]),
    loadPhotos, putPhoto, dropPhoto, photos,
    listItems, getItem, createItem, updateItem, deleteItem, resolvePhoto,
    logWear, unlogWear, wearHistory,
    stats, gaps, duplicates, packing, suggest, combos,
    listOutfits, createOutfit, deleteOutfit, wearOutfit,
    listSources, addSource, setSourceActive, setRuleActive, deleteSource,
    ruleStats, activeRules,
    exportAll, exportCsv, importAll,
    syncNow, pull, push, mergeRemote, mergeList, scheduleSync,
    raw: () => data, today,
  };
})();
