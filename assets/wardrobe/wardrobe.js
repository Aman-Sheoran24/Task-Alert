'use strict';

/* Wardrobe
   A port of the non-photo half of the local WardRobe app: the wear log, cost per
   wear, gap analysis, duplicate detection, packing lists and the colour-harmony
   outfit engine. All of that is ordinary reasoning over records, so it runs here
   with no server.

   What is deliberately NOT here: photo import, garment cutout and product
   rendering. Those need rembg, PIL and numpy — Python, on a machine. Keep using
   the local app for those; this one covers everything you can reason about from
   the garment facts alone. Items you add here carry no photo, which is why the
   importer exists: bring across what the local app already knows. */

// ─── Vocabulary (kept identical to the Python app, so exports line up) ────────
const W_CATEGORIES  = ['top', 'bottom', 'dress', 'outerwear', 'footwear',
                       'accessory', 'jewellery', 'bag', 'activewear', 'traditional'];
const W_STATUSES    = ['available', 'laundry', 'lent', 'repair', 'stored'];
const W_FORMALITY   = ['loungewear', 'casual', 'smart-casual', 'business', 'formal'];
const W_SEASONS     = ['summer', 'monsoon', 'winter', 'all-season'];

// Position on a 12-point colour wheel, for analogous/complementary distance.
const W_HUES = {
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

const W_NEUTRALS = new Set(['black', 'white', 'off-white', 'ivory', 'cream', 'grey',
  'gray', 'charcoal', 'silver', 'beige', 'tan', 'khaki', 'camel', 'taupe', 'stone',
  'sand', 'brown', 'chocolate', 'navy', 'olive', 'nude', 'gold', 'bronze']);

// Neutrals that read as dark. Two together can go flat.
const W_DARK_NEUTRALS = new Set(['black', 'charcoal', 'navy', 'chocolate', 'brown']);

const W_OCCASIONS = {
  loungewear: ['at home', 'gym', 'quick errands', 'travel day'],
  casual: ['coffee run', 'campus', 'weekend brunch', 'movie night', 'meeting friends', 'shopping'],
  'smart-casual': ['dinner out', 'date night', 'family function', 'relaxed office',
                   'house party', 'day trip'],
  business: ['office', 'client meeting', 'presentation', 'interview', 'conference'],
  formal: ['wedding', 'reception', 'ceremony', 'gala', 'award night'],
};

// A minimal functioning wardrobe, per category.
const W_CAPSULE_TARGET = { top: 8, bottom: 5, outerwear: 2, footwear: 3,
                           dress: 2, accessory: 3, bag: 2 };
// Owning none of these means they are not your style, not that you have a gap.
const W_OPTIONAL = new Set(['dress', 'traditional', 'jewellery', 'activewear']);

// ─── State ────────────────────────────────────────────────────────────────────
const WARDROBE_KEY = 'tm_wardrobe';
const WARDROBE_FILE = 'wardrobe.json';   // its own appData file, beside the task list

let wardrobe = { items: [], wears: [] };
try {
  const raw = JSON.parse(localStorage.getItem(WARDROBE_KEY) || 'null');
  if (raw && Array.isArray(raw.items)) wardrobe = { items: raw.items, wears: raw.wears || [] };
} catch (_) { /* a corrupt blob should not take the page down */ }

let wTab = 'items';
let wEditingId = null;
let wBusy = false;

function wSave() {
  localStorage.setItem(WARDROBE_KEY, JSON.stringify(wardrobe));
  scheduleWardrobeSync();
}

// ─── Colour reasoning ─────────────────────────────────────────────────────────

// Reduce free text to a single known colour token where possible.
function wNormalise(colour) {
  if (!colour) return '';
  const words = String(colour).toLowerCase().replace(/[^a-z\- ]/g, ' ')
    .split(/[\s\-]+/).filter(Boolean);
  for (const w of words) if (W_HUES[w] !== undefined || W_NEUTRALS.has(w)) return w;
  for (const w of words) {                       // then substring, e.g. "greyish"
    for (const known of Object.keys(W_HUES).concat([...W_NEUTRALS])) {
      if (w.indexOf(known) !== -1) return known;
    }
  }
  return words[0] || '';
}

function wIsNeutral(colour) { return W_NEUTRALS.has(wNormalise(colour)); }

// Classify a colour pair: [label, score 0-100, explanation].
function wHarmony(a0, b0) {
  const a = wNormalise(a0), b = wNormalise(b0);
  if (!a || !b) return ['unknown', 50, 'Colour not recorded for one of these pieces.'];

  const an = W_NEUTRALS.has(a), bn = W_NEUTRALS.has(b);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  if (an && bn) {
    if (a === b) {
      return ['tonal', 72, 'Same neutral top and bottom: a clean tonal look, but add ' +
              'texture or an accessory so it does not read flat.'];
    }
    if (W_DARK_NEUTRALS.has(a) && W_DARK_NEUTRALS.has(b)) {
      return ['neutral', 78, 'Two dark neutrals (' + a + ' and ' + b + '): sharp and easy, ' +
              'especially after dark.'];
    }
    return ['neutral', 87, cap(a) + ' and ' + b + ' are both neutrals, so they always agree. ' +
            'Safe, though an outfit of only neutrals can be a little anonymous.'];
  }

  // One colour anchored by a neutral is the most wearable interesting outfit
  // there is — rank it above head-to-toe neutral, or a wardrobe full of black
  // and grey buries everything with colour in it.
  if (an || bn) {
    const neutral = an ? a : b, colour = an ? b : a;
    return ['anchored', 91, cap(neutral) + ' is a neutral, so it anchors the ' + colour +
            ' without competing. Let the ' + colour + ' be the focal point.'];
  }

  const ha = W_HUES[a], hb = W_HUES[b];
  if (ha === undefined || hb === undefined) {
    return ['unknown', 50, 'One of these colours is not in the colour map.'];
  }

  const dist = Math.min((ha - hb + 12) % 12, (hb - ha + 12) % 12);
  if (dist === 0) {
    return ['monochrome', 80, 'Both sit in the ' + a + ' family: a monochrome pairing. ' +
            'Vary the shade or texture to keep it interesting.'];
  }
  if (dist <= 2) {
    return ['analogous', 84, cap(a) + ' and ' + b + ' are neighbours on the colour wheel, ' +
            'so they blend harmoniously without clashing.'];
  }
  if (dist >= 5) {
    return ['complementary', 82, cap(a) + ' and ' + b + ' sit opposite each other: high ' +
            'contrast and deliberately striking. Keep the rest of the outfit quiet.'];
  }
  return ['clash', 38, cap(a) + ' and ' + b + ' are too far apart to blend but too close to ' +
          'read as intentional contrast. Usually worth avoiding.'];
}

function wOccasionsFor(formality, colours) {
  const base = (W_OCCASIONS[formality] || W_OCCASIONS.casual).slice();
  const toks = new Set(colours.filter(Boolean).map(wNormalise));
  if (toks.has('white') || toks.has('cream') || toks.has('ivory')) base.push('daytime events');
  if (toks.has('black') || toks.has('navy') || toks.has('charcoal')) base.push('evening events');
  return base.slice(0, 6);
}

// ─── Derived facts ────────────────────────────────────────────────────────────

function wWearsOf(itemId) {
  return wardrobe.wears.filter(w => w.itemId === itemId && !w.deleted)
    .map(w => w.wornOn).sort().reverse();
}

function wToday() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function wDaysBetween(isoA, isoB) {
  return Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86400000);
}

