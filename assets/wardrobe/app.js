'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
let META = { categories: [], statuses: [], formalities: [], seasons: [] };
const picked = new Set();

/* ---------- helpers ---------- */

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error((body && body.error) || res.statusText);
  return body;
}
const get = (p) => api(p);
const post = (p, b) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b || {}),
});
const del = (p) => api(p, { method: 'DELETE' });

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2200);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(v, cur) {
  if (v === null || v === undefined || v === '') return '—';
  const sym = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[cur || 'INR'] || '';
  return sym + Number(v).toLocaleString('en-IN',
    { maximumFractionDigits: Number(v) % 1 ? 2 : 0 });
}

function fillSelect(el, values, { blank = null, selected = null } = {}) {
  if (!el) return;
  el.innerHTML = (blank ? `<option value="">${esc(blank)}</option>` : '')
    + values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

/* ---------- tabs ---------- */

function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  const loaders = {
    closet: loadCloset, outfits: loadOutfits, insights: loadInsights,
    photos: loadPhotos, data: loadData, style: loadStyle, settings: loadSettings,
    plan: loadCombos,
  };
  if (loaders[name]) loaders[name]();
}

$$('#tabs button').forEach((btn) =>
  btn.addEventListener('click', () => showTab(btn.dataset.tab)));

document.addEventListener('click', (ev) => {
  const link = ev.target.closest('[data-goto]');
  if (link) { ev.preventDefault(); showTab(link.dataset.goto); }
});

/* ---------- closet ---------- */

/* Swatch colours mirror lib/colour.py so a photo-less item still reads as
   the right colour instead of showing an empty box. */
const SWATCH = {
  black: '#1a1a1a', charcoal: '#36363a', grey: '#808084', gray: '#808084',
  silver: '#c0c0c4', white: '#f5f5f3', 'off-white': '#eeeae2', ivory: '#f0ead6',
  cream: '#ece2c8', beige: '#d6c4a8', tan: '#c6a67a', camel: '#ba9466',
  khaki: '#b0a076', taupe: '#96887c', brown: '#6c4c36', chocolate: '#4a3426',
  navy: '#202e54', blue: '#2e58a8', sky: '#84b4e2', indigo: '#3e467e',
  denim: '#526a92', teal: '#247a7a', turquoise: '#40bab6', green: '#3c8048',
  olive: '#6c703e', sage: '#96a88e', mint: '#a8d6bc', forest: '#264e34',
  yellow: '#e8c842', mustard: '#c69e30', amber: '#dea83e', orange: '#e07e34',
  coral: '#e8806c', peach: '#eeb294', rust: '#b05634', terracotta: '#bc6c50',
  red: '#c2302e', maroon: '#6c222e', burgundy: '#622030', wine: '#70283a',
  pink: '#e898b0', blush: '#e8bebe', rose: '#ce7a88', 'dusty-rose': '#bc8e92',
  mauve: '#a27c86', purple: '#6e4292', lavender: '#baa8dc', plum: '#6e3e60',
  magenta: '#ba3684', gold: '#c9a227',
};

/* Mirrors normalise() in lib/colour.py: reduce "Dark Navy Blue" to "navy" so a
   multi-word colour still gets its swatch instead of falling through to blank. */
function colourKey(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  if (SWATCH[text]) return text;
  const words = text.split(/[\s\-/]+/).filter(Boolean);
  for (const w of words) if (SWATCH[w]) return w;
  const names = Object.keys(SWATCH).sort((a, b) => b.length - a.length);
  for (const w of words) for (const n of names) if (w.includes(n)) return n;
  return '';
}

function swatchMarkup(it, big, label) {
  const key = colourKey(it.colour);
  const hex = SWATCH[key];
  if (hex) {
    return `<div class="swatch" style="--c:${hex}">
      <span>${esc(it.colour)}</span>${big ? `<em>${label}</em>` : ''}</div>`;
  }
  return `<div class="swatch none"><span>${esc(label)}</span></div>`;
}

function thumb(it, big) {
  if (it.photo_path) {
    // A path outside an imported folder returns 403, which would otherwise
    // render as a broken-image icon. Fall back to the colour swatch instead.
    const fallback = swatchMarkup(it, big, 'photo unavailable')
      .replace(/"/g, '&quot;');
    return `<img loading="lazy" src="${it.photo_path}"
      alt="" onerror="this.outerHTML='${fallback.replace(/'/g, "\\'").replace(/\n\s*/g, ' ')}'">`;
  }
  return swatchMarkup(it, big, 'no photo attached');
}

const selectedItems = new Set();

function itemCard(it) {
  const picked = selectedItems.has(String(it.id));
  return `<div class="card tile-card${picked ? ' picked' : ''}" data-id="${it.id}"
      tabindex="0" role="button">
    <div class="shot">${thumb(it)}
      <span class="pill ${esc(it.status)}">${esc(it.status)}</span>
      <label class="pick" title="Select"><input type="checkbox"
        data-pick="${it.id}"${picked ? ' checked' : ''}></label>
      <button class="kebab" data-menu="${it.id}" aria-label="More actions">⋮</button>
      <div class="menu" data-menu-for="${it.id}" hidden>
        <button data-act="open" data-id="${it.id}">Open</button>
        <button data-act="wear" data-id="${it.id}">Wore it today</button>
        <button data-act="del" data-id="${it.id}">Delete…</button>
      </div>
    </div>
    <div class="tile-title">${esc(it.name)}</div>
    <div class="tile-sub">${[it.brand, it.subcategory || it.category]
      .filter(Boolean).map(esc).join(' · ')}</div>
  </div>`;
}

function updateSelBar() {
  const n = selectedItems.size;
  $('#sel-bar').hidden = n === 0;
  $('#sel-count').textContent = n === 1 ? '1 item selected' : `${n} items selected`;
}

function closeMenus() {
  $$('#grid .menu').forEach((m) => { m.hidden = true; });
}

/* Deleting is permanent and takes the wear history with it, so always name what
   is about to go and ask once. */
async function deleteItems(ids) {
  ids = ids.map(String).filter(Boolean);
  if (!ids.length) return;
  const names = [];
  for (const id of ids) {
    try { names.push((await get('/api/items/' + id)).name); } catch { names.push('#' + id); }
  }
  const shown = names.slice(0, 6).join('\n• ');
  const more = names.length > 6 ? `\n…and ${names.length - 6} more` : '';
  if (!confirm(`Delete ${ids.length} item(s) permanently?\n\n• ${shown}${more}\n\n`
    + 'Their wear history goes too. This cannot be undone.')) return;
  for (const id of ids) await del('/api/items/' + id);
  ids.forEach((id) => selectedItems.delete(id));
  toast(`Deleted ${ids.length} item(s).`);
  updateSelBar();
  loadCloset();
}

/* ---------- item detail ---------- */

let detailId = null;

function row(label, value, cls) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><th>${esc(label)}</th><td class="${cls || ''}">${value}</td></tr>`;
}

async function openDetail(id) {
  const it = await get('/api/items/' + id);
  if (!it || it.error) return;
  detailId = id;
  const history = await get(`/api/items/${id}/history`);

  const cpw = it.cost_per_wear === null
    ? (it.price ? '<span class="cpw bad">never worn</span>' : '—')
    : `<span class="cpw ${it.cost_per_wear <= 50 ? 'good' : it.cost_per_wear >= 500 ? 'bad' : ''}">
        ${money(it.cost_per_wear, it.currency)} per wear</span>`;

  $('#d-body').innerHTML = `
    <div class="shot big">${thumb(it, true)}</div>
    <h2 class="d-title">${esc(it.name)}</h2>

    <div class="d-actions">
      <button id="d-wear">Wore it today</button>
      <select id="d-status">${META.statuses.map((s) =>
        `<option${s === it.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
      ${it.photo_path ? `<button id="d-cutout" class="ghost">Make product image (free)</button>` : ''}
      ${it.photo_path ? `<button id="d-render" class="ghost">Redraw with AI</button>` : ''}
      ${it.photo_path ? `<button id="d-prompt" class="ghost">Copy AI Studio prompt</button>` : ''}
      <label class="btn ghost" style="cursor:pointer">Attach image…<input
        type="file" id="d-attach" accept="image/*" hidden></label>
    </div>
    <div id="d-render-msg" class="muted" style="text-align:center"></div>

    <table class="d-table">
      ${row('Brand', esc(it.brand))}
      ${row('Category', esc(it.category) + (it.subcategory ? ' / ' + esc(it.subcategory) : ''))}
      ${row('Colour', esc(it.colour))}
      ${row('Pattern', esc(it.pattern))}
      ${row('Material', esc(it.material))}
      ${row('Size', esc(it.size))}
      ${row('Formality', esc(it.formality))}
      ${row('Seasons', it.seasons.map(esc).join(', '))}
      ${row('Status', `<span class="pill ${esc(it.status)}">${esc(it.status)}</span>`)}
      ${row('Care', esc(it.care))}
    </table>

    <h3>Value</h3>
    <table class="d-table">
      ${row('Price', money(it.price, it.currency))}
      ${row('Cost per wear', cpw)}
      ${row('Times worn', it.wear_count)}
      ${row('Last worn', it.last_worn
        ? `${esc(it.last_worn)} <span class="muted">(${it.days_since_worn} days ago)</span>`
        : '<span class="muted">never</span>')}
      ${row('Bought', esc(it.purchase_date))}
    </table>

    ${it.notes ? `<h3>Notes</h3><p class="d-notes">${esc(it.notes)}</p>` : ''}

    ${history.length ? `<h3>Wear history <span class="muted">${history.length} entries</span></h3>
      <div class="chips">${history.slice(0, 40).map((h) =>
        `<span class="chip">${esc(h.worn_on)}</span>`).join('')}
      ${history.length > 40 ? `<span class="chip muted">+${history.length - 40} more</span>` : ''}</div>` : ''}

    ${it.photo_path ? `<p class="muted d-path">${esc(it.photo_path)}</p>` : ''}
  `;
  $('#detail').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  $('#detail').hidden = true;
  detailId = null;
  document.body.style.overflow = '';
}

$('#d-back').addEventListener('click', closeDetail);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#detail').hidden) closeDetail();
});

