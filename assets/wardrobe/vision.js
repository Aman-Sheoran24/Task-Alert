'use strict';

/* Garment extraction in the browser — the two upload actions that previously
   needed Python.

   detectGarments()  Gemini vision, the same prompt the original app sent. It
                     returns boxes and attributes; app.js does the cropping, as
                     it always did. Behaviour here is identical to the original.

   localCutout()     On-device, no API call, nothing leaves the machine — which
                     is what "free, on this PC" promised. The original ran
                     rembg's clothing segmenter; a browser has no such model, so
                     this separates garment from background by colour instead.
                     That works well on a plain or flat-lay background and badly
                     on a busy one, and it does not split an outfit into pieces
                     the way the clothing model did. The note it returns says so.

   The attribute reading — colour clustering, pattern, texture, and the
   subcategory and formality guesses — is ported from lib/analyse.py, which was
   array arithmetic rather than a model, so it carries over exactly. */

const WVision = (function () {

  const WORK = 512;        // analysis resolution; output is cropped from this

  // ── canvas helpers ─────────────────────────────────────────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not a readable image.'));
      img.src = src;
    });
  }

  function toCanvas(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  // ── k-means, as lib/analyse.py used it ────────────────────────────────────
  // Deterministic seeding, so the same photo always reads the same way.
  function kmeans(points, k, iters, seed) {
    k = k || 3; iters = iters || 12;
    if (!points.length) return { centres: [], share: [] };
    let s = seed || 7;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    const dim = points[0].length;
    const centres = [];
    for (let i = 0; i < k; i++) centres.push(points[Math.floor(rnd() * points.length)].slice());

    let assign = new Array(points.length).fill(0);
    for (let it = 0; it < iters; it++) {
      for (let p = 0; p < points.length; p++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          let d = 0;
          for (let x = 0; x < dim; x++) { const t = points[p][x] - centres[c][x]; d += t * t; }
          if (d < bestD) { bestD = d; best = c; }
        }
        assign[p] = best;
      }
      const sums = centres.map(() => new Array(dim).fill(0));
      const counts = new Array(k).fill(0);
      for (let p = 0; p < points.length; p++) {
        counts[assign[p]]++;
        for (let x = 0; x < dim; x++) sums[assign[p]][x] += points[p][x];
      }
      for (let c = 0; c < k; c++) {
        if (!counts[c]) continue;
        for (let x = 0; x < dim; x++) centres[c][x] = sums[c][x] / counts[c];
      }
    }
    const counts = new Array(k).fill(0);
    for (const a of assign) counts[a]++;
    const order = centres.map((c, i) => i).sort((a, b) => counts[b] - counts[a]);
    return { centres: order.map(i => centres[i]),
             share: order.map(i => counts[i] / points.length) };
  }

  // ── attribute reading (lib/analyse.py) ────────────────────────────────────
  function sampleMasked(px, mask, w, h, limit) {
    const out = [];
    const total = w * h;
    const step = Math.max(1, Math.floor(total / (limit * 3)));
    for (let i = 0; i < total; i += step) {
      if (!mask[i]) continue;
      out.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
      if (out.length >= limit) break;
    }
    return out;
  }

  function colours(px, mask, w, h) {
    const pts = sampleMasked(px, mask, w, h, 4000);
    if (pts.length < 50) return { primary: null, secondary: null };
    const { centres, share } = kmeans(pts, 3, 12, 7);
    const prim = centres[0].map(Math.round);
    let sec = null;
    for (let i = 1; i < centres.length; i++) {
      const far = Math.abs(centres[i][0] - centres[0][0]) +
                  Math.abs(centres[i][1] - centres[0][1]) +
                  Math.abs(centres[i][2] - centres[0][2]);
      if (share[i] > 0.12 && far > 60) { sec = centres[i].map(Math.round); break; }
    }
    return { primary: prim, secondary: sec };
  }

  // Folds and shadows swing brightness while the garment is still one colour,
  // so luminance variance alone called plain shirts "checked". The reliable
  // signal is how many genuinely different COLOURS are present.
  function patternOf(px, mask, w, h) {
    const pts = sampleMasked(px, mask, w, h, 4000);
    if (pts.length < 50) return ['', 0];
    const norm = pts.map(p => {
      const s = p[0] + p[1] + p[2] + 1e-6;
      return [p[0] / s, p[1] / s, p[2] / s];
    });
    const { centres, share } = kmeans(norm, 3, 12, 11);
    const dominant = share[0];
    let far = false;
    for (let i = 1; i < centres.length; i++) {
      const d = Math.abs(centres[i][0] - centres[0][0]) +
                Math.abs(centres[i][1] - centres[0][1]) +
                Math.abs(centres[i][2] - centres[0][2]);
      if (share[i] > 0.12 && d > 0.10) { far = true; break; }
    }
    if (dominant > 0.80 || !far) return ['solid', 0.72];

    // Two or more real colours: do they repeat (stripes/checks) or not (print)?
    const rowVar = [], colVar = [];
    for (let y = 0; y < h; y++) {
      let sum = 0, n = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        sum += (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3; n++;
      }
      if (n > 4) rowVar.push(sum / n);
    }
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        sum += (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3; n++;
      }
      if (n > 4) colVar.push(sum / n);
    }
    const swings = (arr) => {
      if (arr.length < 8) return 0;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      let crossings = 0;
      for (let i = 1; i < arr.length; i++) {
        if ((arr[i - 1] - mean) * (arr[i] - mean) < 0) crossings++;
      }
      return crossings / arr.length;
    };
    const py = swings(rowVar), pxx = swings(colVar);
    const strong = 0.12;
    if (py > strong && pxx > strong) return ['checked', 0.5];
    if (Math.max(py, pxx) > strong) return ['striped', 0.55];
    return ['printed', 0.5];
  }

  function textureEnergy(px, mask, w, h) {
    let sum = 0, n = 0;
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const g = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
        const j = (y + 1) * w + x, k = y * w + (x + 1);
        const gy = Math.abs((px[j * 4] + px[j * 4 + 1] + px[j * 4 + 2]) / 3 - g);
        const gx = Math.abs((px[k * 4] + px[k * 4 + 1] + px[k * 4 + 2]) / 3 - g);
        sum += gx + gy; n++;
      }
    }
    return n ? sum / n : 0;
  }

  // Texture energy cannot really separate pique from plain cotton, so this
  // reports the broad family and leaves the user to refine it.
  function guessMaterial(texture, pattern) {
    if (pattern === 'printed' || pattern === 'checked' || pattern === 'striped') return 'cotton';
    if (texture > 4.0) return 'cotton';
    if (texture > 1.8) return 'cotton blend';
    return 'polyester blend';
  }

  // Width profile down the garment: sleeves make the top third wider than the
  // torso, and how far that persists says how long they are.
  function sleeveLength(mask, w, h) {
    const widths = [];
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (mask[y * w + x]) n++;
      widths.push(n);
    }
    const rows = widths.filter(n => n > 0);
    if (rows.length < 10) return 'unknown';
    const torso = widths.slice(Math.floor(h * 0.55), Math.floor(h * 0.8)).filter(n => n > 0);
    if (!torso.length) return 'unknown';
    const torsoW = torso.reduce((a, b) => a + b, 0) / torso.length;
    const top = Math.floor(h * 0.12);
    let last = top;
    for (let y = top; y < h * 0.8; y++) {
      if (widths[y] > torsoW * 1.25) last = y;
    }
    const frac = (last - top) / h;
    if (frac < 0.05) return 'sleeveless';
    if (frac < 0.22) return 'short';
    if (frac < 0.38) return 'three-quarter';
    return 'long';
  }

  function collarOpen(mask, w, h) {
    // A gap at the very top centre reads as an open collar.
    const band = Math.max(2, Math.floor(h * 0.08));
    let gap = 0, seen = 0;
    for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.04) + band; y++) {
      for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
        seen++;
        if (!mask[y * w + x]) gap++;
      }
    }
    return seen > 0 && gap / seen > 0.25;
  }

  function guessSubcategory(category, sleeve, openCollar, aspect) {
    if (category === 'bottom') return aspect > 1.25 ? 'trousers' : 'shorts';
    if (category === 'dress') return 'dress';
    if (category !== 'top') return '';
    if (openCollar) return sleeve === 'short' ? 'polo' : 'shirt';
    if (sleeve === 'sleeveless') return 'vest';
    if (sleeve === 'short') return 't-shirt';
    return 'sweatshirt';
  }

  function guessFormality(sub) {
    const formal = { shirt: 'business', trousers: 'smart-casual', dress: 'smart-casual' };
    if (['t-shirt', 'vest', 'shorts', 'sweatshirt'].indexOf(sub) !== -1) return 'casual';
    if (sub === 'polo') return 'smart-casual';
    return formal[sub] || 'casual';
  }

  // ── separating garment from background ────────────────────────────────────
  // The border of the photo is overwhelmingly background, so its colours define
  // what to drop. This is why a plain or flat-lay backdrop works and a cluttered
  // room does not.
  function buildMask(px, w, h) {
    const border = [];
    const edge = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x > edge && x < w - edge && y > edge && y < h - edge) continue;
        const i = (y * w + x) * 4;
        border.push([px[i], px[i + 1], px[i + 2]]);
      }
    }
    const { centres, share } = kmeans(border, 2, 10, 5);
    const bg = centres.filter((c, i) => share[i] > 0.15);

    // Spread of the border colours sets the tolerance: a noisy backdrop needs a
    // wider one than a seamless sweep, or half the garment gets cut away.
    let spread = 0;
    for (const p of border) {
      let best = Infinity;
      for (const c of bg) {
        best = Math.min(best, Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]));
      }
      spread += best;
    }
    spread /= Math.max(1, border.length);
    const tol = Math.max(48, Math.min(170, spread * 2.2 + 44));

    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      let best = Infinity;
      for (const c of bg) {
        best = Math.min(best, Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]));
      }
      mask[i] = best > tol ? 1 : 0;
    }
    // Close before picking a region. A garment carrying colours close to the
    // backdrop — white stripes on white, a pale logo — comes out of the
    // threshold in disconnected pieces, and without this the largest of those
    // pieces is one stripe rather than the shirt.
    return largestBlob(closeMask(mask, w, h,
      Math.max(2, Math.round(Math.min(w, h) * 0.015))), w, h);
  }

  // Dilate then erode by the same radius, separably: fills gaps and pinholes
  // without growing the silhouette overall.
  function closeMask(mask, w, h, r) {
    const run = (src, grow) => {
      const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {                       // horizontal pass
        for (let x = 0; x < w; x++) {
          let hit = grow ? 0 : 1;
          for (let d = -r; d <= r; d++) {
            const xx = x + d;
            if (xx < 0 || xx >= w) { if (!grow) hit = 0; continue; }
            if (grow) { if (src[y * w + xx]) { hit = 1; break; } }
            else if (!src[y * w + xx]) { hit = 0; break; }
          }
          tmp[y * w + x] = hit;
        }
      }
      for (let y = 0; y < h; y++) {                       // vertical pass
        for (let x = 0; x < w; x++) {
          let hit = grow ? 0 : 1;
          for (let d = -r; d <= r; d++) {
            const yy = y + d;
            if (yy < 0 || yy >= h) { if (!grow) hit = 0; continue; }
            if (grow) { if (tmp[yy * w + x]) { hit = 1; break; } }
            else if (!tmp[yy * w + x]) { hit = 0; break; }
          }
          out[y * w + x] = hit;
        }
      }
      return out;
    };
    return run(run(mask, true), false);
  }

  // Keep only the biggest connected region, so shadows and stray objects at the
  // edge of the frame do not end up in the cutout.
  function largestBlob(mask, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    let best = -1, bestSize = 0, cur = 0;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || label[s] !== -1) continue;
      let top = 0, size = 0;
      stack[top++] = s; label[s] = cur;
      while (top) {
        const p = stack[--top]; size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = cur; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = cur; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = cur; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = cur; stack[top++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
      cur++;
    }
    const out = new Uint8Array(w * h);
    if (best < 0) return out;
    for (let i = 0; i < w * h; i++) if (label[i] === best) out[i] = 1;
    return out;
  }

  function bbox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  // ── the local path ────────────────────────────────────────────────────────
  async function localCutout(dataUrl) {
    const img = await loadImage(dataUrl);
    const canvas = toCanvas(img, WORK);
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, w, h).data;

    const mask = buildMask(px, w, h);
    let covered = 0;
    for (let i = 0; i < mask.length; i++) covered += mask[i];
    const coverage = covered / (w * h);

    // Too little is a failed separation; too much means the background was not
    // distinguishable and we would just hand back the whole photo.
    if (coverage < 0.02 || coverage > 0.97) {
      return { items: [], coverage: coverage };
    }

    const box = bbox(mask, w, h);
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;

    // Cut-out PNG: the garment on transparency, cropped to its bounds.
    const out = document.createElement('canvas');
    out.width = bw; out.height = bh;
    const octx = out.getContext('2d');
    const src = ctx.getImageData(box.x0, box.y0, bw, bh);
    const dst = octx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const si = (y * bw + x) * 4;
        const mi = (y + box.y0) * w + (x + box.x0);
        dst.data[si] = src.data[si];
        dst.data[si + 1] = src.data[si + 1];
        dst.data[si + 2] = src.data[si + 2];
        dst.data[si + 3] = mask[mi] ? 255 : 0;
      }
    }
    octx.putImageData(dst, 0, 0);

    // Attributes are read from the masked pixels, as the Python version did.
    const aspect = bh / bw;
    const sub = buildAttrs(px, mask, w, h, aspect);
    return {
      items: [{
        region: 'garment',
        category: sub.category,
        coverage: coverage,
        data_url: out.toDataURL('image/png'),
        colour_rgb: sub.attrs.primary_rgb || null,
        attrs: sub.attrs,
      }],
      coverage: coverage,
    };
  }

  function buildAttrs(px, mask, w, h, aspect) {
    const col = colours(px, mask, w, h);
    const pat = patternOf(px, mask, w, h);
    const tex = textureEnergy(px, mask, w, h);
    const sleeve = sleeveLength(mask, w, h);
    const open = collarOpen(mask, w, h);
    // A tall narrow silhouette with no sleeve flare reads as a bottom.
    const category = (aspect > 1.6 && sleeve === 'sleeveless') ? 'bottom' : 'top';
    const subcategory = guessSubcategory(category, sleeve, open, aspect);
    return {
      category: category,
      attrs: {
        primary_rgb: col.primary, secondary_rgb: col.secondary,
        pattern: pat[0], confidence: pat[1],
        texture: Math.round(tex * 100) / 100,
        material: guessMaterial(tex, pat[0]),
        sleeve: sleeve === 'unknown' ? '' : sleeve,
        subcategory: subcategory,
        formality: guessFormality(subcategory),
        details: open ? 'open collar' : '',
      },
    };
  }

  // ── the Gemini path ───────────────────────────────────────────────────────
  const DETECT_PROMPT =
