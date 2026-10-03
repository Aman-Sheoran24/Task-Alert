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

let wardrobe = { items: [], wears: [], outfits: [], rules: [], sources: [] };
try {
  const raw = JSON.parse(localStorage.getItem(WARDROBE_KEY) || 'null');
  if (raw && Array.isArray(raw.items)) {
    wardrobe = { items: raw.items, wears: raw.wears || [],
                 outfits: raw.outfits || [], rules: raw.rules || [],
                 sources: raw.sources || [] };
  }
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

  // Saved style rules nudge the ranking. With none, this is a no-op and the
  // colour engine decides on its own.
  const pairRules = wPairRules();

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

    score += wRuleAdjust(chosen.map(x => x.colour), reasons, pairRules);

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
  wardrobe.items   = wMerge(wardrobe.items, remote.items);
  wardrobe.wears   = wMerge(wardrobe.wears, remote.wears || []);
  wardrobe.outfits = wMerge(wardrobe.outfits || [], remote.outfits || []);
  wardrobe.rules   = wMerge(wardrobe.rules || [], remote.rules || []);
  wardrobe.sources = wMerge(wardrobe.sources || [], remote.sources || []);
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
    retired: !!r.retired,
    statusNote: r.status_note || '',
    category: W_CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'top',
    subcategory: r.subcategory || '',
    brand: r.brand || '',
    size: r.size || '',
    colour: r.colour || '',
    pattern: r.pattern || '',
    care: r.care || '',
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
    outfits: wardrobe.outfits || [],
    rules: wardrobe.rules || [],
    sources: wardrobe.sources || [],
  }, null, 2);
}

// ─── Style rules ──────────────────────────────────────────────────────────────
// Rules you have saved from your own style sources. They do not replace the
// colour engine — they nudge its ranking, so the app still works with none.

function wActiveRules() {
  const liveSources = new Set((wardrobe.sources || [])
    .filter(s => !s.deleted && s.active !== false).map(s => s.id));
  return (wardrobe.rules || []).filter(r =>
    !r.deleted && r.active !== false &&
    // A rule under a disabled source does not count, or the UI claims influence
    // that is not actually being applied.
    (!r.sourceId || liveSources.has(r.sourceId)));
}

function wPairRules() {
  return wActiveRules().map(r => ({
    a: wNormalise(r.colourA), b: wNormalise(r.colourB), rule: r,
  })).filter(p => p.a && p.b);
}

function wRuleAdjust(colours, reasons, pairRules) {
  let delta = 0;
  const toks = colours.filter(Boolean).map(wNormalise);
  for (const p of pairRules) {
    if (toks.indexOf(p.a) === -1 || toks.indexOf(p.b) === -1) continue;
    const good = (p.rule.verdict || 'good') === 'good';
    const weight = Number(p.rule.weight) || 1;
    delta += (good ? 14 : -26) * weight;
    reasons.push((good ? 'Your saved style note: ' : 'Your saved style note warns: ') +
                 (p.rule.text || (p.a + ' with ' + p.b)));
  }
  return delta;
}