$('#d-del').addEventListener('click', async () => {
  if (!detailId) return;
  if (!confirm('Delete this item and its wear history permanently?')) return;
  await del('/api/items/' + detailId);
  closeDetail();
  toast('Deleted.');
  loadCloset();
});

$('#d-body').addEventListener('click', async (ev) => {
  // The free route: generate the image by hand in AI Studio, then attach it.
  if (ev.target.id === 'd-prompt' && detailId) {
    try {
      const r = await get('/api/render/prompt?item_id=' + detailId);
      let copied = false;
      try { await navigator.clipboard.writeText(r.prompt); copied = true; } catch { /* shown below */ }
      $('#d-render-msg').innerHTML =
        (copied ? 'Prompt copied. ' : 'Copy the prompt below. ')
        + 'Open <a href="https://aistudio.google.com/" target="_blank" rel="noopener">AI Studio</a>, '
        + `attach <a href="${esc(r.image_url)}" download target="_blank">this cutout</a>, `
        + 'paste the prompt, then save the picture and press <strong>Attach image…</strong>.'
        + (r.colour_hex ? ` Measured colour ${esc(r.colour_hex)}.` : '')
        + `<textarea rows="3" style="width:100%;margin-top:.4rem" readonly>${esc(r.prompt)}</textarea>`;
    } catch (err) {
      $('#d-render-msg').textContent = err.message;
    }
    return;
  }
  if (ev.target.id === 'd-cutout' && detailId) {
    const btn = ev.target;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Working…';
    $('#d-render-msg').textContent =
      'Cutting the garment out on this PC. No API call, no cost.';
    try {
      const r = await post('/api/photo/cutout', { item_id: detailId, single: false });
      $('#d-render-msg').textContent = r.note + ' ' + r.engine;
      toast('Product image made locally.');
      openDetail(detailId);
      loadCloset();
    } catch (err) {
      $('#d-render-msg').textContent = err.message;
      btn.disabled = false;
      btn.textContent = was;
    }
    return;
  }
  if (ev.target.id === 'd-render' && detailId) {
    const btn = ev.target;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Generating…';
    $('#d-render-msg').textContent =
      'Rebuilding this garment as a studio product shot. This takes a few seconds.';
    try {
      const r = await post('/api/photo/render', { item_id: detailId });
      $('#d-render-msg').textContent = r.note;
      toast('Product image generated.');
      openDetail(detailId);
      loadCloset();
    } catch (err) {
      $('#d-render-msg').textContent = err.message;
      btn.disabled = false;
      btn.textContent = was;
    }
    return;
  }
  if (ev.target.id !== 'd-wear' || !detailId) return;
  await post('/api/wear', { item_id: detailId });
  toast('Wear logged.');
  openDetail(detailId);
  loadCloset();
});

$('#d-body').addEventListener('change', async (ev) => {
  if (ev.target.id === 'd-attach' && detailId) {
    const file = ev.target.files[0];
    if (!file) return;
    $('#d-render-msg').textContent = 'Attaching…';
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const stored = await post('/api/photo/store',
          { data_b64: String(reader.result).split(',')[1] });
        await api('/api/items/' + detailId, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_path: stored.photo_path }),
        });
        toast('Image attached.');
        openDetail(detailId);
        loadCloset();
      } catch (err) {
        $('#d-render-msg').textContent = 'Could not attach: ' + err.message;
      }
    };
    reader.readAsDataURL(file);
    return;
  }
  if (ev.target.id !== 'd-status' || !detailId) return;
  await api('/api/items/' + detailId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: ev.target.value }),
  });
  toast('Status set to ' + ev.target.value + '.');
  loadCloset();
});

async function loadCloset() {
  const p = new URLSearchParams();
  if ($('#q').value.trim()) p.set('search', $('#q').value.trim());
  if ($('#f-category').value) p.set('category', $('#f-category').value);
  if ($('#f-status').value) p.set('status', $('#f-status').value);
  if ($('#f-formality').value) p.set('formality', $('#f-formality').value);
  if ($('#f-retired').checked) p.set('include_retired', '1');

  const items = await get('/api/items?' + p);
  $('#closet-count').textContent =
    `${items.length} item${items.length === 1 ? '' : 's'}`;
  $('#grid').innerHTML = items.length
    ? items.map(itemCard).join('')
    : '<div class="empty">Nothing here yet. Add an item, or run with --demo for sample data.</div>';
  // Drop selections for items that are no longer on screen.
  const shown = new Set(items.map((i) => String(i.id)));
  [...selectedItems].forEach((id) => { if (!shown.has(id)) selectedItems.delete(id); });
  updateSelBar();
}

$('#grid').addEventListener('click', async (ev) => {
  const kebab = ev.target.closest('[data-menu]');
  if (kebab) {
    const id = kebab.dataset.menu;
    const mine = $(`#grid .menu[data-menu-for="${id}"]`);
    const wasOpen = mine && !mine.hidden;
    closeMenus();
    if (mine) mine.hidden = wasOpen;
    return;
  }
  const act = ev.target.closest('.menu button');
  if (act) {
    closeMenus();
    const id = act.dataset.id;
    if (act.dataset.act === 'open') openDetail(id);
    else if (act.dataset.act === 'wear') {
      await post('/api/wear', { item_id: id });
      toast('Wear logged.');
      loadCloset();
    } else if (act.dataset.act === 'del') await deleteItems([id]);
    return;
  }
  if (ev.target.closest('.pick')) return;      // the checkbox speaks for itself
  const card = ev.target.closest('.tile-card');
  if (card) openDetail(card.dataset.id);
});

$('#grid').addEventListener('change', (ev) => {
  const cb = ev.target.closest('[data-pick]');
  if (!cb) return;
  const id = String(cb.dataset.pick);
  if (cb.checked) selectedItems.add(id); else selectedItems.delete(id);
  cb.closest('.tile-card').classList.toggle('picked', cb.checked);
  updateSelBar();
});

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.menu') && !ev.target.closest('[data-menu]')) closeMenus();
});

$('#sel-delete').addEventListener('click', () => deleteItems([...selectedItems]));
$('#sel-clear').addEventListener('click', () => {
  selectedItems.clear();
  updateSelBar();
  loadCloset();
});

$('#grid').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const card = ev.target.closest('.tile-card');
  if (card) { ev.preventDefault(); openDetail(card.dataset.id); }
});

['#q', '#f-category', '#f-status', '#f-formality', '#f-retired']
  .forEach((s) => $(s).addEventListener('input', loadCloset));