// Attach wear count, last worn, days since and cost per wear to an item.
function wDerive(item) {
  const wears = wWearsOf(item.id);
  const price = Number(item.price);
  const out = Object.assign({}, item, {
    wearCount: wears.length,
    lastWorn: wears[0] || null,
    costPerWear: (price && wears.length) ? Math.round((price / wears.length) * 100) / 100 : null,
    daysSinceWorn: wears.length ? wDaysBetween(wears[0], wToday()) : null,
  });
  out.price = isFinite(price) ? price : null;
  return out;
}

function wItems() {
  return wardrobe.items.filter(i => !i.deleted).map(wDerive);
}

// ─── Insights ─────────────────────────────────────────────────────────────────

function wStats() {
  const items = wItems();
  const cpwKnown = items.filter(i => i.costPerWear !== null);
  const never = items.filter(i => i.wearCount === 0);
  const byCat = {}, byStatus = {};
  for (const i of items) {
    byCat[i.category] = (byCat[i.category] || 0) + 1;
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    itemCount: items.length,
    totalSpend: round2(items.reduce((s, i) => s + (i.price || 0), 0)),
    wornCount: items.filter(i => i.wearCount > 0).length,
    neverWornCount: never.length,
    // Money sunk into things never worn — the number a photo gallery cannot give you.
    neverWornValue: round2(never.reduce((s, i) => s + (i.price || 0), 0)),
    notWornInAYear: items.filter(i => i.daysSinceWorn !== null && i.daysSinceWorn > 365).length,
    totalWears: items.reduce((s, i) => s + i.wearCount, 0),
    avgCostPerWear: cpwKnown.length
      ? round2(cpwKnown.reduce((s, i) => s + i.costPerWear, 0) / cpwKnown.length) : null,
    bestValue: cpwKnown.slice().sort((a, b) => a.costPerWear - b.costPerWear).slice(0, 5),
    worstValue: cpwKnown.slice().sort((a, b) => b.costPerWear - a.costPerWear).slice(0, 5),
    byCategory: byCat,
    byStatus: byStatus,
  };
}