// Pattern-match colour pairs out of pasted text. Deliberately modest — it is
// the fallback for when no Gemini key is set.
const W_AVOID_RE = /\b(avoid|never|don'?t|do not|clash)\b/i;

function wExtractRulesOffline(text) {
  const names = Object.keys(W_HUES).concat([...W_NEUTRALS]).join('|');
  const pairRe = new RegExp('\\b(' + names + ')\\b[^.;!?\\n]{0,40}?\\b(?:with|and|against|over|under|plus)\\b[^.;!?\\n]{0,20}?\\b(' + names + ')\\b', 'gi');
  const rules = [], seen = new Set();

  for (const sentence of String(text || '').split(/[.\n;!?]/)) {
    const s = sentence.trim();
    if (s.length < 8) continue;
    const avoid = W_AVOID_RE.test(s);
    let m;
    pairRe.lastIndex = 0;
    while ((m = pairRe.exec(s)) !== null) {
      const a = wNormalise(m[1]), b = wNormalise(m[2]);
      const key = a + '|' + b;
      if (!a || !b || a === b || seen.has(key)) continue;
      seen.add(key);
      rules.push({ colourA: a, colourB: b, verdict: avoid ? 'avoid' : 'good',
                   text: s.slice(0, 300), weight: 0.6, origin: 'heuristic' });
      if (rules.length >= 20) break;
    }
    if (rules.length >= 20) break;
  }
  return rules;
}

// With a key, Gemini reads the text properly instead of pattern-matching it.
async function wExtractRulesAI(text) {
  const out = await gemini([{ text:
    'Below are notes about clothing style. Extract the concrete colour-pairing ' +
    'rules they state. Reply with JSON only — an array, no prose, no code fence:\n' +
    '[{"colourA":"navy","colourB":"brown","verdict":"good","text":"<the sentence ' +
    'that says so>","weight":0.9}]\n\n' +
    'Rules: verdict is "good" or "avoid". weight is 0 to 1, how strongly the text ' +
    'asserts it. Use single plain colour words. Only include a pair the text ' +
    'actually comments on — do not infer from general colour theory, and return ' +
    '[] if it states none.\n\nNOTES:\n' + text }]);

  const cleaned = out.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) {
    throw new Error('Gemini did not return usable JSON. Try the offline reader.');
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini did not return a list of rules.');

  return parsed.map(r => ({
    colourA: wNormalise(r.colourA), colourB: wNormalise(r.colourB),
    verdict: r.verdict === 'avoid' ? 'avoid' : 'good',
    text: String(r.text || '').slice(0, 300),
    weight: Math.max(0, Math.min(Number(r.weight) || 1, 1)),
    origin: 'ai',
  })).filter(r => r.colourA && r.colourB && r.colourA !== r.colourB);
}

function wAddSource(title, rules, origin) {
  const sid = 's' + Date.now();
  wardrobe.sources = wardrobe.sources || [];
  wardrobe.rules = wardrobe.rules || [];
  wardrobe.sources.push({ id: sid, title: title || 'Pasted notes', origin: origin,
                          active: true, addedAt: Date.now(), updatedAt: Date.now() });
  for (const r of rules) {
    wardrobe.rules.push(Object.assign({
      id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6),
      sourceId: sid, active: true, updatedAt: Date.now(),
    }, r));
  }
  wSave();
  return rules.length;
}

// ─── Pick one outfit for me ───────────────────────────────────────────────────
// Lower score is better. Formality match dominates everything else — a business
// trouser must never win a casual slot just because it is under-worn. Within a
// band we rotate: recently worn sinks, long-idle and never-worn rise. Wear count
// is capped so a beloved item worn 200 times is only gently penalised.
function wSuggest(tempC, rain, formality) {
  const season = wSeasonForTemp(tempC);
  const pool = wItems().filter(i => i.status === 'available' &&
    ((i.seasons || []).indexOf(season) !== -1 || (i.seasons || []).indexOf('all-season') !== -1));

  const want = Math.max(0, W_FORMALITY.indexOf(formality || 'casual'));
  const score = (i) => {
    const fi = W_FORMALITY.indexOf(i.formality);
    let s = (fi >= 0 ? Math.abs(fi - want) : 2) * 1000;
    if (i.daysSinceWorn === null) s -= 60;                 // never worn: pull in
    else if (i.daysSinceWorn < 7) s += 400;                // just worn: don't repeat
    else s -= Math.min(i.daysSinceWorn, 180) / 2;
    return s + Math.min(i.wearCount, 60) / 2;
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
    notes.push(t + '°C — added a layer.');
  }
  if (rain) notes.push('Rain expected: avoid suede or canvas footwear and light colours.');
  if (hasTemp && t >= 32) notes.push(t + '°C — favour cotton or linen and loose fits.');
  chosen.push.apply(chosen, pick(['bag']));

  if (!chosen.length) notes.push('Nothing available matched. Check laundry status, or add items.');
  return { season: season, formality: formality || 'casual', items: chosen, notes: notes };
}

// ─── Saved outfits ────────────────────────────────────────────────────────────