/* ---------- add ---------- */

let addBusy = false;

$('#add-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  // Guard against a second click while the first request is still in flight --
  // that is how you end up with two identical items seconds apart.
  if (addBusy) return;

  const form = ev.target;
  const data = Object.fromEntries(new FormData(form).entries());
  Object.keys(data).forEach((k) => { if (data[k] === '') delete data[k]; });

  if (!(data.name || '').trim()) {
    $('#add-msg').textContent = 'Give the item a name first.';
    form.querySelector('[name=name]').focus();
    return;
  }

  // Warn on an exact repeat rather than silently creating a twin.
  try {
    const same = await get('/api/items?search=' + encodeURIComponent(data.name.trim()));
    const exact = same.filter((i) =>
      i.name.trim().toLowerCase() === data.name.trim().toLowerCase());
    if (exact.length && !confirm(
        `You already have ${exact.length} item(s) called "${exact[0].name}". Add another?`)) {
      $('#add-msg').textContent = 'Not added — you already have that item.';
      return;
    }
  } catch { /* the duplicate check is advisory; never block the add on it */ }

  const btn = form.querySelector('button[type=submit]');
  addBusy = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Adding…';
  try {
    const item = await post('/api/items', data);
    form.reset();
    $('#add-form [name=currency]').value = 'INR';
    $('#add-msg').innerHTML =
      `Added <strong>${esc(item.name)}</strong>. `
      + `<a href="#" data-open-item="${item.id}">View it in the closet</a>`;
    toast('Added “' + item.name + '” to your wardrobe.');
    loadCloset();
  } catch (err) {
    $('#add-msg').textContent = 'Not added: ' + err.message;
  } finally {
    addBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* "View it in the closet" links appear in several panels, so handle them once. */
document.addEventListener('click', (ev) => {
  const link = ev.target.closest('[data-open-item]');
  if (!link) return;
  ev.preventDefault();
  openDetail(link.dataset.openItem);
});

/* ---------- outfits ---------- */

async function loadOutfits() {
  const items = await get('/api/items');
  $('#picker').innerHTML = items.map((i) => `
    <label><input type="checkbox" value="${i.id}"${picked.has(String(i.id)) ? ' checked' : ''}>
    ${esc(i.name)} <span class="muted">${esc(i.category)}</span></label>`).join('');
  $('#picked-count').textContent = picked.size;

  const outfits = await get('/api/outfits');
  $('#outfit-list').innerHTML = outfits.length ? outfits.map((o) => `
    <div class="card" style="margin-bottom:.6rem">
      <div class="top">
        <div><div class="name">${esc(o.name)}</div>
        <div class="meta">${esc(o.occasion || 'no occasion')} · ${o.items.length} pieces · ${money(o.total_price, 'INR')}</div></div>
        <div style="display:flex;gap:.3rem">
          <button class="tiny" data-wear="${o.id}">Wore this</button>
          <button class="tiny ghost" data-del="${o.id}">Delete</button>
        </div>
      </div>
      <div class="meta">${o.items.map((i) => esc(i.name)).join(' · ')}</div>
      ${o.blocked.length ? `<div class="meta" style="color:var(--warn)">Unavailable: ${o.blocked.map(esc).join(', ')}</div>` : ''}
    </div>`).join('')
    : '<div class="empty">No outfits saved yet.</div>';
}

$('#picker').addEventListener('change', (ev) => {
  if (ev.target.checked) picked.add(ev.target.value); else picked.delete(ev.target.value);
  $('#picked-count').textContent = picked.size;
});

$('#outfit-save').addEventListener('click', async () => {
  const name = $('#outfit-name').value.trim();
  if (!name) return ($('#outfit-msg').textContent = 'Give the outfit a name.');
  if (!picked.size) return ($('#outfit-msg').textContent = 'Pick at least one item.');
  try {
    await post('/api/outfits', {
      name, occasion: $('#outfit-occasion').value.trim(),
      item_ids: Array.from(picked),
    });
    picked.clear();
    $('#outfit-name').value = $('#outfit-occasion').value = '';
    $('#outfit-msg').textContent = '';
    toast('Outfit saved.');
    loadOutfits();
  } catch (err) { $('#outfit-msg').textContent = 'Error: ' + err.message; }
});

$('#outfit-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.dataset.wear) {
    const r = await post('/api/outfits/wear', { outfit_id: btn.dataset.wear });
    toast(`Logged a wear for ${r.logged} items.`);
  } else if (btn.dataset.del) {
    if (!confirm('Delete this outfit? The items stay in your wardrobe.')) return;
    await del('/api/outfits/' + btn.dataset.del);
    toast('Outfit deleted.');
  }
  loadOutfits();
});

/* ---------- photo upload ---------- */

/* Measure the garment colour from the image itself, in the browser.
   Sample a centre box (garments are centred, backgrounds are at the edges),
   drop near-white/near-black background pixels, and average what's left. */
function measureColour(img) {
  const N = 96;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, N, N);
  const lo = Math.floor(N * 0.28), hi = Math.ceil(N * 0.72);
  let px;
  try { px = cx.getImageData(lo, lo, hi - lo, hi - lo).data; }
  catch { return null; }

  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a < 200) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // Skip the flat light-grey product background these photos usually have.
    if (mx > 232 && mx - mn < 16) continue;
    if (mx < 18) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const e = buckets.get(key) || [0, 0, 0, 0];
    e[0] += r; e[1] += g; e[2] += b; e[3] += 1;
    buckets.set(key, e);
  }
  if (!buckets.size) return null;
  let best = null;
  for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e;
  return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]),
          Math.round(best[2] / best[3])];
}

function nearestName(rgb) {
  let best = null, bestD = Infinity;
  for (const [name, hex] of Object.entries(SWATCH)) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16),
          b = parseInt(hex.slice(5, 7), 16);
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/* Cut one garment out of the source photo.

   Gemini gives a box as [ymin,xmin,ymax,xmax]/1000 and, when it can, an outline
   polygon. We clip the canvas to that polygon so the result is a transparent
   cutout of the garment alone — the background, the person and everything else
   is discarded, which is what makes it read as a catalogue item rather than a
   snapshot. Without a polygon we fall back to a straight rectangular crop. */
function cropGarment(img, det) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const [ymin, xmin, ymax, xmax] = det.box_2d;
  const pad = 0.015;
  const x0 = Math.max(0, (xmin / 1000 - pad) * W);
  const y0 = Math.max(0, (ymin / 1000 - pad) * H);
  const x1 = Math.min(W, (xmax / 1000 + pad) * W);
  const y1 = Math.min(H, (ymax / 1000 + pad) * H);
  const cw = Math.max(1, Math.round(x1 - x0));
  const ch = Math.max(1, Math.round(y1 - y0));

  // Cap the long edge so uploads stay small without visible quality loss.
  const scale = Math.min(1, 900 / Math.max(cw, ch));
  const ow = Math.max(1, Math.round(cw * scale));
  const oh = Math.max(1, Math.round(ch * scale));

  const cv = document.createElement('canvas');
  cv.width = ow; cv.height = oh;
  const cx = cv.getContext('2d');

  const poly = (det.mask || []).map(([px, py]) => [px, py]);
  if (poly.length >= 6) {
    // The polygon may be in whole-image space or box-local space; pick whichever
    // interpretation actually lands the points inside the detected box.
    const insideImage = poly.filter(([px, py]) =>
      px >= xmin - 20 && px <= xmax + 20 && py >= ymin - 20 && py <= ymax + 20).length;
    const imageSpace = insideImage / poly.length >= 0.6;
    cx.beginPath();
    poly.forEach(([px, py], i) => {
      let ax, ay;
      if (imageSpace) {
        ax = (px / 1000 * W - x0) * scale;
        ay = (py / 1000 * H - y0) * scale;
      } else {
        ax = (px / 1000) * ow;
        ay = (py / 1000) * oh;
      }
      i ? cx.lineTo(ax, ay) : cx.moveTo(ax, ay);
    });
    cx.closePath();
    cx.clip();
  }
  cx.drawImage(img, x0, y0, cw, ch, 0, 0, ow, oh);

  // Measure the garment's own colour from the cut-out pixels only.
  let rgb = null;
  try {
    const d = cx.getImageData(0, 0, ow, oh).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;               // outside the cutout
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 238 && mx - mn < 14) continue;      // blown-out background
      if (mx < 16) continue;
      const k = `${r >> 4},${g >> 4},${b >> 4}`;
      const e = buckets.get(k) || [0, 0, 0, 0];
      e[0] += r; e[1] += g; e[2] += b; e[3]++;
      buckets.set(k, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e;
    if (best) rgb = [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]),
                     Math.round(best[2] / best[3])];
  } catch { /* tainted canvas is not possible here, but stay safe */ }

  return { dataUrl: cv.toDataURL('image/png'), rgb, cutout: poly.length >= 6 };
}