function wGaps(season) {
  let items = wItems().filter(i => i.status !== 'stored');
  if (season) {
    items = items.filter(i => (i.seasons || []).indexOf(season) !== -1 ||
                              (i.seasons || []).indexOf('all-season') !== -1);
  }
  const counts = {};
  for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;

  const findings = [];
  for (const cat of Object.keys(W_CAPSULE_TARGET)) {
    const target = W_CAPSULE_TARGET[cat];
    const have = counts[cat] || 0;
    if (have === 0 && W_OPTIONAL.has(cat)) continue;
    if (have < target) {
      findings.push({ kind: 'gap', category: cat, have: have, target: target,
        message: 'Only ' + have + ' ' + cat + ' item(s); a workable wardrobe wants about ' + target + '.' });
    } else if (have > target * 2.5) {
      findings.push({ kind: 'excess', category: cat, have: have, target: target,
        message: have + ' ' + cat + ' items is well past the ~' + target + ' you need — likely overbuying.' });
    }
  }

  // Can you actually dress for a formal occasion?
  for (const f of ['business', 'formal']) {
    const tops = items.filter(i => i.formality === f && (i.category === 'top' || i.category === 'dress'));
    const bottoms = items.filter(i => i.formality === f && (i.category === 'bottom' || i.category === 'dress'));
    if (!tops.length || !bottoms.length) {
      findings.push({ kind: 'gap', category: f, have: tops.length + bottoms.length, target: 2,
        message: 'You cannot assemble a complete ' + f + ' outfit from available items.' });
    }
  }

  // Colour monotony, per category.
  const byCatColour = {};
  for (const i of items) {
    if (!i.colour) continue;
    const c = i.colour.trim().toLowerCase();
    (byCatColour[i.category] = byCatColour[i.category] || {});
    byCatColour[i.category][c] = (byCatColour[i.category][c] || 0) + 1;
  }
  for (const cat of Object.keys(byCatColour)) {
    const colours = byCatColour[cat];
    const total = Object.values(colours).reduce((a, b) => a + b, 0);
    if (total < 5) continue;
    const top = Object.keys(colours).sort((a, b) => colours[b] - colours[a])[0];
    if (colours[top] / total >= 0.6) {
      findings.push({ kind: 'monotony', category: cat, have: colours[top], target: total,
        message: colours[top] + ' of ' + total + ' ' + cat + ' items are ' + top + ' — little variety.' });
    }
  }
  return findings;
}