function wListOutfits() {
  return (wardrobe.outfits || []).filter(o => !o.deleted).map(o => {
    const items = (o.itemIds || [])
      .map(id => wardrobe.items.find(x => x.id === id && !x.deleted))
      .filter(Boolean).map(wDerive);
    return Object.assign({}, o, {
      items: items,
      totalPrice: Math.round(items.reduce((s, i) => s + (i.price || 0), 0) * 100) / 100,
      // Anything not available means you cannot actually wear this today.
      blocked: items.filter(i => i.status !== 'available').map(i => i.name),
    });
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function wCreateOutfit(name, itemIds, occasion) {
  wardrobe.outfits = wardrobe.outfits || [];
  wardrobe.outfits.push({
    id: 'o' + Date.now(), name: name, itemIds: itemIds.slice(),
    occasion: occasion || '', createdAt: Date.now(), updatedAt: Date.now(),
  });
  wSave();
}

function wDeleteOutfit(id) {
  const o = (wardrobe.outfits || []).find(x => x.id === id);
  if (!o) return;
  o.deleted = true; o.updatedAt = Date.now();
  wSave();
}

// Logging an outfit logs every piece in it, so cost per wear stays honest.
function wWearOutfit(id, onDate) {
  const o = (wardrobe.outfits || []).find(x => x.id === id);
  if (!o) return 0;
  let n = 0;
  for (const itemId of o.itemIds || []) {
    if (wLogWearOn(itemId, onDate || wToday(), 'outfit')) n++;
  }
  wSave();
  return n;
}

// Log a wear on a specific date. Returns false if that date is already logged,
// so logging an outfit twice does not double-count the pieces.
function wLogWearOn(itemId, date, source) {
  const dup = wardrobe.wears.some(w => w.itemId === itemId && w.wornOn === date && !w.deleted);
  if (dup) return false;
  wardrobe.wears.push({
    id: 'ww' + Date.now() + Math.random().toString(36).slice(2, 6),
    itemId: itemId, wornOn: date, source: source || 'manual', note: '',
    updatedAt: Date.now(),
  });
  return true;
}

function wRemoveWear(wearId) {
  const w = wardrobe.wears.find(x => x.id === wearId);
  if (!w) return;
  w.deleted = true; w.updatedAt = Date.now();
  wSave();
}

function wWearHistory(itemId) {
  return wardrobe.wears.filter(w => w.itemId === itemId && !w.deleted)
    .sort((a, b) => b.wornOn.localeCompare(a.wornOn));
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function wExportCsv() {
  const cols = ['id', 'name', 'category', 'subcategory', 'brand', 'size', 'colour',
                'material', 'formality', 'seasons', 'price', 'currency',
                'purchaseDate', 'status', 'wearCount', 'lastWorn', 'costPerWear'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join('|') : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  for (const i of wItems()) rows.push(cols.map(c => cell(i[c])).join(','));
  return rows.join('\n');
}

function wDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
  for (const t of ['items', 'insights', 'plan', 'style']) {
    const on = t === tab;
    document.getElementById('wTab-' + t).classList.toggle('on', on);
    document.getElementById('wPane-' + t).classList.toggle('on', on);
  }
  renderWardrobe();
}

// ─── Items ────────────────────────────────────────────────────────────────────

function renderItems() {
  const wrap = document.getElementById('wItemList');
  const q = (document.getElementById('wSearch').value || '').trim().toLowerCase();
  const items = wItems()
    // Retired pieces keep their history but drop out of the working list.
    .filter(i => !i.retired)
    .filter(i => !q || [i.name, i.brand, i.colour, i.subcategory, i.notes]
      .some(v => (v || '').toLowerCase().indexOf(q) !== -1))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

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
  f.querySelector('[name=subcategory]').value = i ? (i.subcategory || '') : '';
  f.querySelector('[name=size]').value      = i ? (i.size || '') : '';
  f.querySelector('[name=pattern]').value   = i ? (i.pattern || '') : '';
  f.querySelector('[name=care]').value      = i ? (i.care || '') : '';
  f.querySelector('[name=statusNote]').value = i ? (i.statusNote || '') : '';
  f.querySelector('[name=retired]').checked = i ? !!i.retired : false;
  renderWearHistory(i ? i.id : null);
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
    subcategory: f.querySelector('[name=subcategory]').value.trim(),
    size: f.querySelector('[name=size]').value.trim(),
    pattern: f.querySelector('[name=pattern]').value.trim(),
    care: f.querySelector('[name=care]').value.trim(),
    statusNote: f.querySelector('[name=statusNote]').value.trim(),
    retired: f.querySelector('[name=retired]').checked,
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
  renderSuggest();
  renderOutfits();

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
  else if (wTab === 'style') renderRules();
  else renderPlan();
}


// ─── UI: suggest, outfits, style rules ────────────────────────────────────────

function renderSuggest() {
  const s = wSuggest(
    document.getElementById('wSugTemp').value,
    document.getElementById('wSugRain').checked,
    document.getElementById('wSugFormality').value);

  document.getElementById('wSuggest').innerHTML =
    (s.items.length
      ? '<div class="w-combo">' +
          '<div class="w-combo-head"><b>' +
            esc(s.items.map(i => i.name).join('  +  ')) + '</b></div>' +
          '<span class="w-meta">' + esc(s.formality) + ' · ' + esc(s.season) + '</span>' +
          s.notes.map(n => '<div class="w-why">' + esc(n) + '</div>').join('') +
          '<div class="w-form-btns" style="margin-top:8px">' +
            '<button class="w-save" id="wSugWear">Wear this today</button>' +
            '<button class="w-cancel" id="wSugSave">Save as outfit</button>' +
          '</div>' +
        '</div>'
      : '<div class="empty-msg">' +
        esc(s.notes[0] || 'Nothing available matched.') + '</div>');

  const wear = document.getElementById('wSugWear');
  if (wear) {
    wear.addEventListener('click', () => {
      let n = 0;
      for (const i of s.items) if (wLogWearOn(i.id, wToday(), 'suggest')) n++;
      wSave();
      wStatus('Logged ' + n + ' piece(s) as worn today.', 'on');
      renderWardrobe();
    });
    document.getElementById('wSugSave').addEventListener('click', () => {
      const name = prompt('Name this outfit:', s.items[0].name + ' combination');
      if (!name) return;
      wCreateOutfit(name.trim(), s.items.map(i => i.id), s.formality);
      wStatus('Saved as an outfit.', 'on');
      renderWardrobe();
    });
  }
}

function renderOutfits() {
  const outfits = wListOutfits();
  document.getElementById('wOutfits').innerHTML = outfits.length
    ? outfits.map(o =>
        '<div class="w-combo">' +
          '<div class="w-combo-head">' +
            '<b>' + esc(o.name) + '</b>' +
            '<span class="w-score">' + esc(wMoney(o.totalPrice)) + '</span>' +
          '</div>' +
          '<span class="w-meta">' + esc(o.items.map(i => i.name).join(', ') || 'no items') +
            (o.occasion ? ' · ' + esc(o.occasion) : '') + '</span>' +
          (o.blocked.length
            ? '<div class="w-finding gap">Not wearable right now: ' +
              esc(o.blocked.join(', ')) + '</div>'
            : '') +
          '<div class="w-form-btns" style="margin-top:8px">' +
            '<button class="w-save" data-owear="' + esc(o.id) + '">Wear today</button>' +
            '<button class="w-del" data-odel="' + esc(o.id) + '">Delete</button>' +
          '</div>' +
        '</div>').join('')
    : '<div class="empty-msg">No saved outfits yet. Build one from a suggestion ' +
      'or a combination above.</div>';
}

function renderRules() {
  const rules = (wardrobe.rules || []).filter(r => !r.deleted);
  const active = wActiveRules().length;
  document.getElementById('wRuleCount').textContent =
    rules.length ? active + ' of ' + rules.length + ' in effect' : 'none yet';

  document.getElementById('wRules').innerHTML = rules.length
    ? rules.map(r =>
        '<div class="w-row">' +
          '<span>' +
            '<b style="color:' + (r.verdict === 'avoid' ? '#c0392b' : '#1a7f37') + '">' +
              esc(r.colourA) + ' + ' + esc(r.colourB) + '</b> ' +
            esc(r.text || '') +
          '</span>' +
          '<b><label style="font-weight:400;font-size:10.5px">' +
            '<input type="checkbox" data-rule="' + esc(r.id) + '"' +
              (r.active !== false ? ' checked' : '') + '> on</label> ' +
            '<button data-ruledel="' + esc(r.id) + '" style="border:none;background:none;' +
              'cursor:pointer;color:#bbb">✕</button>' +
          '</b>' +
        '</div>').join('')
    : '<div class="empty-msg">No style rules yet. Paste notes below, or add a pair by hand.</div>';
}

// ─── Wear history, inside the item form ───────────────────────────────────────

function renderWearHistory(itemId) {
  const wrap = document.getElementById('wHistory');
  if (!itemId) { wrap.innerHTML = ''; return; }
  const hist = wWearHistory(itemId);
  wrap.innerHTML =
    '<label class="w-label" style="margin-top:10px">Wear history (' + hist.length + ')</label>' +
    '<div class="w-bar">' +
      '<input class="w-input grow" type="date" id="wHistDate" value="' + esc(wToday()) + '">' +
      '<button class="ghost" id="wHistAdd">Log that date</button>' +
    '</div>' +
    (hist.length
      ? hist.slice(0, 12).map(w => '<div class="w-row"><span>' + esc(w.wornOn) +
          (w.source && w.source !== 'manual' ? ' · ' + esc(w.source) : '') + '</span>' +
          '<b><button data-weardel="' + esc(w.id) + '" style="border:none;background:none;' +
          'cursor:pointer;color:#bbb">✕</button></b></div>').join('')
      : '<div class="empty-msg">Never worn.</div>');

  document.getElementById('wHistAdd').addEventListener('click', () => {
    const d = document.getElementById('wHistDate').value;
    if (!d) return;
    if (wLogWearOn(itemId, d, 'manual')) {
      wSave();
      wStatus('Logged a wear on ' + d + '.', 'on');
    } else {
      wStatus('That date is already logged.', 'err');
    }
    renderWearHistory(itemId);
    renderItems();
  });

  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-weardel]');
    if (!b) return;
    wRemoveWear(b.dataset.weardel);
    renderWearHistory(itemId);
    renderItems();
  }, { once: true });
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

for (const t of ['items', 'insights', 'plan', 'style']) {
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

document.getElementById('wSearch').addEventListener('input', renderItems);

for (const id of ['wSugFormality', 'wSugTemp', 'wSugRain']) {
  document.getElementById(id).addEventListener('change', renderSuggest);
}

// Outfit rows are rebuilt on every render, so their buttons are delegated.
document.getElementById('wOutfits').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-owear],button[data-odel]');
  if (!b) return;
  if (b.dataset.owear) {
    const n = wWearOutfit(b.dataset.owear);
    wStatus(n ? 'Logged ' + n + ' piece(s) as worn today.' : 'Already logged today.',
            n ? 'on' : 'err');
  } else {
    wDeleteOutfit(b.dataset.odel);
    wStatus('Outfit deleted.', 'on');
  }
  renderWardrobe();
});