'You are cataloguing a wardrobe from a photograph.\n\n' +
'Find EVERY distinct wearable item in this image and return them as separate\n' +
'entries. If a person is wearing an outfit, split it into its individual garments\n' +
'-- the shirt is one entry, the trousers are another, the shoes another, the belt\n' +
'another. Never return "an outfit" as a single entry.\n\n' +
'Include: tops, bottoms, dresses, outerwear, footwear, bags, belts, hats, scarves,\n' +
'glasses, watches and jewellery.\n' +
'Exclude: the person, their face, skin, hair, the background, furniture, and any\n' +
'item too small or occluded to catalogue usefully.\n\n' +
'Return JSON of this exact shape:\n' +
'{"items": [{\n' +
'  "box_2d": [ymin, xmin, ymax, xmax],\n' +
'  "mask": [[x, y], [x, y], ...],\n' +
'  "label": "black shirt",\n' +
'  "name": "Black short-sleeve shirt with white collar piping",\n' +
'  "category": "top",\n' +
'  "subcategory": "shirt",\n' +
'  "colour": "black",\n' +
'  "secondary_colour": "white",\n' +
'  "pattern": "solid",\n' +
'  "material": "cotton",\n' +
'  "fit": "regular",\n' +
'  "sleeve": "short sleeve",\n' +
'  "neckline": "collared",\n' +
'  "closure": "button-front",\n' +
'  "details": "white piping along the collar, chest pocket, rolled cuffs",\n' +
'  "formality": "smart-casual",\n' +
'  "seasons": "summer",\n' +
'  "care": "machine wash cold",\n' +
'  "confidence": 0.9\n' +
'}]}\n\n' +
'Rules:\n' +
'- box_2d is [ymin, xmin, ymax, xmax] normalized to 0-1000, origin top-left.\n' +
'  Make the box tight around the garment but include all of it.\n' +
'- mask is the garment outline as a polygon of [x, y] points normalized to\n' +
'  0-1000 in the SAME coordinate space as box_2d. Give at least 12 points and\n' +
'  follow the real silhouette. Omit only if impossible.\n' +
'- category must be one of: %CATS%\n' +
'- formality must be one of: %FORMS%\n' +
'- seasons must be one or more of: %SEASONS%, comma separated.\n' +
'- Report colour as a single plain word.\n' +
'- Return JSON only. No prose, no code fence.';

  // Reject slivers — they crop to unreadable thumbnails.
  function cleanBox(box) {
    if (!Array.isArray(box) || box.length !== 4) return null;
    let v = box.map(Number);
    if (v.some(n => !isFinite(n))) return null;
    let [ymin, xmin, ymax, xmax] = v;
    if (ymax < ymin) { const t = ymin; ymin = ymax; ymax = t; }
    if (xmax < xmin) { const t = xmin; xmin = xmax; xmax = t; }
    const c = [ymin, xmin, ymax, xmax].map(n => Math.max(0, Math.min(1000, n)));
    if (c[2] - c[0] < 15 || c[3] - c[1] < 15) return null;
    return c;
  }

  function cleanMask(mask) {
    if (!Array.isArray(mask) || mask.length < 3) return null;
    const pts = [];
    for (const p of mask) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]), y = Number(p[1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      pts.push([Math.max(0, Math.min(1000, x)), Math.max(0, Math.min(1000, y))]);
    }
    return pts.length >= 3 ? pts : null;
  }

  async function detectGarments(dataUrl, apiKey, model, vocab) {
    const comma = dataUrl.indexOf(',');
    const b64 = dataUrl.slice(comma + 1);
    const mime = (dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/jpeg');

    const prompt = DETECT_PROMPT
      .replace('%CATS%', vocab.categories.join(', '))
      .replace('%FORMS%', vocab.formalities.join(', '))
      .replace('%SEASONS%', vocab.seasons.join(', '));

    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data.error && data.error.message) || ('Gemini HTTP ' + res.status));
    }
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const raw = parts.map(p => p.text || '').join('')
      .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('Gemini did not return usable JSON for that photo.'); }

    const list = Array.isArray(parsed) ? parsed
      : (parsed.items || parsed.boxes || parsed.garments || []);

    const out = [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const box = cleanBox(e.box_2d);
      if (!box) continue;
      out.push({
        box_2d: box,
        mask: cleanMask(e.mask),
        label: String(e.label || '').slice(0, 60),
        name: String(e.name || e.label || '').slice(0, 70),
        category: vocab.categories.indexOf(e.category) !== -1 ? e.category : 'top',
        subcategory: String(e.subcategory || '').slice(0, 40),
        colour: String(e.colour || '').slice(0, 30).trim().toLowerCase(),
        secondary_colour: String(e.secondary_colour || '').slice(0, 30),
        pattern: String(e.pattern || '').slice(0, 40),
        material: String(e.material || '').slice(0, 40),
        fit: String(e.fit || '').slice(0, 30),
        sleeve: String(e.sleeve || '').slice(0, 30),
        neckline: String(e.neckline || '').slice(0, 30),
        closure: String(e.closure || '').slice(0, 30),
        details: String(e.details || '').slice(0, 200),
        formality: vocab.formalities.indexOf(e.formality) !== -1 ? e.formality : 'casual',
        seasons: String(e.seasons || 'all-season'),
        care: String(e.care || '').slice(0, 80),
        confidence: Math.max(0, Math.min(1, Number(e.confidence) || 0.6)),
      });
    }
    return out;
  }

  return { detectGarments, localCutout, loadImage, toCanvas,
           kmeans, colours, patternOf, textureEnergy, guessMaterial,
           guessSubcategory, guessFormality, sleeveLength, collarOpen,
           buildMask, closeMask, largestBlob, bbox, cleanBox, cleanMask, buildAttrs };
})();