// Grouped by category + colour rather than exact subcategory: "four black tops"
// is the insight that changes a purchase decision.
function wDuplicates(threshold) {
  threshold = threshold || 3;
  const groups = {};
  for (const i of wItems()) {
    const colour = (i.colour || '').trim().toLowerCase();
    if (!colour) continue;
    const key = i.category + '\u0000' + colour;
    (groups[key] = groups[key] || []).push(i);
  }
  const out = [];
  for (const key of Object.keys(groups)) {
    const members = groups[key];
    if (members.length < threshold) continue;
    const parts = key.split('\u0000');
    out.push({
      category: parts[0], colour: parts[1], count: members.length,
      spend: Math.round(members.reduce((s, m) => s + (m.price || 0), 0) * 100) / 100,
      items: members,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ─── Planning ─────────────────────────────────────────────────────────────────

function wSeasonForTemp(t) {
  if (t === null || t === undefined || t === '') return 'all-season';
  const n = Number(t);
  if (!isFinite(n)) return 'all-season';
  if (n >= 28) return 'summer';
  if (n <= 16) return 'winter';
  return 'monsoon';
}

function wPacking(days, tempC, rain) {
  days = Math.max(1, Math.min(parseInt(days, 10) || 1, 60));
  const season = wSeasonForTemp(tempC);
  const pool = wItems().filter(i =>
    (i.status === 'available' || i.status === 'laundry') &&
    ((i.seasons || []).indexOf(season) !== -1 || (i.seasons || []).indexOf('all-season') !== -1));

  // Rule of thumb: tops ≈ days (capped), bottoms ≈ days/2.5, shoes and a bag,
  // outerwear only when it is cold or wet.
  const need = {
    top: Math.min(days, 7),
    bottom: Math.max(1, Math.min(Math.round(days / 2.5), 4)),
    footwear: 1,
    bag: 1,
  };
  const t = Number(tempC);
  if (tempC !== '' && isFinite(t) && t <= 18) need.outerwear = 1;
  if (rain) need.outerwear = Math.max(need.outerwear || 0, 1);

  const chosen = [], missing = [];
  for (const cat of Object.keys(need)) {
    const n = need[cat];
    const cands = pool.filter(i => i.category === cat)
      .sort((a, b) => a.wearCount - b.wearCount || a.name.localeCompare(b.name));
    chosen.push.apply(chosen, cands.slice(0, n));
    if (cands.length < n) missing.push({ category: cat, have: cands.length, need: n });
  }
  const wash = chosen.filter(i => i.status === 'laundry');
  return {
    days: days, season: season, items: chosen, missing: missing, washFirst: wash,
    note: chosen.length + ' pieces for ' + days + ' day(s). ' +
          wash.length + ' need washing before you pack.',
  };
}

// Pick the accessory or shoe that best harmonises with the core colours.
// Formality is weighted heavily: gym trainers must not win a business combo
// just because grey happens to go with everything.
function wBestExtra(pool, colours, targetFormality) {
  if (!pool.length) return null;
  const want = W_FORMALITY.indexOf(targetFormality);
  const score = (x) => {
    const vals = colours.filter(Boolean).map(c => wHarmony(x.colour, c)[1]);
    let base = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
    if (want >= 0 && W_FORMALITY.indexOf(x.formality) >= 0) {
      base -= Math.abs(W_FORMALITY.indexOf(x.formality) - want) * 30;
    }
    return base + (x.daysSinceWorn === null ? 4 : Math.min(x.daysSinceWorn, 60) / 20);
  };
  return pool.slice().sort((a, b) => score(b) - score(a))[0];
}

function wBuildCombos(opts) {
  opts = opts || {};
  const limit = opts.limit || 8;
  const excludeRecentDays = 3;

  let avail = wItems().filter(i => i.status === 'available');
  if (opts.season) {
    avail = avail.filter(i => (i.seasons || []).indexOf(opts.season) !== -1 ||
                              (i.seasons || []).indexOf('all-season') !== -1);
  }
  if (opts.formality) {
    const want = Math.max(0, W_FORMALITY.indexOf(opts.formality));
    avail = avail.filter(i => W_FORMALITY.indexOf(i.formality) < 0 ||
                              Math.abs(W_FORMALITY.indexOf(i.formality) - want) <= 1);
  }

  const tops    = avail.filter(i => i.category === 'top' || i.category === 'traditional');
  const bottoms = avail.filter(i => i.category === 'bottom');
  const dresses = avail.filter(i => i.category === 'dress');
  const shoes   = avail.filter(i => i.category === 'footwear');
  const outers  = avail.filter(i => i.category === 'outerwear');
  const extras  = avail.filter(i => ['accessory', 'jewellery', 'bag'].indexOf(i.category) !== -1);

  const pairs = [];
  for (const t of tops) for (const b of bottoms) pairs.push([t, b]);
  for (const d of dresses) pairs.push([d, null]);

  const combos = [];
  for (const pair of pairs) {
    const top = pair[0], bottom = pair[1];
    const core = bottom ? [top, bottom] : [top];
    const colours = core.map(x => x.colour);

    let label, score, why;
    if (bottom) {
      const h = wHarmony(top.colour, bottom.colour);
      label = h[0]; score = h[1]; why = h[2];
    } else {
      label = 'single piece'; score = 80;
      why = 'A one-piece outfit, so there is no colour clash to manage.';
    }
    const reasons = [why];

    const idx = core.map(i => W_FORMALITY.indexOf(i.formality)).filter(n => n >= 0);
    if (idx.length && (Math.max.apply(null, idx) - Math.min.apply(null, idx)) >= 2) {
      score -= 22;
      reasons.push('These pieces sit far apart in formality, which reads inconsistent.');
    }

    // Rotation: favour things you have not worn lately.
    for (const x of core) {
      if (x.daysSinceWorn === null) score += 5;
      else if (x.daysSinceWorn < excludeRecentDays) score -= 18;
      else score += Math.min(x.daysSinceWorn, 90) / 30;
    }

    const formalityOf = core.map(x => x.formality)
      .filter(f => W_FORMALITY.indexOf(f) >= 0)
      .sort((a, b) => W_FORMALITY.indexOf(b) - W_FORMALITY.indexOf(a))[0] || 'casual';

    const shoe = wBestExtra(shoes, colours, formalityOf);
    const extra = wBestExtra(extras, colours, formalityOf);
    const chosen = core.concat([shoe, extra].filter(Boolean));
    if (shoe) {
      const h = wHarmony(shoe.colour, (bottom || top).colour);
      score += (h[1] - 60) / 8;
      reasons.push('Footwear: ' + h[2]);
    }

    const layer = wBestExtra(outers, colours, formalityOf);
    combos.push({
      items: chosen,
      harmony: label,
      score: Math.round(Math.max(0, Math.min(100, score))),
      why: reasons,
      occasions: wOccasionsFor(formalityOf, chosen.map(x => x.colour)),
      formality: formalityOf,
      layerHint: layer ? (layer.name + ' layers over this cleanly if it turns cold.') : null,
    });
  }

  combos.sort((a, b) => b.score - a.score);

  // Keep the list varied: no single garment should dominate the whole page.
  const seenPair = {}, anchorCount = {}, out = [];
  for (const c of combos) {
    const key = c.items.slice(0, 2).map(i => i.id).sort().join('-');
    const anchor = c.items[0].id;
    if (seenPair[key] || (anchorCount[anchor] || 0) >= 2) continue;
    seenPair[key] = 1;
    anchorCount[anchor] = (anchorCount[anchor] || 0) + 1;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Drive sync ───────────────────────────────────────────────────────────────
// Its own appData file alongside the task list, so wardrobe records follow you
// between devices without being mixed into the task sync.

let wardrobeFileId = localStorage.getItem('tm_wardrobe_file') || null;
let wardrobeSyncTimer = null;

async function ensureWardrobeFile() {
  if (wardrobeFileId) return wardrobeFileId;
  const q = encodeURIComponent("name='" + WARDROBE_FILE + "'");
  const list = await drive('GET',
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id)&q=' + q);
  if (list && list.files && list.files.length) {
    wardrobeFileId = list.files[0].id;
  } else {
    const meta = await drive('POST', 'https://www.googleapis.com/drive/v3/files',
      { name: WARDROBE_FILE, parents: ['appDataFolder'] });
    wardrobeFileId = meta.id;
  }
  localStorage.setItem('tm_wardrobe_file', wardrobeFileId);
  return wardrobeFileId;
}

// Union by id, newest updatedAt winning — the same shape as the task merge, so a
// second device reconciles instead of overwriting.
function wMerge(a, b) {
  const byId = new Map();
  for (const rec of a.concat(b)) {
    if (!rec || rec.id == null) continue;
    const prev = byId.get(rec.id);
    if (!prev || (rec.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(rec.id, rec);
  }
  return Array.from(byId.values());
}

async function loadWardrobeFromDrive() {
  if (!gcalConnected || !accessToken) return;
  const id = await ensureWardrobeFile();
  const text = await drive('GET',
    'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', undefined, true);
  if (!text) return;
  let remote = null;
  try { remote = JSON.parse(text); } catch (_) { return; }
  if (!remote || !Array.isArray(remote.items)) return;
  wardrobe.items = wMerge(wardrobe.items, remote.items);
  wardrobe.wears = wMerge(wardrobe.wears, remote.wears || []);
  localStorage.setItem(WARDROBE_KEY, JSON.stringify(wardrobe));
  renderWardrobe();
}

async function saveWardrobeToDrive() {
  if (!gcalConnected || !accessToken) return;
  const id = await ensureWardrobeFile();
  await drive('PATCH',
    'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', wardrobe);
}

function scheduleWardrobeSync() {
  clearTimeout(wardrobeSyncTimer);
  wardrobeSyncTimer = setTimeout(() => {
    saveWardrobeToDrive().catch(e => {
      if (e.message !== 'expired') wStatus('Drive sync error: ' + e.message, 'err');
    });
  }, 1200);
}

// ─── Importing from the local Python app ──────────────────────────────────────
// Its /api/export dump is the bridge: the records come across, the photos stay
// on your machine where they were always meant to be.
function importWardrobeExport(json) {
  let data;
  try { data = JSON.parse(json); } catch (e) { throw new Error('That is not valid JSON.'); }
  if (!data || !Array.isArray(data.items)) {
    throw new Error('No "items" array in that file — is it the export from the local app?');
  }

  const now = Date.now();
  const items = data.items.map(r => ({
    id: 'py-' + r.id,
    name: r.name || 'Untitled',
    category: W_CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'top',
    subcategory: r.subcategory || '',
    brand: r.brand || '',
    size: r.size || '',
    colour: r.colour || '',
    material: r.material || '',
    formality: W_FORMALITY.indexOf(r.formality) >= 0 ? r.formality : 'casual',
    seasons: String(r.seasons || 'all-season').split(',').filter(Boolean),
    price: r.price == null ? null : Number(r.price),
    currency: r.currency || 'INR',
    purchaseDate: r.purchase_date || '',
    status: W_STATUSES.indexOf(r.status) >= 0 ? r.status : 'available',
    notes: r.notes || '',
    createdAt: now,
    updatedAt: now,
  }));

  const wears = (data.wears || []).map(r => ({
    id: 'py-' + r.id,
    itemId: 'py-' + r.item_id,
    wornOn: r.worn_on,
    note: r.note || '',
    updatedAt: now,
  })).filter(w => w.wornOn);

  wardrobe.items = wMerge(wardrobe.items, items);
  wardrobe.wears = wMerge(wardrobe.wears, wears);
  wSave();
  return { items: items.length, wears: wears.length };
}

function exportWardrobe() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    schema: 1,
    items: wardrobe.items,
    wears: wardrobe.wears,
  }, null, 2);
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const wModal = document.getElementById('wModal');

function wStatus(text, cls) {
  const el = document.getElementById('wStatus');
  el.textContent = text;
  el.className = 'w-status' + (cls ? ' ' + cls : '');
}

function wMoney(n, currency) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return (currency || 'INR') + ' ' + Math.round(n).toLocaleString();
}

function setWTab(tab) {
  wTab = tab;
  for (const t of ['items', 'insights', 'plan']) {
    const on = t === tab;
    document.getElementById('wTab-' + t).classList.toggle('on', on);
    document.getElementById('wPane-' + t).classList.toggle('on', on);
  }
  renderWardrobe();
}

// ─── Items ────────────────────────────────────────────────────────────────────

function renderItems() {
  const wrap = document.getElementById('wItemList');
  const items = wItems().sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  document.getElementById('wItemCount').textContent = items.length;
  if (!items.length) {
    wrap.innerHTML = '<div class="empty-msg">No items yet. Add one, or import from the local app.</div>';
    return;
  }

  wrap.innerHTML = items.map(i => {
    const cpw = i.costPerWear === null ? '—' : wMoney(i.costPerWear, i.currency);
    const last = i.lastWorn
      ? (i.daysSinceWorn === 0 ? 'today' : i.daysSinceWorn + 'd ago')
      : 'never worn';
    return '<div class="w-item' + (i.status !== 'available' ? ' muted' : '') + '">' +
      '<div class="w-item-main">' +
        '<b>' + esc(i.name) + '</b>' +
        '<span class="w-meta">' + esc(i.category) +
          (i.colour ? ' · ' + esc(i.colour) : '') +
          ' · ' + esc(i.status) + '</span>' +
        '<span class="w-meta">worn ' + i.wearCount + '× · ' + esc(last) +
          ' · cost/wear ' + esc(cpw) + '</span>' +
      '</div>' +
      '<div class="w-item-btns">' +
        '<button data-wear="' + esc(i.id) + '" title="Log a wear today">👕</button>' +
        '<button data-edit="' + esc(i.id) + '" title="Edit">✎</button>' +
        '<button data-del="' + esc(i.id) + '" title="Delete">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openItemForm(id) {
  wEditingId = id || null;
  const i = id ? wardrobe.items.find(x => x.id === id) : null;
  const f = document.getElementById('wForm');
  f.classList.add('on');
  document.getElementById('wFormTitle').textContent = i ? 'Edit item' : 'New item';

  f.querySelector('[name=name]').value      = i ? i.name : '';
  f.querySelector('[name=category]').value  = i ? i.category : 'top';
  f.querySelector('[name=colour]').value    = i ? (i.colour || '') : '';
  f.querySelector('[name=brand]').value     = i ? (i.brand || '') : '';
  f.querySelector('[name=material]').value  = i ? (i.material || '') : '';
  f.querySelector('[name=formality]').value = i ? i.formality : 'casual';
  f.querySelector('[name=status]').value    = i ? i.status : 'available';
  f.querySelector('[name=price]').value     = i && i.price != null ? i.price : '';
  f.querySelector('[name=purchaseDate]').value = i ? (i.purchaseDate || '') : '';
  f.querySelector('[name=notes]').value     = i ? (i.notes || '') : '';
  for (const cb of f.querySelectorAll('[name=season]')) {
    cb.checked = i ? (i.seasons || []).indexOf(cb.value) !== -1 : cb.value === 'all-season';
  }
  document.getElementById('wItemDelete').style.display = i ? '' : 'none';
}

function closeItemForm() {
  document.getElementById('wForm').classList.remove('on');
  wEditingId = null;
}

function saveItemForm() {
  const f = document.getElementById('wForm');
  const name = f.querySelector('[name=name]').value.trim();
  if (!name) return wStatus('Give the item a name.', 'err');

  const seasons = Array.from(f.querySelectorAll('[name=season]'))
    .filter(cb => cb.checked).map(cb => cb.value);
  const priceRaw = f.querySelector('[name=price]').value.trim();

  const rec = {
    name: name,
    category: f.querySelector('[name=category]').value,
    colour: f.querySelector('[name=colour]').value.trim(),
    brand: f.querySelector('[name=brand]').value.trim(),
    material: f.querySelector('[name=material]').value.trim(),
    formality: f.querySelector('[name=formality]').value,
    status: f.querySelector('[name=status]').value,
    price: priceRaw === '' ? null : Number(priceRaw),
    currency: 'INR',
    purchaseDate: f.querySelector('[name=purchaseDate]').value,
    notes: f.querySelector('[name=notes]').value.trim(),
    seasons: seasons.length ? seasons : ['all-season'],
    updatedAt: Date.now(),
  };

  if (wEditingId) {
    Object.assign(wardrobe.items.find(x => x.id === wEditingId), rec);
  } else {
    wardrobe.items.push(Object.assign({ id: 'w' + Date.now(), createdAt: Date.now() }, rec));
  }
  const wasEdit = !!wEditingId;
  wSave();
  closeItemForm();
  wStatus(wasEdit ? 'Item updated.' : 'Item added.', 'on');
  renderWardrobe();
}

function logWear(itemId) {
  const today = wToday();
  // One wear per item per day: tapping twice is a slip, not two outings. A second
  // tap undoes it, which is also how you fix a mis-tap.
  const existing = wardrobe.wears.find(
    w => w.itemId === itemId && w.wornOn === today && !w.deleted);
  if (existing) {
    existing.deleted = true;
    existing.updatedAt = Date.now();
    wStatus('Removed today’s wear.', 'on');
  } else {
    wardrobe.wears.push({
      id: 'ww' + Date.now() + Math.random().toString(36).slice(2, 6),
      itemId: itemId, wornOn: today, note: '', updatedAt: Date.now(),
    });
    wStatus('Logged a wear for today.', 'on');
  }
  wSave();
  renderWardrobe();
}

function deleteItem(id) {
  const i = wardrobe.items.find(x => x.id === id);
  if (!i) return;
  i.deleted = true;                 // a tombstone, so the delete reaches other devices
  i.updatedAt = Date.now();
  wSave();
  closeItemForm();
  wStatus('Deleted "' + i.name + '".', 'on');
  renderWardrobe();
}

// ─── Insights ─────────────────────────────────────────────────────────────────

function renderInsights() {
  const s = wStats();
  const tile = (label, value) =>
    '<div class="w-tile"><b>' + esc(String(value)) + '</b><span>' + esc(label) + '</span></div>';

  document.getElementById('wStatTiles').innerHTML =
    tile('items', s.itemCount) +
    tile('total spend', wMoney(s.totalSpend)) +
    tile('total wears', s.totalWears) +
    tile('never worn', s.neverWornCount) +
    tile('tied up in unworn', wMoney(s.neverWornValue)) +
    tile('avg cost/wear', s.avgCostPerWear === null ? '—' : wMoney(s.avgCostPerWear)) +
    tile('unworn 1 yr+', s.notWornInAYear);

  const valueList = (list, cls) => list.length
    ? list.map(i => '<div class="w-row ' + cls + '"><span>' + esc(i.name) + '</span>' +
        '<b>' + esc(wMoney(i.costPerWear, i.currency)) + '</b></div>').join('')
    : '<div class="empty-msg">Not enough wear history yet.</div>';

  document.getElementById('wBestValue').innerHTML = valueList(s.bestValue, 'good');
  document.getElementById('wWorstValue').innerHTML = valueList(s.worstValue, 'bad');

  const gaps = wGaps(document.getElementById('wGapSeason').value || null);
  document.getElementById('wGaps').innerHTML = gaps.length
    ? gaps.map(g => '<div class="w-finding ' + esc(g.kind) + '">' + esc(g.message) + '</div>').join('')
    : '<div class="empty-msg">Nothing flagged — the coverage looks reasonable.</div>';

  const dupes = wDuplicates();
  document.getElementById('wDupes').innerHTML = dupes.length
    ? dupes.map(d => '<div class="w-finding dup">' + d.count + ' ' + esc(d.colour) + ' ' +
        esc(d.category) + ' items, ' + esc(wMoney(d.spend)) + ' spent' +
        '<span class="w-meta">' + esc(d.items.map(i => i.name).join(', ')) + '</span></div>').join('')
    : '<div class="empty-msg">No near-duplicate purchases found.</div>';
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

function renderPlan() {
  const combos = wBuildCombos({
    formality: document.getElementById('wComboFormality').value || null,
    season: document.getElementById('wComboSeason').value || null,
    limit: 8,
  });

  document.getElementById('wCombos').innerHTML = combos.length
    ? combos.map(c =>
        '<div class="w-combo">' +
          '<div class="w-combo-head">' +
            '<b>' + esc(c.items.map(i => i.name).join('  +  ')) + '</b>' +
            '<span class="w-score">' + c.score + '</span>' +
          '</div>' +
          '<span class="w-meta">' + esc(c.harmony) + ' · ' + esc(c.formality) + '</span>' +
          c.why.map(w => '<div class="w-why">' + esc(w) + '</div>').join('') +
          (c.layerHint ? '<div class="w-why">' + esc(c.layerHint) + '</div>' : '') +
          '<div class="w-occ">' + c.occasions.map(o => '<span>' + esc(o) + '</span>').join('') + '</div>' +
        '</div>').join('')
    : '<div class="empty-msg">Not enough available items to build an outfit — you need at ' +
      'least one top and one bottom marked available.</div>';

  const p = wPacking(
    document.getElementById('wPackDays').value,
    document.getElementById('wPackTemp').value,
    document.getElementById('wPackRain').checked);

  document.getElementById('wPacking').innerHTML =
    '<div class="w-meta">' + esc(p.note) + ' Season read as ' + esc(p.season) + '.</div>' +
    (p.items.length
      ? p.items.map(i => '<div class="w-row"><span>' + esc(i.name) + '</span>' +
          '<b>' + esc(i.category) + (i.status === 'laundry' ? ' · wash first' : '') + '</b></div>').join('')
      : '<div class="empty-msg">Nothing available matches that season.</div>') +
    p.missing.map(m => '<div class="w-finding gap">Short on ' + esc(m.category) +
      ': have ' + m.have + ', need ' + m.need + '.</div>').join('');
}

function renderWardrobe() {
  if (wTab === 'items') renderItems();
  else if (wTab === 'insights') renderInsights();
  else renderPlan();
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

document.getElementById('wLaunch').addEventListener('click', () => {
  wModal.classList.add('show');
  renderWardrobe();
  if (gcalConnected) {
    loadWardrobeFromDrive().catch(e => {
      if (e.message !== 'expired') wStatus('Drive load error: ' + e.message, 'err');
    });
  }
});
document.getElementById('wClose').addEventListener('click', () => wModal.classList.remove('show'));
wModal.addEventListener('click', e => { if (e.target === wModal) wModal.classList.remove('show'); });

for (const t of ['items', 'insights', 'plan']) {
  document.getElementById('wTab-' + t).addEventListener('click', () => setWTab(t));
}

document.getElementById('wAdd').addEventListener('click', () => openItemForm(null));
document.getElementById('wItemSave').addEventListener('click', saveItemForm);
document.getElementById('wItemCancel').addEventListener('click', closeItemForm);
document.getElementById('wItemDelete').addEventListener('click', () => {
  if (wEditingId) deleteItem(wEditingId);
});

// The list is rebuilt on every change, so its buttons are delegated.
document.getElementById('wItemList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-wear],button[data-edit],button[data-del]');
  if (!b) return;
  if (b.dataset.wear) logWear(b.dataset.wear);
  else if (b.dataset.edit) openItemForm(b.dataset.edit);
  else if (b.dataset.del) deleteItem(b.dataset.del);
});

for (const id of ['wGapSeason', 'wComboFormality', 'wComboSeason', 'wPackDays', 'wPackTemp', 'wPackRain']) {
  document.getElementById(id).addEventListener('change', renderWardrobe);
}

document.getElementById('wImport').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const n = importWardrobeExport(String(fr.result));
      wStatus('Imported ' + n.items + ' items and ' + n.wears + ' wear records.', 'on');
      renderWardrobe();
    } catch (err) {
      wStatus(err.message, 'err');
    }
  };
  fr.onerror = () => wStatus('Could not read that file.', 'err');
  fr.readAsText(file);
  e.target.value = '';
});

document.getElementById('wExport').addEventListener('click', () => {
  const blob = new Blob([exportWardrobe()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wardrobe-' + wToday() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  wStatus('Exported.', 'on');
});