document.getElementById('wRules').addEventListener('click', (e) => {
  const del = e.target.closest('button[data-ruledel]');
  if (del) {
    const r = (wardrobe.rules || []).find(x => x.id === del.dataset.ruledel);
    if (r) { r.deleted = true; r.updatedAt = Date.now(); wSave(); }
    renderRules();
  }
});
document.getElementById('wRules').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-rule]');
  if (!cb) return;
  const r = (wardrobe.rules || []).find(x => x.id === cb.dataset.rule);
  if (r) { r.active = cb.checked; r.updatedAt = Date.now(); wSave(); }
  renderRules();
});

document.getElementById('wRuleAdd').addEventListener('click', () => {
  const a = wNormalise(document.getElementById('wRuleA').value);
  const b = wNormalise(document.getElementById('wRuleB').value);
  if (!a || !b) return wStatus('Enter two colours.', 'err');
  if (a === b) return wStatus('Those are the same colour.', 'err');
  wAddSource('Added by hand', [{
    colourA: a, colourB: b,
    verdict: document.getElementById('wRuleVerdict').value,
    text: document.getElementById('wRuleText').value.trim(),
    weight: 1, origin: 'manual',
  }], 'manual');
  document.getElementById('wRuleA').value = '';
  document.getElementById('wRuleB').value = '';
  document.getElementById('wRuleText').value = '';
  wStatus('Rule added — it now affects the combination ranking.', 'on');
  renderRules();
});