let drafts = [];
let photo = null;   // { img, dataUrl, path } for the photo currently on screen

/* Shrink before uploading. An 8 MB phone photo becomes an 11 MB base64 payload
   otherwise, which is slow and needlessly close to the size limit. */
function downscale(img, max = 1600) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) return null;
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.9);
}

$('#up-file').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  // Start clean, or drafts from a previous photo get added along with this one.
  drafts = [];
  photo = null;
  $('#up-msg').textContent = 'Reading the image…';
  $('#up-preview').innerHTML = '';
  $('#up-stage').innerHTML = '';
  $('#up-actions').hidden = true;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => preparePhoto(img, String(reader.result));
    img.onerror = () => { $('#up-msg').textContent = 'That file is not a readable image.'; };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
});

/* Store the photo straight away, then let the user choose what to do with it.
   Storing first means an upload is never lost, whatever they pick next. */
async function preparePhoto(img, rawDataUrl) {
  const dataUrl = downscale(img) || rawDataUrl;
  $('#up-stage').innerHTML =
    `<div class="stage"><img src="${dataUrl}" alt=""><div id="stage-boxes"></div></div>`;
  $('#up-msg').textContent = 'Saving the photo…';

  let path = '';
  try {
    const stored = await post('/api/photo/store', { data_b64: dataUrl.split(',')[1] });
    path = stored.photo_path;
  } catch (err) {
    $('#up-msg').textContent = 'The photo could not be saved: ' + err.message;
    return;
  }

  // Keep the full-resolution element for cropping; upload the smaller copy.
  const shown = new Image();
  shown.onload = () => { photo = { img: shown, dataUrl, path }; };
  shown.src = dataUrl;
  photo = { img, dataUrl, path };

  const hasAI = !!(META.ai && META.ai.configured);
  const hasLocal = !!(META.local_cutout && META.local_cutout.available);
  $('#act-split').hidden = !hasAI;
  $('#act-local').hidden = !hasLocal;
  $('#engine-note').innerHTML = hasLocal
    ? 'Local engine ready (<code>' + esc(META.local_cutout.engine) + '</code>) — '
      + 'garment extraction runs on this PC and costs nothing. '
      + (hasAI ? 'Gemini is only used if you ask for it.' : '')
    : ((META.local_cutout && META.local_cutout.hint) ||
       'Automatic garment extraction is not available here.');
  $('#up-actions').hidden = false;
  $('#up-msg').innerHTML = hasLocal
    ? 'Photo saved. <strong>Extract garments</strong> runs on this PC for free and handles '
      + 'most photos — try it first.'
    : 'Photo saved. Crop by hand or use the whole photo, or install the local engine '
      + 'for free automatic extraction.';
}

