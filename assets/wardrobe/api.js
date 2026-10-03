'use strict';

/* The backend, in the browser.

   The original app served /api/* from a local Python process. app.js funnels
   every call through one fetch(), so intercepting fetch lets that file run
   completely unmodified against this instead — same UI, no server.

   Endpoints that need Python are answered with a clear 501 rather than a
   silent failure: garment cutout needs rembg, colour measurement and product
   rendering need PIL and numpy. Those stay in the local app. Photo upload does
   work here — the image is stored in IndexedDB as-is, just without a cutout. */

(function () {

  const realFetch = window.fetch.bind(window);

  const NEEDS_LOCAL =
    'That step needs the local WardRobe app: it runs rembg and PIL on your ' +
    'machine, which a browser cannot. Everything else on this page works here. ' +
    'Photos you add are kept as you uploaded them, without a cutout.';

  const json = (body, status) => new Response(
    JSON.stringify(body === undefined ? null : body),
    { status: status || 200, headers: { 'Content-Type': 'application/json' } });

  const text = (body, status, type) => new Response(body,
    { status: status || 200, headers: { 'Content-Type': type || 'text/plain' } });

  // Settings are local to this page. The real key lives in Task Matrix's own
  // Work Documentation panel; this only reports whether one is set.
  function aiState() {
    let key = '';
    try { key = (localStorage.getItem('tm_gemini_key') || '').trim(); } catch (_) {}
    const mask = key ? key.slice(0, 4) + '…' + key.slice(-4) : '';
    return { configured: !!key, hint: mask, model: 'gemini-2.5-pro',
             image_model: '', ai_enabled: !!key,
             config_path: 'this browser (set it in Work Documentation)' };
  }

  // ── reading style rules out of text ───────────────────────────────────────
  // Keeps the dot in an "AQ." key while stripping whitespace and the
  // zero-width characters a paste can carry.
  function cleanKey(k) { return String(k || '').replace(/[^A-Za-z0-9._-]/g, ''); }

  function geminiKey() {
    try { return cleanKey(localStorage.getItem('tm_gemini_key')); }
    catch (_) { return ''; }
  }

  const GEMINI_MODEL = 'gemini-2.5-pro';

  // The UI sends raw base64 for some calls and a full data URL for others.
  function dataUrlOf(body) {
    if (!body) return '';
    if (body.data_url) return body.data_url;
    const b64 = body.data_b64 || body.dataB64;
    return b64 ? 'data:' + (body.mime || 'image/png') + ';base64,' + b64 : '';
  }

  const AVOID_RE = /\b(avoid|never|don'?t|do not|clash)\b/i;

  // The fallback when no key is set. Deliberately modest: it looks for two
  // colour words joined by a linking word, in one sentence.
  function extractOffline(text) {
    const names = WStore.HUES_FOR_MATCH.join('|');
    const re = new RegExp('\\b(' + names + ')\\b[^.;!?\\n]{0,40}?' +
                          '\\b(?:with|and|against|over|under|plus|on)\\b' +
                          '[^.;!?\\n]{0,20}?\\b(' + names + ')\\b', 'gi');
    const out = [], seen = new Set();
    for (const sentence of String(text || '').split(/[.\n;!?]/)) {
      const s = sentence.trim();
      if (s.length < 8) continue;
      const avoid = AVOID_RE.test(s);
      let m; re.lastIndex = 0;
      while ((m = re.exec(s)) !== null) {
        const a = WStore.normalise(m[1]), b = WStore.normalise(m[2]);
        if (!a || !b || a === b || seen.has(a + '|' + b)) continue;
        seen.add(a + '|' + b);
        out.push({ kind: 'colour_pair', colour_a: a, colour_b: b,
                   verdict: avoid ? 'avoid' : 'good', text: s.slice(0, 300),
                   occasion: '', weight: 0.6, origin: 'heuristic' });
        if (out.length >= 20) return out;
      }
    }
    return out;
  }

  // With a key, Gemini reads the meaning rather than matching a pattern. It
  // uses the same key Task Matrix stores for Work Documentation.
  async function extractWithGemini(text) {
    const r = await realFetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
        body: JSON.stringify({ contents: [{ parts: [{ text:
          'Extract the concrete colour-pairing rules these style notes state. ' +
          'Reply with JSON only, no prose or code fence:\n' +
          '[{"colour_a":"navy","colour_b":"brown","verdict":"good","text":"the ' +
          'sentence that says so","weight":0.9}]\n\n' +
          'verdict is "good" or "avoid". weight is 0 to 1, how strongly the text ' +
          'asserts it. Use single plain colour words. Only include a pair the text ' +
          'actually comments on — never infer from general colour theory. Return ' +
          '[] if it states none.\n\nNOTES:\n' + text }] }] }),
      });
    if (!r.ok) throw new Error('Gemini rejected the request');
    const d = await r.json();
    const out = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    const raw = out.map(p => p.text || '').join('')
      .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not a list');
    return parsed.map(x => ({
      kind: 'colour_pair',
      colour_a: WStore.normalise(x.colour_a), colour_b: WStore.normalise(x.colour_b),
      verdict: x.verdict === 'avoid' ? 'avoid' : 'good',
      text: String(x.text || '').slice(0, 300), occasion: '',
      weight: Math.max(0, Math.min(Number(x.weight) || 1, 1)), origin: 'ai',
    })).filter(x => x.colour_a && x.colour_b && x.colour_a !== x.colour_b);
  }

  async function route(method, path, q, body) {
    // ---------- reads ----------
    if (method === 'GET') {
      if (path === '/api/meta') {
        return json({
          categories: WStore.CATEGORIES, statuses: WStore.STATUSES,
          formalities: WStore.FORMALITIES, seasons: WStore.SEASONS,
          photos: { total: WStore.photos.size, reviewed: WStore.photos.size },
          roots: [],
          db: 'this browser (synced to your Drive)',
          ai: aiState(), style: WStore.ruleStats(),
          local_cutout: { available: true, engine: 'canvas colour separation',
                          hint: 'Garment separation runs on this device, with no ' +
                                'API call and nothing leaving your machine. It ' +
                                'works from the background colour, so a plain or ' +
                                'flat-lay backdrop gives a clean cut and a busy ' +
                                'room does not. Use Gemini to split a whole ' +
                                'outfit into separate garments.' },
        });
      }
      if (path === '/api/settings') return json(aiState());
      if (path === '/api/style/sources') return json(WStore.listSources());
      if (path === '/api/items') {
        return json(WStore.listItems({
          category: q.get('category') || null, status: q.get('status') || null,
          search: q.get('search') || null, season: q.get('season') || null,
          formality: q.get('formality') || null,
          include_retired: q.get('include_retired') === '1',
        }));
      }
      if (/^\/api\/items\/\d+\/history$/.test(path)) {
        return json(WStore.wearHistory(path.split('/')[3]));
      }
      if (/^\/api\/items\/\d+$/.test(path)) {
        const it = WStore.getItem(path.split('/')[3]);
        return it ? json(it) : json({ error: 'not found' }, 404);
      }
      if (path === '/api/stats') return json(WStore.stats());
      if (path === '/api/gaps') return json(WStore.gaps(q.get('season') || null));
      if (path === '/api/duplicates') return json(WStore.duplicates());
      if (path === '/api/outfits') return json(WStore.listOutfits());
      if (path === '/api/photos/unreviewed') return json([]);
      if (path === '/api/export') return json(WStore.exportAll());
      if (path === '/api/export.csv') return text(WStore.exportCsv(), 200, 'text/csv');
      if (path === '/api/render/prompt') {
        // The prompt is built from a colour measured off the photo, which needs PIL.
        return json({ error: NEEDS_LOCAL }, 501);
      }
    }

    // ---------- writes ----------
    if (method === 'POST') {
      if (path === '/api/items') return json(WStore.createItem(body), 201);
      if (path === '/api/wear') {
        return json(WStore.logWear(body.item_id, body.worn_on, 'manual', body.note));
      }
      if (path === '/api/unwear') return json(WStore.unlogWear(body.item_id, body.worn_on));
      if (path === '/api/outfits') {
        if (!body.name) return json({ error: 'outfit name is required' }, 400);
        const ids = (body.item_ids || []).map(Number);
        if (!ids.length) return json({ error: 'select at least one item' }, 400);
        return json({ id: WStore.createOutfit(body.name, ids, body.occasion, body.notes) }, 201);
      }
      if (path === '/api/outfits/wear') {
        return json({ logged: WStore.wearOutfit(body.outfit_id, body.worn_on) });
      }
      if (path === '/api/suggest') {
        return json(WStore.suggest(body.temp_c, !!body.rain, body.formality || 'casual'));
      }
      if (path === '/api/packing') {
        return json(WStore.packing(body.days === undefined ? 3 : body.days,
                                   body.temp_c, !!body.rain));
      }
      if (path === '/api/combos') {
        return json({ combos: WStore.combos(body.temp_c, body.formality || null,
                                            Number(body.limit) || 8),
                      rules_applied: WStore.ruleStats() });
      }
      if (path === '/api/import') {
        // The original took a folder path to scan; here it takes the dump itself.
        if (body && Array.isArray(body.items)) return json(WStore.importAll(body));
        return json({ error: 'Paste or choose an exported wardrobe JSON file. ' +
                      'Scanning a folder of photos needs the local app.' }, 501);
      }
      // Bulk CREATE, not bulk update: this is how the upload screen commits the
      // drafts it built from a photo. It reads r.created and r.failed back.
      if (path === '/api/items/batch') {
        const rows = (body && body.items) || [];
        if (!Array.isArray(rows) || !rows.length) {
          return json({ error: 'Nothing to add.' }, 400);
        }
        const created = [], failed = [];
        for (const row of rows.slice(0, 40)) {
          try { created.push(WStore.createItem(row)); }
          catch (e) { failed.push({ name: (row && row.name) || '?', error: e.message }); }
        }
        return json({ created: created, failed: failed }, 201);
      }
      // Settings genuinely work here. The key is the same one Task Matrix
      // keeps for Work Documentation, so setting it in either place is enough.
      if (path === '/api/settings/test') {
        const key = cleanKey((body && body.gemini_api_key) || geminiKey());
        if (!key) return json({ ok: false, message: 'No key to test.', model: GEMINI_MODEL });
        try {
          const r = await realFetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' +
            GEMINI_MODEL + ':generateContent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply OK.' }] }] }),
            });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            return json({ ok: false, model: GEMINI_MODEL,
              message: (d.error && d.error.message) || ('Gemini HTTP ' + r.status) });
          }
          return json({ ok: true, message: 'Key works.', model: GEMINI_MODEL });
        } catch (e) {
          return json({ ok: false, model: GEMINI_MODEL,
                        message: 'Could not reach Gemini: ' + e.message });
        }
      }
      if (path === '/api/settings') {
        if (body && 'gemini_api_key' in body) {
          const key = cleanKey(body.gemini_api_key);
          try {
            if (key) localStorage.setItem('tm_gemini_key', key);
            else localStorage.removeItem('tm_gemini_key');
          } catch (_) {}
        }
        return json(aiState());
      }
      if (path === '/api/settings/clear') {
        try { localStorage.removeItem('tm_gemini_key'); } catch (_) {}
        return json(aiState());
      }
      if (path === '/api/style/sources') {
        if (body && body.image_b64) {
          return json({ error: 'Reading rules out of a screenshot needs the local ' +
                        'app. Paste the text of the post or caption instead.' }, 501);
        }
        const input = String((body && (body.input || body.text)) || '').trim();
        if (!input) return json({ error: 'Paste some notes first.' }, 400);
        if (/^https?:\/\//i.test(input)) {
          return json({ error: 'A browser cannot fetch another site\'s page, and ' +
                        'Instagram and YouTube need a login anyway. Paste the text, ' +
                        'the transcript or the caption instead.' }, 400);
        }

        let rules = [], via = 'pattern matching';
        try {
          if (geminiKey()) { rules = await extractWithGemini(input); via = 'Gemini'; }
        } catch (_) { rules = []; }
        if (!rules.length) rules = extractOffline(input);

        if (!rules.length) {
          return json({ error: 'No colour pairings found in that text.' }, 400);
        }
        const title = input.split('\n')[0].slice(0, 140) || 'Pasted notes';
        const id = WStore.addSource({ title: title, kind: 'text',
          summary: 'Read with ' + via + '.', origin: via === 'Gemini' ? 'ai' : 'heuristic' },
          rules);
        return json({ id: id, added: rules.length, rules: rules.length, title: title,
                      note: 'Read with ' + via + '.' });
      }
      if (path === '/api/style/source/toggle') {
        return json(WStore.setSourceActive(body.id, body.active));
      }
      if (path === '/api/style/rule/toggle') {
        return json(WStore.setRuleActive(body.id, body.active));
      }
      // Nothing is seeded here, so there is never sample data to remove.
      if (path === '/api/demo/remove') return json({ items: 0, outfits: 0 });
      if (path === '/api/photos/reviewed') return json({ ok: true });

      // Photo upload works; only the processing downstream of it does not.
      // The UI sends raw base64 and expects a path back, which it then PATCHes
      // onto the item — so we hand back a handle into IndexedDB.
      if (path === '/api/photo/upload' || path === '/api/photo/store') {
        const b64 = body && (body.data_b64 || body.dataB64);
        const dataUrl = (body && body.data_url) ||
          (b64 ? 'data:' + ((body && body.mime) || 'image/png') + ';base64,' + b64 : '');
        if (!dataUrl) return json({ error: 'No image supplied.' }, 400);
        const key = 'p' + Date.now() + Math.random().toString(36).slice(2, 7);
        await WStore.putPhoto(key, dataUrl);
        return json({ ok: true, photo_path: 'idb:' + key, path: 'idb:' + key });
      }
      if (path === '/api/photo/detect') {
        if (!geminiKey()) {
          return json({ error: 'Separating the individual garments out of a photo ' +
            'needs a Gemini API key. Add one in Task Matrix under Work ' +
            'Documentation, or use Crop by hand to draw a box around one garment ' +
            'at a time.' }, 400);
        }
        const url = dataUrlOf(body);
        if (!url) return json({ error: 'The upload was not valid image data.' }, 400);
        let found;
        try {
          found = await WVision.detectGarments(url, geminiKey(), GEMINI_MODEL, {
            categories: WStore.CATEGORIES, formalities: WStore.FORMALITIES,
            seasons: WStore.SEASONS,
          });
        } catch (e) {
          return json({ error: e.message }, 400);
        }
        return json({ items: found, note: found.length
          ? 'Found ' + found.length + ' garment(s). Each one is cropped out of ' +
            'your photo separately.'
          : 'No wearable items were found in that photo.' });
      }

      if (path === '/api/photo/cutout') {
        const url = dataUrlOf(body);
        if (!url) return json({ error: 'No image to work from.' }, 400);
        let res;
        try { res = await WVision.localCutout(url); }
        catch (e) { return json({ error: 'Local cutout failed: ' + e.message }, 400); }

        // Each piece is stored like any other upload, so the draft can carry a
        // handle rather than a megabyte of base64.
        const items = [];
        for (const piece of res.items) {
          const key = 'p' + Date.now() + Math.random().toString(36).slice(2, 7);
          await WStore.putPhoto(key, piece.data_url);
          items.push(Object.assign({}, piece,
            { photo_path: 'idb:' + key, cutout_path: 'idb:' + key }));
        }
        if (items.length && body && body.item_id) {
          try { WStore.updateItem(body.item_id, { photo_path: items[0].photo_path }); }
          catch (_) {}
        }
        return json({ items: items, engine: 'canvas colour separation (on this device)',
          note: items.length
            ? 'Cut one garment out on this device — no API call, no cost. For a ' +
              'photo holding several garments, use Gemini to split them.'
            : 'The garment could not be told apart from the background. A plainer ' +
              'backdrop works best — or crop by hand, or use Gemini.' });
      }

      if (path === '/api/product/preview') {
        const url = String((body && body.url) || '').trim();
        if (!url) return json({ error: 'Paste a product link first.' }, 400);
        if (!/^https?:\/\//i.test(url)) {
          return json({ error: 'That does not look like a link. Paste the full ' +
                        'product URL, starting with https://' }, 400);
        }
        if (!geminiKey()) {
          // Worth being specific: this is not the rembg limitation, it is that
          // a page cannot fetch another site, and the key is the way around it.
          return json({ error: 'Reading a product page needs a Gemini key. A web ' +
            'page cannot fetch another site — retailers do not permit it — so ' +
            'Gemini fetches and reads the page instead. Add a key under AI ' +
            'settings, or fill the form in by hand.' }, 400);
        }
        try {
          return json(await WVision.fetchProduct(url, geminiKey(), GEMINI_MODEL, {
            categories: WStore.CATEGORIES, formalities: WStore.FORMALITIES,
            seasons: WStore.SEASONS,
          }));
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }

      if (path.indexOf('/api/photo/') === 0) {
        return json({ error: NEEDS_LOCAL }, 501);
      }
    }

    if (method === 'PATCH' || method === 'PUT') {
      const m = path.match(/^\/api\/items\/(\d+)$/);
      if (m) {
        try { return json(WStore.updateItem(m[1], body)); }
        catch (e) { return json({ error: e.message }, 404); }
      }
    }

    if (method === 'DELETE') {
      let m = path.match(/^\/api\/items\/(\d+)$/);
      if (m) return json(WStore.deleteItem(m[1]));
      m = path.match(/^\/api\/outfits\/(\d+)$/);
      if (m) return json(WStore.deleteOutfit(m[1]));
      m = path.match(/^\/api\/style\/sources\/(\d+)$/);
      if (m) return json(WStore.deleteSource(m[1]));
    }

    return json({ error: 'unknown endpoint: ' + method + ' ' + path }, 404);
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = url.indexOf('/api/') === 0 || url.indexOf('api/') === 0;
    if (!isApi) return realFetch(input, init);

    const method = ((init && init.method) || 'GET').toUpperCase();
    const u = new URL(url, location.href);
    let body = null;
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (_) { body = init.body; }
    }
    try {
      return await route(method, u.pathname.replace(/^.*(\/api\/)/, '$1'),
                         u.searchParams, body);
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, 500);
    }
  };

  // The Data tab exports through <a href="/api/export" download>, which the
  // browser navigates to rather than fetching — so the shim never sees it and
  // the link 404s. Catch the click and hand over a file built here instead.
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Guarded: the page always has a document, but the module should not fall
  // over at load time if it is ever evaluated without one.
  const onDoc = (ev, fn) => {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener(ev, fn);
    }
  };

  onDoc('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/export"]');
    if (!a) return;
    e.preventDefault();
    const day = WStore.today();
    if (a.getAttribute('href').indexOf('.csv') !== -1) {
      download('wardrobe-' + day + '.csv', WStore.exportCsv(), 'text/csv');
    } else {
      download('wardrobe-' + day + '.json',
               JSON.stringify(WStore.exportAll(), null, 2), 'application/json');
    }
  });

  // The Data tab's import control. The original scanned a folder on disk;
  // in a browser the file has to be handed over, so this reads it and posts it
  // through the same endpoint.
  onDoc('change', async (e) => {
    if (!e.target || e.target.id !== 'data-import') return;
    const file = e.target.files && e.target.files[0];
    const msg = document.getElementById('data-import-msg');
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      const res = await window.fetch('/api/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Import failed.');
      if (msg) {
        msg.textContent = 'Imported ' + out.items + ' item(s) and ' +
                          out.wears + ' wear record(s). Reloading…';
      }
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      if (msg) msg.textContent = 'Could not import: ' + err.message;
    }
  });

  // Photos must be in memory before the first render, or items would paint
  // without them and only appear after some later refresh.
  window.wardrobeReady = WStore.loadPhotos();
})();