async function learnRules(useAI) {
  if (wBusy) return;
  const text = document.getElementById('wRuleNotes').value.trim();
  if (!text) return wStatus('Paste some notes first.', 'err');

  wBusy = true;
  try {
    wStatus(useAI ? 'Reading the notes with Gemini…' : 'Scanning for colour pairs…');
    const rules = useAI ? await wExtractRulesAI(text) : wExtractRulesOffline(text);
    if (!rules.length) {
      wStatus('No colour pairings found in that text.', 'err');
      return;
    }
    const title = text.split('\n')[0].slice(0, 80) || 'Pasted notes';
    wAddSource(title, rules, useAI ? 'ai' : 'heuristic');
    document.getElementById('wRuleNotes').value = '';
    wStatus('Learned ' + rules.length + ' rule(s). They now affect the ranking.', 'on');
    renderRules();
  } catch (e) {
    wStatus(e.message, 'err');
  } finally {
    wBusy = false;
  }
}
document.getElementById('wRuleLearnAI').addEventListener('click', () => learnRules(true));
document.getElementById('wRuleLearnOffline').addEventListener('click', () => learnRules(false));

document.getElementById('wExportCsv').addEventListener('click', () => {
  wDownload('wardrobe-' + wToday() + '.csv', wExportCsv(), 'text/csv');
  wStatus('CSV exported.', 'on');
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