$('#act-whole').addEventListener('click', () => {
  if (!photo) return;
  const rgb = measureColour(photo.img);
  const colour = rgb ? nearestName(rgb) : '';
  drafts.push({
    name: colour ? colour.charAt(0).toUpperCase() + colour.slice(1) + ' item' : '',
    category: 'top', subcategory: '', colour, pattern: '', material: '',
    formality: 'casual', seasons: 'all-season', care: '', notes: '',
    confidence: 0.3, preview: photo.dataUrl, cutout: false,
    measured: colour, rgb, photo_path: photo.path, include: true,
  });
  $('#up-msg').textContent =
    'Added as one item using the whole photo. Fill in the details, then add it.';
  renderDrafts();
  $('#up-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('#act-crop').addEventListener('click', () => {
  if (!photo) return;
  manualCrop(photo.img, photo.dataUrl);
});

/* The free path: rembg's clothing segmenter runs on this machine. It removes
   the person and the background AND separates upper/lower garments, so for most
   photos no API call is needed at all. */
$('#act-local').addEventListener('click', async () => {
  if (!photo) return;
  const btn = $('#act-local');
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Extracting…';
  $('#up-msg').textContent =
    'Cutting the garments out on this PC. First run loads the model, which takes a moment.';
  try {
    const r = await post('/api/photo/cutout',
      { data_b64: photo.dataUrl.split(',')[1] });
    if (!r.items.length) {
      $('#up-msg').textContent = r.note + ' Try cropping by hand instead.';
    } else {
      drafts = r.items.map((g) => {
        const a = g.attrs || {};
        const colour = g.colour_rgb ? nearestName(g.colour_rgb) : '';
        const second = a.secondary_rgb ? nearestName(a.secondary_rgb) : '';
        // Build a readable name from what was actually measured.
        const name = [
          colour ? colour.charAt(0).toUpperCase() + colour.slice(1) : '',
          a.pattern && a.pattern !== 'solid' ? a.pattern : '',
          a.sleeve || '',
          a.subcategory || (g.category === 'bottom' ? 'bottoms' : g.category),
        ].filter(Boolean).join(' ');
        const notes = [a.details || '', second ? 'contrast colour: ' + second : '']
          .filter(Boolean).join('; ');
        return {
          name,
          category: g.category,
          subcategory: a.subcategory || '',
          colour,
          pattern: a.pattern || '',
          material: a.material || '',
          formality: a.formality || 'casual',
          seasons: 'all-season',
          care: a.material && /cotton/.test(a.material)
            ? 'machine wash cold' : '',
          notes,
          confidence: a.confidence || (g.coverage ? Math.min(0.9, 0.4 + g.coverage) : 0.5),
          preview: g.data_url, photo_path: g.photo_path,
          cutoutPath: g.cutout_path || null,
          cutout: true, rendered: true, local: true,
          measured: colour, rgb: g.colour_rgb, include: true,
          renderNote: r.engine,
        };
      });
      $('#up-msg').textContent = `${r.note} (${r.engine})`;
      renderDrafts();
      $('#up-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    $('#up-msg').innerHTML = esc(err.message)
      + ' <a href="#" data-goto="settings">See Settings</a> for how to enable it.';
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
});

$('#act-split').addEventListener('click', () => {
  if (photo) splitPhoto(photo.img, photo.dataUrl);
});

async function splitPhoto(img, dataUrl) {
  $('#up-msg').textContent = 'Finding the individual garments…';
  let res;
  try {
    res = await post('/api/photo/detect', { data_b64: dataUrl.split(',')[1] });
  } catch (err) {
    $('#up-msg').textContent = err.message
      + ' Use the whole photo, or crop a garment by hand.';
    return;
  }
  if (!res.items.length) {
    $('#up-msg').textContent = res.note
      + ' Use the whole photo, or crop a garment by hand.';
    return;
  }

  // Outline what was found, on the photo itself.
  $('#stage-boxes').innerHTML = res.items.map((d, i) => {
    const [y0, x0, y1, x1] = d.box_2d;
    return `<span class="bbox" style="left:${x0 / 10}%;top:${y0 / 10}%;
      width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%"><b>${i + 1}</b></span>`;
  }).join('');

  $('#up-msg').textContent = `${res.note} Cutting them out…`;
  drafts = [];
  for (const det of res.items) {
    const cut = cropGarment(img, det);
    let stored = null;
    try {
      stored = await post('/api/photo/store', { data_b64: cut.dataUrl.split(',')[1] });
    } catch { /* fall back to the whole photo rather than losing the image */ }
    drafts.push({
      ...det,
      preview: cut.dataUrl,
      cutout: cut.cutout,
      measured: cut.rgb ? nearestName(cut.rgb) : '',
      rgb: cut.rgb,
      photo_path: stored ? stored.photo_path : (photo ? photo.path : ''),
      include: true,
    });
  }
  $('#up-msg').textContent =
    `${drafts.length} garment(s) separated from one photo. Review and edit, then add.`;
  renderDrafts();

  if ($('#up-render').checked) await renderAllDrafts();
}

/* Rebuild each cropped garment as a studio product shot, one at a time so the
   user sees them appear rather than staring at a spinner. */
async function renderAllDrafts() {
  for (let i = 0; i < drafts.length; i++) {
    if (drafts[i].rendered) continue;
    $('#up-msg').textContent =
      `Making a product image for ${drafts[i].name || 'garment ' + (i + 1)} (${i + 1}/${drafts.length})…`;
    await renderDraft(i);
  }
  const done = drafts.filter((d) => d.rendered).length;
  $('#up-msg').textContent = done
    ? `${done} of ${drafts.length} garment(s) rebuilt as product images. Review, then add.`
    : 'Could not generate product images; the crops are used instead.';
  renderDrafts();
}

async function renderDraft(i) {
  const d = drafts[i];
  const desc = [d.name, d.colour, d.material, d.pattern, d.notes]
    .filter(Boolean).join(', ');
  // Prefer the transparent cutout: the generator should see the garment alone,
  // not the grey studio card and the shadow drawn under it.
  const payload = d.cutoutPath
    ? { source_path: d.cutoutPath, description: desc }
    : { data_b64: (d.preview || '').split(',')[1], description: desc };
  if (!payload.source_path && !payload.data_b64) return;
  try {
    const r = await post('/api/photo/render', payload);
    d.preview = r.data_url;
    d.photo_path = r.photo_path;
    d.rendered = true;
    d.renderNote = r.note;
  } catch (err) {
    d.renderNote = err.message;
  }
}

function renderDrafts() {
  if (!drafts.length) { $('#up-preview').innerHTML = ''; return; }
  $('#up-preview').innerHTML = `
    <div class="review-grid">
      ${drafts.map((d, i) => `
        <div class="review${d.include ? '' : ' off'}" data-i="${i}">
          <div class="shot"><img src="${d.preview}" alt=""></div>
          <label class="chk inc"><input type="checkbox" data-inc="${i}"
            ${d.include ? 'checked' : ''}> add this one</label>
          <div class="rfields">
            <label>Name<input data-f="name" value="${esc(d.name)}"></label>
            <label>Category<select data-f="category">${META.categories.map((c) =>
              `<option${c === d.category ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
            <label>Subcategory<input data-f="subcategory" value="${esc(d.subcategory)}"></label>
            <label>Colour<input data-f="colour" value="${esc(d.colour)}"></label>
            <label>Pattern<input data-f="pattern" value="${esc(d.pattern)}"></label>
            <label>Material<input data-f="material" value="${esc(d.material)}"></label>
            <label>Brand<input data-f="brand" value="${esc(d.brand || '')}" placeholder="not visible"></label>
            <label>Size<input data-f="size" value="${esc(d.size || '')}" placeholder="not visible"></label>
            <label>Price<input data-f="price" type="number" step="0.01"
              value="${esc(d.price || '')}" placeholder="optional"></label>
            <label>Formality<select data-f="formality">${META.formalities.map((c) =>
              `<option${c === d.formality ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
            <label>Seasons<select data-f="seasons">${META.seasons.map((c) =>
              `<option${c === d.seasons ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
            <label>Care<input data-f="care" value="${esc(d.care || '')}"></label>
            <label class="wide">Details<textarea data-f="notes" rows="2">${esc(d.notes || '')}</textarea></label>
          </div>
          <div class="rmeta">
            ${d.photo_path ? '' : '<span class="tagbad">no image will be saved</span>'}
            ${d.local ? '<span class="tagok">studio image, made locally (free)</span>'
              : d.rendered ? '<span class="tagok">studio product image (AI)</span>'
              : d.cutout ? '<span class="tagwarn">outline cutout, not rebuilt</span>'
                         : '<span class="tagwarn">plain crop, not rebuilt</span>'}
            <button class="tiny ghost" data-prompt="${i}">Copy AI Studio prompt</button>
            <label class="btn ghost tiny" style="cursor:pointer">Attach AI image…<input
              type="file" accept="image/*" data-attach="${i}" hidden></label>
            ${META.ai && META.ai.configured
              ? `<button class="tiny ghost" data-render="${i}">${d.rendered
                  ? 'Regenerate' : 'Make product image'}</button>` : ''}
            ${d.rgb ? `<span>measured <span class="dot" style="--c:rgb(${d.rgb.join(',')})"></span>
              ${esc(d.measured)}</span>` : ''}
            <span>confidence ${Math.round((d.confidence ?? 0.7) * 100)}%</span>
          </div>
        </div>`).join('')}
    </div>
    <div class="bar" style="margin-top:.8rem">
      <button id="drafts-add">Add <span id="drafts-n">${drafts.filter((d) => d.include).length}</span> item(s) to wardrobe</button>
      <button id="drafts-discard" class="ghost">Discard all</button>
    </div>`;
}

$('#up-preview').addEventListener('input', (ev) => {
  const card = ev.target.closest('.review');
  if (!card || !ev.target.dataset.f) return;
  drafts[card.dataset.i][ev.target.dataset.f] = ev.target.value;
});

$('#up-preview').addEventListener('change', (ev) => {
  // The picture generated in AI Studio, dropped back onto its garment card.
  const at = ev.target.dataset.attach;
  if (at !== undefined) {
    const file = ev.target.files[0];
    if (!file) return;
    const d = drafts[Number(at)];
    $('#up-msg').textContent = 'Attaching…';
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const stored = await post('/api/photo/store',
          { data_b64: String(reader.result).split(',')[1] });
        d.preview = String(reader.result);
        d.photo_path = stored.photo_path;
        d.rendered = true;
        d.local = false;
        $('#up-msg').textContent =
          'Image attached to this garment. Add it to the wardrobe when ready.';
        renderDrafts();
      } catch (err) {
        $('#up-msg').textContent = 'Could not attach: ' + err.message;
      }
    };
    reader.readAsDataURL(file);
    return;
  }
  const inc = ev.target.dataset.inc;
  if (inc === undefined) return;
  drafts[inc].include = ev.target.checked;
  ev.target.closest('.review').classList.toggle('off', !ev.target.checked);
  $('#drafts-n').textContent = drafts.filter((d) => d.include).length;
});

$('#up-preview').addEventListener('click', async (ev) => {
  // Free route: hand over the prompt and the cutout, generate in AI Studio.
  const pb = ev.target.closest('[data-prompt]');
  if (pb) {
    const d = drafts[Number(pb.dataset.prompt)];
    const src = d.cutoutPath || d.photo_path;
    if (!src) {
      $('#up-msg').textContent = 'This garment has no saved image yet.';
      return;
    }
    const desc = [d.name, d.colour, d.material, d.pattern].filter(Boolean).join(', ');
    try {
      const r = await get('/api/render/prompt?source_path=' + encodeURIComponent(src)
        + '&description=' + encodeURIComponent(desc));
      let copied = false;
      try { await navigator.clipboard.writeText(r.prompt); copied = true; } catch { /* shown below */ }
      $('#up-msg').innerHTML = (copied ? 'Prompt copied. ' : 'Copy the prompt below. ')
        + 'Open <a href="https://aistudio.google.com/" target="_blank" rel="noopener">AI Studio</a>, '
        + `attach <a href="${esc(r.image_url)}" download target="_blank">this cutout</a>, `
        + 'paste the prompt, generate, save the picture, then press '
        + '<strong>Attach AI image…</strong> on that card.'
        + (r.colour_hex ? ` Measured colour ${esc(r.colour_hex)}.` : '')
        + `<textarea rows="3" style="width:100%;margin-top:.4rem" readonly>${esc(r.prompt)}</textarea>`;
    } catch (err) {
      $('#up-msg').textContent = err.message;
    }
    return;
  }
  const rb = ev.target.closest('[data-render]');
  if (rb) {
    const i = Number(rb.dataset.render);
    rb.disabled = true;
    rb.textContent = 'Generating…';
    await renderDraft(i);
    $('#up-msg').textContent = drafts[i].renderNote || '';
    renderDrafts();
    return;
  }
  if (ev.target.id === 'drafts-discard') {
    drafts = [];
    $('#up-preview').innerHTML = '';
    $('#up-stage').innerHTML = '';
    $('#up-msg').textContent = '';
    $('#up-file').value = '';
    return;
  }
  if (ev.target.id !== 'drafts-add') return;
  if (addBusy) return;
  const picked = drafts.filter((d) => d.include).map((d) => ({
    name: d.name, category: d.category, subcategory: d.subcategory,
    colour: d.colour, pattern: d.pattern, material: d.material,
    brand: d.brand || '', size: d.size || '', care: d.care || '',
    price: d.price ? Number(d.price) : undefined,
    formality: d.formality, seasons: d.seasons, notes: d.notes || '',
    photo_path: d.photo_path, source: 'photo',
    confidence: d.confidence, purchase_date: new Date().toISOString().slice(0, 10),
  }));
  if (!picked.length) return toast('Tick at least one garment.');
  addBusy = true;
  ev.target.disabled = true;
  ev.target.textContent = 'Adding…';
  try {
    const r = await post('/api/items/batch', { items: picked });
    toast(`Added ${r.created.length} item(s).`);
    $('#up-msg').innerHTML =
      `Added <strong>${r.created.length}</strong> item(s) to your wardrobe: `
      + r.created.map((i) => `<a href="#" data-open-item="${i.id}">${esc(i.name)}</a>`).join(', ')
      + (r.failed.length
        ? ` <span style="color:var(--bad)">${r.failed.length} could not be added: `
          + r.failed.map((f) => esc(f.error)).join('; ') + '</span>'
        : '');
    drafts = [];
    $('#up-preview').innerHTML = '';
    $('#up-stage').innerHTML = '';
    $('#up-file').value = '';
    loadCloset();
  } catch (err) {
    $('#up-msg').textContent = 'Could not add: ' + err.message;
    ev.target.disabled = false;
    ev.target.textContent = 'Add item(s) to wardrobe';
  } finally {
    addBusy = false;
  }
});

/* ---- manual crop: the offline path, and the fallback when AI finds nothing ---- */
function manualCrop(img, dataUrl) {
  const stage = $('#up-stage .stage');
  if (!stage || stage.dataset.bound) return;   // never bind the handlers twice
  stage.dataset.bound = '1';
  stage.classList.add('cropping');
  stage.insertAdjacentHTML('beforeend',
    '<div class="selbox" hidden></div>');
  const sel = stage.querySelector('.selbox');
  $('#up-msg').textContent =
    'Drag a box around ONE garment, then release to crop it out. '
    + 'Repeat for each garment in the photo.';

  let sx = 0, sy = 0, active = false;
  const pct = (ev) => {
    const r = stage.getBoundingClientRect();
    return [Math.min(100, Math.max(0, (ev.clientX - r.left) / r.width * 100)),
            Math.min(100, Math.max(0, (ev.clientY - r.top) / r.height * 100))];
  };
  stage.addEventListener('pointerdown', (ev) => {
    active = true; [sx, sy] = pct(ev); sel.hidden = false;
    sel.style.cssText = `left:${sx}%;top:${sy}%;width:0;height:0`;
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!active) return;
    const [cx, cy] = pct(ev);
    sel.style.cssText = `left:${Math.min(sx, cx)}%;top:${Math.min(sy, cy)}%;
      width:${Math.abs(cx - sx)}%;height:${Math.abs(cy - sy)}%`;
  });
  stage.addEventListener('pointerup', async (ev) => {
    if (!active) return;
    active = false;
    const [cx, cy] = pct(ev);
    const box = [Math.min(sy, cy) * 10, Math.min(sx, cx) * 10,
                 Math.max(sy, cy) * 10, Math.max(sx, cx) * 10];
    if (box[2] - box[0] < 20 || box[3] - box[1] < 20) {
      $('#up-msg').textContent = 'That box was too small — drag a bigger one.';
      sel.hidden = true;
      return;
    }
    const cut = cropGarment(img, { box_2d: box, mask: [] });
    let stored = null;
    try {
      stored = await post('/api/photo/store', { data_b64: cut.dataUrl.split(',')[1] });
    } catch { /* fall back to the whole photo rather than losing the image */ }
    const colour = cut.rgb ? nearestName(cut.rgb) : '';
    drafts.push({
      name: colour ? colour.charAt(0).toUpperCase() + colour.slice(1) + ' item' : '',
      category: 'top', subcategory: '', colour, pattern: '', material: '',
      formality: 'casual', seasons: 'all-season', care: '', notes: '',
      confidence: 0.3, preview: cut.dataUrl, cutout: false,
      measured: colour, rgb: cut.rgb,
      photo_path: stored ? stored.photo_path : (photo ? photo.path : ''),
      include: true,
    });
    sel.hidden = true;
    $('#up-msg').textContent =
      `${drafts.length} garment(s) cropped. Drag another box, or add them below.`;
    renderDrafts();
  });
}

/* ---------- product link import ---------- */

let productDraft = null;

$('#prod-go').addEventListener('click', async () => {
  const url = $('#prod-url').value.trim();
  if (!url) return ($('#prod-msg').textContent = 'Paste a product link first.');
  $('#prod-msg').textContent = 'Fetching…';
  $('#prod-preview').innerHTML = '';
  try {
    const d = await post('/api/product/preview',
      { url, use_ai: $('#prod-ai').checked });
    productDraft = d;
    const rows = [
      ['Name', d.name], ['Brand', d.brand], ['Category', d.category],
      ['Subcategory', d.subcategory], ['Colour', d.colour], ['Pattern', d.pattern],
      ['Material', d.material], ['Size', d.size], ['Formality', d.formality],
      ['Seasons', d.seasons],
      ['Price', d.price ? money(d.price, d.currency) : ''],
    ].filter(([, v]) => v);
    $('#prod-msg').textContent = (d._notes || []).join(' ');
    $('#prod-preview').innerHTML = `
      <div class="draft">
        ${d.image_url ? `<img src="${esc(d.image_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div style="flex:1">
          <table>${rows.map(([k, v]) =>
            `<tr><th style="width:8rem">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
          <p class="muted" style="margin:.5rem 0 0">This is a draft. Confirm to load it into
          the form below, then edit anything before saving.</p>
          <div class="bar" style="margin-top:.5rem">
            <button id="prod-confirm">Confirm &amp; edit in form</button>
            <button id="prod-discard" class="ghost">Discard</button>
          </div>
        </div>
      </div>`;
  } catch (err) {
    $('#prod-msg').textContent = 'Could not read that page: ' + err.message;
  }
});

$('#prod-preview').addEventListener('click', (ev) => {
  if (ev.target.id === 'prod-discard') {
    productDraft = null;
    $('#prod-preview').innerHTML = '';
    $('#prod-msg').textContent = '';
    return;
  }
  if (ev.target.id !== 'prod-confirm' || !productDraft) return;
  const d = productDraft;
  const form = $('#add-form');
  const setIf = (field, value) => {
    const el = form.querySelector(`[name=${field}]`);
    if (el && value !== undefined && value !== null && value !== '') el.value = value;
  };
  ['name', 'brand', 'category', 'subcategory', 'colour', 'pattern', 'material',
   'size', 'formality', 'seasons', 'price', 'currency', 'care'].forEach(
    (f) => setIf(f, d[f]));
  const notes = [d.notes, d.source_url ? 'Bought from: ' + d.source_url : '']
    .filter(Boolean).join('\n\n');
  setIf('notes', notes);
  if (!form.querySelector('[name=purchase_date]').value) {
    form.querySelector('[name=purchase_date]').value =
      new Date().toISOString().slice(0, 10);
  }
  $('#prod-preview').innerHTML = '';
  $('#prod-msg').textContent = 'Loaded into the form — check the details, then press Add.';
  form.querySelector('[name=name]').focus();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Draft loaded — edit anything, then Add.');
});

$('#add-reset').addEventListener('click', () => {
  $('#add-form').reset();
  $('#add-form [name=currency]').value = 'INR';
  $('#add-msg').textContent = '';
});

/* ---------- style sources ---------- */

async function loadStyle() {
  const sources = await get('/api/style/sources');
  $('#style-list').innerHTML = sources.length ? sources.map((s) => `
    <div class="card" style="margin-bottom:.7rem">
      <div class="top">
        <div>
          <div class="name">${esc(s.title || s.url || 'Untitled source')}</div>
          <div class="meta">${esc(s.kind)} · ${s.rules.length} rule(s) ·
            ${s.origin === 'ai' ? 'read by Gemini' : 'offline pattern matching'}</div>
        </div>
        <div style="display:flex;gap:.3rem;align-items:center">
          <label class="chk"><input type="checkbox" data-src="${s.id}"
            ${s.active ? 'checked' : ''}> active</label>
          <button class="tiny ghost" data-delsrc="${s.id}">Delete</button>
        </div>
      </div>
      ${s.summary ? `<div class="meta">${esc(s.summary)}</div>` : ''}
      ${s.url ? `<div class="meta"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>` : ''}
      <div class="list" style="margin-top:.5rem">
        ${s.rules.map((r) => `<div class="line">
          <span>${r.verdict === 'avoid' ? '<span style="color:var(--bad)">avoid</span> ' : ''}
            ${r.colour_a && r.colour_b ? `<strong>${esc(r.colour_a)} + ${esc(r.colour_b)}</strong> — ` : ''}
            ${esc(r.text)}</span>
          <label class="chk"><input type="checkbox" data-rule="${r.id}"
            ${r.active ? 'checked' : ''}> on</label>
        </div>`).join('')}
      </div>
    </div>`).join('')
    : '<div class="empty">No style sources yet. Paste a YouTube link or some notes above.</div>';
}

async function submitStyle(payload) {
  $('#style-msg').textContent = 'Reading…';
  try {
    const r = await post('/api/style/sources', payload);
    $('#style-msg').textContent = `${r.note} ${r.title ? '“' + r.title + '”' : ''}`;
    $('#style-input').value = '';
    $('#style-image').value = '';
    toast(`Learned ${r.rules} rule(s).`);
    loadStyle();
    refreshBadge();
  } catch (err) {
    $('#style-msg').textContent = err.message;
  }
}

$('#style-go').addEventListener('click', () =>
  submitStyle({ input: $('#style-input').value.trim() }));

$('#style-image').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => submitStyle({
    image_b64: String(reader.result).split(',')[1], mime: file.type });
  reader.readAsDataURL(file);
});

$('#style-list').addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.src) {
    await post('/api/style/source/toggle', { id: t.dataset.src, active: t.checked });
  } else if (t.dataset.rule) {
    await post('/api/style/rule/toggle', { id: t.dataset.rule, active: t.checked });
  } else return;
  toast('Updated — combinations will reflect this.');
  refreshBadge();
});

$('#style-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-delsrc]');
  if (!btn) return;
  if (!confirm('Delete this source and all rules learned from it?')) return;
  await del('/api/style/sources/' + btn.dataset.delsrc);
  toast('Source deleted.');
  loadStyle();
  refreshBadge();
});

/* ---------- settings ---------- */

async function loadSettings() {
  const s = await get('/api/settings');
  $('#cfg-path').textContent = s.config_path;
  $('#model-input').value = s.model || '';
  $('#image-model-input').value = s.image_model || '';
  $('#ai-enabled').checked = s.ai_enabled;
  $('#key-input').placeholder = s.configured
    ? `Key saved (${s.hint}) — paste a new one to replace it`
    : 'Paste your Gemini API key';
  $('#key-msg').textContent = s.configured
    ? `A key is configured (${s.hint}).`
    : 'No key configured. Every core feature still works offline.';
}

$('#key-test').addEventListener('click', async () => {
  $('#key-msg').textContent = 'Testing…';
  const r = await post('/api/settings/test',
    { gemini_api_key: $('#key-input').value.trim() });
  $('#key-msg').textContent = (r.ok ? '✓ ' : '✗ ') + r.message +
    (r.model ? ' Best available: ' + r.model : '');
});

$('#key-save').addEventListener('click', async () => {
  const key = $('#key-input').value.trim();
  if (!key) return ($('#key-msg').textContent = 'Paste a key first.');
  const t = await post('/api/settings/test', { gemini_api_key: key });
  if (!t.ok) return ($('#key-msg').textContent = '✗ Not saved: ' + t.message);
  await post('/api/settings', { gemini_api_key: key });
  $('#key-input').value = '';
  toast('Key verified and saved outside the project.');
  loadSettings();
  refreshBadge();
});

$('#key-clear').addEventListener('click', async () => {
  if (!confirm('Remove the stored API key? AI features switch off; everything else keeps working.')) return;
  await post('/api/settings/clear', {});
  toast('Key removed.');
  loadSettings();
  refreshBadge();
});

$('#model-save').addEventListener('click', async () => {
  await post('/api/settings', {
    gemini_model: $('#model-input').value.trim(),
    gemini_image_model: $('#image-model-input').value.trim(),
  });
  toast('Model preferences saved.');
  loadSettings();
});

$('#ai-enabled').addEventListener('change', async (ev) => {
  await post('/api/settings', { ai_enabled: ev.target.checked });
  refreshBadge();
});

async function refreshBadge() {
  const m = await get('/api/meta');
  const ai = m.ai.configured && m.ai.ai_enabled;
  $('#ai-badge').innerHTML = ai
    ? `AI on (${esc(m.ai.hint)}) · ${m.style.rules} style rule(s)`
    : `AI off · ${m.style.rules} style rule(s) · <a href="#" data-goto="settings">add a key</a>`;
}

/* ---------- plan ---------- */

async function loadCombos() {
  $('#c-msg').textContent = 'Building…';
  const r = await post('/api/combos', {
    temp_c: $('#c-temp').value, formality: $('#c-formality').value,
    limit: $('#c-limit').value,
  });
  $('#c-msg').textContent =
    `${r.rules_applied.rules} style rule(s) from ${r.rules_applied.sources} source(s) applied.`;
  $('#combo-out').innerHTML = r.combos.length ? r.combos.map((c) => `
    <div class="combo">
      <div class="combo-head">
        <div class="name">${c.items.map((i) => esc(i.name)).join('  +  ')}</div>
        <span class="score ${c.score >= 85 ? 'good' : c.score >= 65 ? '' : 'bad'}">${c.score}</span>
      </div>
      <div class="meta">${esc(c.harmony)} · ${esc(c.formality)}</div>
      <ul class="why">${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      <div class="occ"><strong>Wear it to:</strong> ${c.occasions.map(esc).join(' · ')}</div>
      ${c.layer_hint ? `<div class="meta">${esc(c.layer_hint.note)}</div>` : ''}
      <div class="bar" style="margin:.5rem 0 0">
        <button class="tiny" data-combo-wear='${esc(JSON.stringify(c.items.map((i) => i.id)))}'>Wore this today</button>
        <button class="tiny ghost" data-combo-save='${esc(JSON.stringify(c.items.map((i) => i.id)))}'>Save as outfit</button>
      </div>
    </div>`).join('')
    : '<div class="empty">No combinations yet — you need at least one available top and bottom.</div>';
}

$('#c-go').addEventListener('click', loadCombos);

$('#combo-out').addEventListener('click', async (ev) => {
  const wear = ev.target.closest('[data-combo-wear]');
  const save = ev.target.closest('[data-combo-save]');
  if (wear) {
    const ids = JSON.parse(wear.dataset.comboWear);
    for (const id of ids) await post('/api/wear', { item_id: id });
    toast(`Logged a wear for ${ids.length} items.`);
    loadCombos();
  } else if (save) {
    const name = prompt('Name this outfit:');
    if (!name) return;
    await post('/api/outfits',
      { name, item_ids: JSON.parse(save.dataset.comboSave), occasion: 'from combinations' });
    toast('Saved to Outfits.');
  }
});

function renderItemLines(items) {
  if (!items.length) return '<div class="empty">Nothing matched.</div>';
  return '<div class="list">' + items.map((i) => `<div class="line">
    <span><strong>${esc(i.name)}</strong> <span class="muted">${esc(i.category)}${i.brand ? ' · ' + esc(i.brand) : ''}</span></span>
    <span class="muted">${i.last_worn ? i.days_since_worn + 'd ago' : 'never worn'} · ${money(i.price, i.currency)}</span>
  </div>`).join('') + '</div>';
}

$('#s-go').addEventListener('click', async () => {
  const out = await post('/api/suggest', {
    temp_c: $('#s-temp').value, rain: $('#s-rain').checked,
    formality: $('#s-formality').value,
  });
  $('#suggest-out').innerHTML =
    `<p class="muted">Season read as <strong>${esc(out.season)}</strong>, occasion <strong>${esc(out.formality)}</strong>. Under-worn pieces are favoured so your wardrobe actually rotates.</p>`
    + renderItemLines(out.items)
    + out.notes.map((n) => `<div class="finding monotony">${esc(n)}</div>`).join('');
});

$('#p-go').addEventListener('click', async () => {
  const out = await post('/api/packing', {
    days: $('#p-days').value, temp_c: $('#p-temp').value, rain: $('#p-rain').checked,
  });
  $('#pack-out').innerHTML = `<p class="muted">${esc(out.note)}</p>`
    + renderItemLines(out.items)
    + (out.wash_first.length
      ? `<div class="finding excess">Wash before packing: ${out.wash_first.map((i) => esc(i.name)).join(', ')}</div>` : '')
    + out.missing.map((m) => `<div class="finding gap">Short on ${esc(m.category)}: have ${m.have}, need ${m.need}.</div>`).join('');
});

/* ---------- insights ---------- */

async function loadInsights() {
  const s = await get('/api/stats');
  const tiles = [
    ['Items', s.item_count, ''],
    ['Total spend', money(s.total_spend, 'INR'), ''],
    ['Total wears', s.total_wears, ''],
    ['Avg cost/wear', s.avg_cost_per_wear === null ? '—' : money(s.avg_cost_per_wear, 'INR'), ''],
    ['Never worn', s.never_worn_count, s.never_worn_count ? 'alert' : ''],
    ['Dead money', money(s.never_worn_value, 'INR'), s.never_worn_value ? 'alert' : ''],
    ['Idle > 1 year', s.not_worn_in_a_year, s.not_worn_in_a_year ? 'alert' : ''],
  ];
  $('#stat-tiles').innerHTML = tiles.map(([k, v, cls]) =>
    `<div class="tile ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  const valueList = (arr) => arr.length ? '<div class="list">' + arr.map((i) => `
    <div class="line"><span>${esc(i.name)}</span>
    <span class="cpw">${money(i.cost_per_wear, i.currency)}/wear <span class="muted">(${i.wear_count}×)</span></span></div>`).join('') + '</div>'
    : '<div class="empty">Add prices and log wears to see this.</div>';
  $('#best').innerHTML = valueList(s.best_value);
  $('#worst').innerHTML = valueList(s.worst_value);

  const gaps = await get('/api/gaps');
  $('#gaps').innerHTML = gaps.length
    ? gaps.map((g) => `<div class="finding ${esc(g.kind)}">${esc(g.message)}</div>`).join('')
    : '<div class="empty">No gaps found — your wardrobe is well balanced.</div>';

  const dupes = await get('/api/duplicates');
  $('#dupes').innerHTML = dupes.length ? dupes.map((d) => `
    <div class="finding excess">You own <strong>${d.count}</strong> ${esc(d.colour)} ${esc(d.subcategory || d.category)}
    worth ${money(d.spend, 'INR')}: ${d.items.map((i) => esc(i.name)).join(', ')}.
    Check here before buying another.</div>`).join('')
    : '<div class="empty">No obvious duplicate clusters.</div>';
}

/* ---------- photos ---------- */

async function loadPhotos() {
  const meta = await get('/api/meta');
  const photos = await get('/api/photos/unreviewed?limit=60');
  $('#import-msg').textContent =
    `${meta.photos.total} photo(s) indexed from ${meta.roots.length} folder(s).`;
  $('#photo-grid').innerHTML = photos.length ? photos.map((p) => `
    <div class="card">
      <img loading="lazy" src="${p.path}" alt="">
      <div class="meta">${esc(p.taken_on || 'no date')}${p.had_gps ? ' · GPS discarded' : ''}</div>
      <div class="meta" style="word-break:break-all">${esc(p.path.split(/[\\/]/).pop())}</div>
      <div class="row">
        <button class="tiny" data-add="${esc(p.path)}">Make an item</button>
        <button class="tiny ghost" data-skip="${p.id}">Skip</button>
      </div>
    </div>`).join('')
    : '<div class="empty">No unreviewed photos. Index a folder above to begin.</div>';
}

$('#import-go').addEventListener('click', async () => {
  const path = $('#import-path').value.trim();
  if (!path) return;
  $('#import-msg').textContent = 'Indexing…';
  try {
    const r = await post('/api/import', { path });
    $('#import-msg').textContent =
      `Indexed ${r.added} new photo(s), ${r.already_known} already known. ${r.photos_with_gps} had GPS — discarded.`;
    loadPhotos();
  } catch (err) { $('#import-msg').textContent = 'Error: ' + err.message; }
});

$('#photo-grid').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.dataset.skip) {
    await post('/api/photos/reviewed', { photo_id: btn.dataset.skip });
    loadPhotos();
  } else if (btn.dataset.add) {
    // Jump to the Add form with the photo pre-filled.
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'add'));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-add'));
    $('#add-form [name=photo_path]').value = btn.dataset.add;
    $('#add-form [name=name]').focus();
    toast('Photo attached — fill in the details.');
  }
});

/* ---------- data ---------- */

const COMPARE = [
  ['Works in your country', 'Brazil, India, US only', 'Anywhere'],
  ['Cost', 'Google AI Pro / Ultra subscription', 'Free, runs locally'],
  ['Photo history used', 'Last 4 years only', 'Any photo, any age'],
  ['Accepts flat-lays / hanger shots', 'No — needs photos of you', 'Yes'],
  ['Requires face recognition on', 'Yes, Face Groups mandatory', 'No'],
  ['Brand, size, price, purchase date', 'Not captured', 'Captured'],
  ['Cost per wear', 'Not available', 'Computed continuously'],
  ['Real wear log', 'Inferred from photo frequency', 'Explicit + EXIF dates'],
  ['Laundry / lent / repair state', 'None', 'Tracked'],
  ['Items per outfit', 'Maximum 6', 'Unlimited'],
  ['Packing lists', 'None', 'Yes'],
  ['Gap &amp; duplicate analysis', 'None', 'Yes'],
  ['Storage cost of outputs', 'Counts against Google quota', 'A local file you own'],
  ['Data export', 'Not offered', 'JSON + CSV, one click'],
  ['Can be discontinued', 'Yes', 'No — you hold the code and the data'],
];

$('#demo-remove').addEventListener('click', async () => {
  if (!confirm('Remove the sample wardrobe?\n\nYour own items, photos and wear '
    + 'history are not touched.')) return;
  try {
    const r = await post('/api/demo/remove', {});
    $('#demo-msg').textContent =
      `Removed ${r.items} sample item(s) and ${r.outfits} sample outfit(s).`;
    toast('Sample data removed.');
    loadCloset();
  } catch (err) {
    $('#demo-msg').textContent = err.message;
  }
});

async function loadData() {
  const meta = await get('/api/meta');
  $('#db-path').textContent = meta.db;
  $('#compare').innerHTML = `<table><thead><tr>
      <th>Capability</th><th>Google Photos Wardrobe</th><th>This tool</th></tr></thead><tbody>` +
    COMPARE.map(([k, g, m]) =>
      `<tr><td>${k}</td><td class="no">${g}</td><td class="yes">${m}</td></tr>`).join('') +
    '</tbody></table>';
}

/* ---------- boot ---------- */

(async function init() {
  META = await get('/api/meta');
  fillSelect($('#f-category'), META.categories, { blank: 'All categories' });
  fillSelect($('#f-status'), META.statuses, { blank: 'Any status' });
  fillSelect($('#f-formality'), META.formalities, { blank: 'Any formality' });
  fillSelect($('#add-category'), META.categories);
  fillSelect($('#add-formality'), META.formalities, { selected: 'casual' });
  fillSelect($('#add-seasons'), META.seasons, { selected: 'all-season' });
  fillSelect($('#add-status'), META.statuses);
  fillSelect($('#s-formality'), META.formalities, { selected: 'casual' });
  fillSelect($('#c-formality'), META.formalities, { blank: 'Any occasion' });
  const aiReady = !!(META.ai && META.ai.configured);
  $('#up-render').disabled = !aiReady;
  if (!aiReady) {
    $('#up-render').checked = false;
    $('#up-render').closest('label').title =
      'Add a Gemini API key in Settings to generate product images';
  }
  $('#prod-ai').disabled = !aiReady;
  if (!aiReady) {
    $('#prod-ai').checked = false;
    $('#prod-ai').closest('label').title =
      'Add a Gemini API key in Settings to enable this';
  }
  $('#act-split').hidden = !aiReady;
  refreshBadge();
  loadCloset();
})();
