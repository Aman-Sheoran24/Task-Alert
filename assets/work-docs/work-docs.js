'use strict';

/* Work Documentation
   Write notes by hand or upload a voice recording for Gemini to transcribe
   and draft into a daily work log, then save it as a Google Doc. */
/* ════════════════════════════════════════════════════════════════════════════
   WORK DOCUMENTATION
   Two ways in: write notes yourself, or upload a voice recording and let Gemini
   transcribe it and draft the notes. Either way, saving creates a real Google
   Doc under  Work Documentation / dd-mm-yy_Day  in your Drive.
   ──────────────────────────────────────────────────────────────────────────── */

const DOCS_KEY    = 'tm_docs';         // local index of what we've saved, for the list
const GEMINI_KEY  = 'tm_gemini_key';   // your API key — this browser only, never the repo
const DOCS_ROOT   = 'Work Documentation';

// Pro gives the best transcription of messy audio. Swap to 'gemini-3.7-flash'
// if you'd rather have it cheaper and faster.
const GEMINI_MODEL = 'gemini-2.5-pro';

// Gemini caps an inline request at 20 MB, and base64 inflates bytes by a third,
// so a raw file much past ~14 MB won't fit. Under that we send the original
// untouched — one call, no quality loss. Over it we decode, downmix to 16 kHz
// mono (plenty for speech) and transcribe in chunks.
const AUDIO_INLINE_MAX  = 14 * 1024 * 1024;
const CHUNK_SECONDS     = 240;   // ~7.7 MB of PCM per chunk, ~10 MB once base64'd
const AUDIO_MAX_MINUTES = 90;    // decoding holds the whole recording in memory at once

let docs = [];
try { docs = JSON.parse(localStorage.getItem(DOCS_KEY) || '[]'); } catch (_) { docs = []; }

let docsMode  = 'write';
let audioFile = null;
let docsBusy  = false;
// Set while we bounce the user through the Drive consent screen, so the save
// they already asked for resumes by itself once permission comes back.
let pendingDocSave = false;

const docsModal      = document.getElementById('docsModal');
const docsTitleEl    = document.getElementById('docsTitle');
const docsBodyEl     = document.getElementById('docsBody');
const docsNotesEl    = document.getElementById('docsNotes');
const docsTranscript = document.getElementById('docsTranscript');
const docsQuestionsEl = document.getElementById('docsQuestions');
const docsAskBtn      = document.getElementById('docsAsk');
const docsStatusEl   = document.getElementById('docsStatus');
const docsDrop       = document.getElementById('docsDrop');
const docsDropText   = document.getElementById('docsDropText');
const docsAudioEl    = document.getElementById('docsAudio');
const docsRunBtn     = document.getElementById('docsTranscribe');
const docsSaveBtn    = document.getElementById('docsSave');
const docsBar        = document.getElementById('docsBar');
const docsBarFill    = document.getElementById('docsBarFill');
const docsKeyEl      = document.getElementById('docsKey');

function docStatus(text, cls) {
  docsStatusEl.textContent = text;
  docsStatusEl.className = 'docs-status' + (cls ? ' ' + cls : '');
}

function docProgress(frac) {
  if (frac == null) { docsBar.classList.remove('on'); return; }
  docsBar.classList.add('on');
  docsBarFill.style.width = Math.round(frac * 100) + '%';
}

function setDocsEnabled(on) {
  docsSaveBtn.disabled = !on;
  docsRunBtn.disabled  = !on || !audioFile;
  docsAskBtn.disabled  = !on;
}

// dd-mm-yy_Day — e.g. 22-08-26_Saturday. Drive treats "/" as an ordinary
// character but renders it confusingly, so the date is dash-separated.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function docsFolderName(d) {
  return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' +
         String(d.getFullYear()).slice(-2) + '_' + DAY_NAMES[d.getDay()];
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function gemini(parts) {
  // Fall back to whatever is in the box, so a key that was just typed works
  // immediately rather than only after it has been written to storage.
  const key = (localStorage.getItem(GEMINI_KEY) || docsKeyEl.value || '').trim();
  if (!key) throw new Error('Add your Gemini API key at the bottom of this panel first');

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      // The key rides in a header rather than the query string, so it can't leak
      // through browser history, a Referer, or an intermediary's request log.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || ('Gemini HTTP ' + r.status);
    throw new Error(r.status === 400 && /API key/i.test(msg) ? 'That Gemini API key was rejected' : msg);
  }

  const cand = data.candidates && data.candidates[0];
  const text = (((cand && cand.content && cand.content.parts) || [])
    .map(p => p.text || '').join('')).trim();
  if (!text) {
    throw new Error(cand && cand.finishReason && cand.finishReason !== 'STOP'
      ? 'Gemini stopped early (' + cand.finishReason + ')'
      : 'Gemini returned nothing — the audio may be silent or in an unsupported format');
  }
  return text;
}

// FileReader hands back "data:<mime>;base64,<payload>"; we only want the payload.
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('Could not read the audio file'));
    fr.readAsDataURL(blob);
  });
}

// ─── Long-audio handling ──────────────────────────────────────────────────────
// Decode to one 16 kHz mono track. decodeAudioData resamples to the context's
// rate for us; collapsing the channels is ours to do.
async function decodeMono16k(file) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio, so long recordings will not work here');

  const ctx = new Ctx(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());

  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  if (buf.numberOfChannels > 1) {
    for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
  }
  return { samples: out, rate: buf.sampleRate };
}

// 16-bit PCM WAV. Uncompressed, but each chunk is small enough to send inline
// and it's a format the API accepts without argument.
function encodeWav(samples, rate) {
  const bytes = samples.length * 2;
  const buf   = new ArrayBuffer(44 + bytes);
  const view  = new DataView(buf);
  const str   = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);  // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  str(36, 'data');
  view.setUint32(40, bytes, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim, in whatever language is spoken. Write it as ' +
  'clean readable prose with proper sentence punctuation and paragraph breaks. ' +
  'If several people speak, label the turns Speaker 1, Speaker 2, and so on. ' +
  'Output only the transcript — no preamble, no commentary.';

async function transcribe(file, onStep) {
  // Small enough to go as-is: one request, original bytes, nothing re-encoded.
  if (file.size <= AUDIO_INLINE_MAX) {
    onStep('Transcribing…', 0.35);
    return gemini([
      { text: TRANSCRIBE_PROMPT },
      { inline_data: { mime_type: file.type || 'audio/mpeg', data: await toBase64(file) } },
    ]);
  }

  onStep('Decoding audio…', 0.05);
  const { samples, rate } = await decodeMono16k(file);

  const minutes = samples.length / rate / 60;
  if (minutes > AUDIO_MAX_MINUTES) {
    throw new Error('That recording is about ' + Math.round(minutes) + ' minutes. Please split it — ' +
                    AUDIO_MAX_MINUTES + ' minutes is as much as this can hold in memory at once.');
  }

  const per   = CHUNK_SECONDS * rate;
  const total = Math.ceil(samples.length / per);
  const parts = [];

  for (let i = 0; i < total; i++) {
    onStep('Transcribing part ' + (i + 1) + ' of ' + total + '…', 0.1 + 0.85 * (i / total));
    const wav = encodeWav(samples.subarray(i * per, Math.min((i + 1) * per, samples.length)), rate);
    parts.push(await gemini([
      { text: TRANSCRIBE_PROMPT + ' This is part ' + (i + 1) + ' of ' + total +
              ' of one longer recording, so it may start or end mid-sentence — that is ' +
              'expected, just transcribe what you hear.' },
      { inline_data: { mime_type: 'audio/wav', data: await toBase64(wav) } },
    ]));
  }
  return parts.join('\n\n');
}

// The standing sections every log carries, in order, each with the instruction
// that shapes it. All of them are always emitted: where a recording doesn't cover
// one, the model says so underneath rather than dropping the heading, so every
// day's log answers the same questions and days stay comparable side by side.
// Add a heading here and it appears in every future log — nothing else to change.
const LOG_SECTIONS = [
  ['## Key notes',
   'The things from this recording actually worth remembering, as bullets. This is ' +
   'not a summary: no scene-setting, no narrating that a conversation took place, ' +
   'no sentences that would read the same for any recording. Straight to the substance.'],

  ['## What I did today',
   'Work actually carried out or moved forward, as bullets.'],

  ['## Tasks I took on or was assigned',
   'One bullet per task. Name who owns it wherever the recording says, and include ' +
   'any deadline mentioned.'],

  ['## Data specifications discussed',
   'Every data detail raised, in full, as bullets — field and column names, data ' +
   'types, formats, units, schemas, API contracts, file layouts, volumes and counts, ' +
   'thresholds, validation rules. Reproduce exact names and exact numbers verbatim: ' +
   'never round them, generalise them, or compress them away. Err towards too much ' +
   'detail here rather than too little.'],
];

function draftNotes(transcript, questions) {
  const qs = (questions || '').trim();
  const spec = LOG_SECTIONS.map(sec => sec[0] + '\n' + sec[1]).join('\n\n');

  return gemini([{ text:
    'Below is the transcript of a work voice note. Turn it into a daily work log ' +
    'someone could read later without hearing the recording. Use Markdown.\n\n' +
    'Emit these sections, with exactly these headings, in this order:\n\n' +
    spec + '\n\n' +
    'Every one of those headings must appear. Where the transcript genuinely does ' +
    'not cover a section, write \"Nothing mentioned.\" underneath it — keep the heading ' +
    'either way, and never invent content to fill one.\n\n' +
    'Do not open with a summary paragraph. Start straight at the first heading.\n\n' +
    'After those, add Decisions and Open questions only where the recording actually ' +
    'supports them, and leave them out otherwise.\n\n' +
    (qs ? 'Finally add a \"## Questions\" section answering each question below from ' +
          'the recording, repeating the question in bold before its answer. Where the ' +
          'recording does not answer one, say so plainly instead of guessing.\n\n' +
          'QUESTIONS:\n' + qs + '\n\n' : '') +
    'Keep the speaker\'s meaning and their specifics. Do not invent anything that is ' +
    'not in the transcript.\n\n' +
    'TRANSCRIPT:\n' + transcript }]);
}

// Ask something about a transcript that has already been produced, and append the
// answer to the notes — so a follow-up question doesn't mean transcribing again.
async function askAboutRecording() {
  if (docsBusy) return;
  const q = docsQuestionsEl.value.trim();
  const t = docsTranscript.value.trim();
  if (!q) return docStatus('Type a question first.', 'err');
  if (!t) return docStatus('Nothing to ask about yet — transcribe a recording first.', 'err');

  docsBusy = true; setDocsEnabled(false);
  try {
    docStatus('Asking…');
    const ans = await gemini([{ text:
      'Answer the questions below using only the transcript of a work voice note that ' +
      'follows. Repeat each question in bold before its answer, and quote the relevant ' +
      'part of the transcript where that helps. If the transcript does not answer a ' +
      'question, say so plainly rather than guessing. Use Markdown.\n\n' +
      'QUESTIONS:\n' + q + '\n\nTRANSCRIPT:\n' + t }]);

    // Don't stack a second identical heading if the first pass already made one.
    const hasHeading = /^##\s+Questions\s*$/m.test(docsNotesEl.value);
    docsNotesEl.value = (docsNotesEl.value.trim() +
                         (hasHeading ? '\n\n' : '\n\n## Questions\n\n') + ans).trim();
    docStatus('Answered — added to the notes above.', 'on');
  } catch (e) {
    docStatus(e.message, 'err');
  } finally {
    docsBusy = false; setDocsEnabled(true);
  }
}

// ─── Markdown → HTML, for the Doc ─────────────────────────────────────────────
// Enough Markdown to cover what the notes prompt produces. Every piece of text
// is escaped before any tag is added, so nothing in a transcript can inject
// markup into the Doc.
function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<i>$2</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  const out = [];
  let list = null;                                        // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }

    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }

    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }

    closeList();
    out.push('<p>' + inline(line) + '</p>');
  }
  closeList();
  return out.join('\n');
}

// ─── Drive: folders and Docs ──────────────────────────────────────────────────
// Under the drive.file scope, files.list only ever returns files this app itself
// created — which is exactly what we want. It finds the folders we made on an
// earlier day, and can't see the rest of your Drive.
async function findFolder(name, parentId) {
  const q = "mimeType='application/vnd.google-apps.folder' and trashed=false" +
            " and name='" + name.replace(/'/g, "\\'") + "'" +
            " and '" + parentId + "' in parents";
  const res = await drive('GET',
    'https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q));
  return (res && res.files && res.files[0] && res.files[0].id) || null;
}

async function ensureFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  const made = await drive('POST', 'https://www.googleapis.com/drive/v3/files', {
    name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId],
  });
  return made.id;
}

// Work Documentation / dd-mm-yy_Day, both created on demand.
async function ensureDocsFolder(when) {
  const root = await ensureFolder(DOCS_ROOT, 'root');
  return ensureFolder(docsFolderName(when), root);
}

// Upload HTML and ask Drive to convert it — that conversion is what makes the
// result a real Google Doc rather than an .html file sitting in the folder.
async function createDoc(name, html, folderId) {
  const boundary = '----tmdoc' + Date.now();
  const meta = { name: name, parents: [folderId], mimeType: 'application/vnd.google-apps.document' };

  const body =
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) +
    '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' +
    html +
    '\r\n--' + boundary + '--';

  const r = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body: body,
    });

  if (r.status === 401) {
    gcalConnected = false; accessToken = null;
    updateGcalUI(); attemptSilentReconnect();
    throw new Error('expired');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ('Drive HTTP ' + r.status));
  return data;
}

// ─── Saving ───────────────────────────────────────────────────────────────────

function renderDocsList() {
  const wrap = document.getElementById('docsList');
  if (!docs.length) { wrap.innerHTML = '<div class="empty-msg">Nothing saved yet.</div>'; return; }
  wrap.innerHTML = docs.map(d =>
    '<div class="docs-entry">' +
      '<a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a>' +
      '<span>' + esc(d.folder) + '</span>' +
    '</div>').join('');
}

function clearDocsForm() {
  docsTitleEl.value = '';
  docsBodyEl.value = '';
  docsNotesEl.value = '';
  docsTranscript.value = '';
  docsQuestionsEl.value = '';
  audioFile = null;
  docsAudioEl.value = '';
  docsDrop.classList.remove('has');
  docsDropText.textContent = 'Tap to choose a recording — or drop one here';
  docProgress(null);
  setDocsEnabled(true);
}

// True when we can actually write to Drive. Adding drive.file to the scope list
// only takes effect once approved, and a remembered device gets a silent token
// carrying the OLD scopes — so ask explicitly rather than failing later with a
// confusing 403. Shared by both save paths.
function driveReady() {
  if (!gcalConnected || !accessToken) {
    docStatus('Connect Google first — the button at the top of the page.', 'err');
    return false;
  }
  if (!driveFileGranted) {
    docStatus('This needs permission to create Drive files — approve it and the save will continue…');
    pendingDocSave = true;
    try { tokenClient.requestAccessToken({ prompt: 'consent' }); }
    catch (_) { pendingDocSave = false; }
    return false;
  }
  return true;
}

// One place the index is written, so every caller also mirrors it to storage.
function saveDocsIndex() {
  docs = docs.slice(0, 400);
  localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
}

async function saveDocEntry() {
  if (docsBusy) return;
  if (!driveReady()) return;

  const isVoice    = docsMode === 'voice';
  const notes      = (isVoice ? docsNotesEl.value : docsBodyEl.value).trim();
  const transcript = isVoice ? docsTranscript.value.trim() : '';
  const title      = docsTitleEl.value.trim() || (isVoice ? 'Voice note' : 'Note');

  if (!notes && !transcript) return docStatus('Nothing to save yet.', 'err');

  docsBusy = true; setDocsEnabled(false);
  try {
    const when = new Date();
    const folder = docsFolderName(when);

    docStatus('Finding the folder in Drive…');
    const folderId = await ensureDocsFolder(when);

    let html = '<h1>' + esc(title) + '</h1>\n' +
               '<p><i>' + esc(when.toLocaleString()) + '</i></p>\n' +
               mdToHtml(notes);
    if (transcript) {
      html += '\n<hr>\n<h2>Full transcript</h2>\n' +
              transcript.split(/\n{2,}/).map(p => '<p>' + esc(p) + '</p>').join('\n');
    }

    docStatus('Creating the Google Doc…');
    const made = await createDoc(title + ' — ' + folder,
                                 '<html><body>' + html + '</body></html>', folderId);

    // The notes are kept alongside the link so the monthly rollup and the range
    // compile can be built without re-reading every Doc back out of Drive. The
    // transcript is deliberately not kept — it lives in the daily Doc, and a
    // month of them would not fit in a single rollup anyway.
    docs.unshift({
      id: Date.now(), title: title, folder: folder, date: isoDate(when),
      createdAt: Date.now(), docId: made.id, notes: notes,
      url: made.webViewLink || ('https://docs.google.com/document/d/' + made.id + '/edit'),
    });
    saveDocsIndex();
    renderDocsList();

    docStatus('Saved · ' + DOCS_ROOT + ' / ' + folder + ' · updating the monthly log…', 'on');
    clearDocsForm();

    // Best-effort: the entry is already safely saved, so a rollup failure should
    // report itself without looking like the save failed.
    try {
      await rebuildRollup(isoDate(when).slice(0, 7));
      docStatus('Saved · ' + DOCS_ROOT + ' / ' + folder + ' · monthly log updated', 'on');
    } catch (e) {
      if (e.message !== 'expired') {
        docStatus('Entry saved. The monthly log could not be updated: ' + e.message, 'err');
      }
    }
  } catch (e) {
    docStatus(e.message === 'expired'
      ? 'Google session expired — tap Re-sync at the top, then save again.'
      : 'Could not save: ' + e.message, 'err');
  } finally {
    docsBusy = false; setDocsEnabled(true);
  }
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

function setDocsMode(mode) {
  docsMode = mode;
  for (const m of ['Write', 'Voice', 'Compile']) {
    const on = mode === m.toLowerCase();
    document.getElementById('docsMode' + m).classList.toggle('on', on);
    document.getElementById('docsPane' + m).classList.toggle('on', on);
  }
  // Compile has its own save button; the shared one would be ambiguous there.
  document.getElementById('docsSaveRow').style.display = mode === 'compile' ? 'none' : '';
  document.getElementById('docsTitle').style.display   = mode === 'compile' ? 'none' : '';
  docStatus('');
}

function pickAudio(file) {
  if (!file) return;
  audioFile = file;
  docsDrop.classList.add('has');
  docsDropText.textContent = file.name + '  ·  ' + (file.size / 1048576).toFixed(1) + ' MB';
  docsRunBtn.disabled = docsBusy;
  docStatus('');
}

document.getElementById('docsLaunch').addEventListener('click', () => {
  docsModal.classList.add('show');
  docsKeyEl.value = localStorage.getItem(GEMINI_KEY) || '';
  renderKeyState();
  renderDocsList();
  renderRollups();
  defaultCompileRange();
});
document.getElementById('docsClose').addEventListener('click', () => docsModal.classList.remove('show'));
docsModal.addEventListener('click', e => { if (e.target === docsModal) docsModal.classList.remove('show'); });

document.getElementById('docsModeWrite').addEventListener('click', () => setDocsMode('write'));
document.getElementById('docsModeVoice').addEventListener('click', () => setDocsMode('voice'));

docsAudioEl.addEventListener('change', () => pickAudio(docsAudioEl.files[0]));
docsDrop.addEventListener('dragover', e => { e.preventDefault(); docsDrop.classList.add('over'); });
docsDrop.addEventListener('dragleave', () => docsDrop.classList.remove('over'));
docsDrop.addEventListener('drop', e => {
  e.preventDefault();
  docsDrop.classList.remove('over');
  pickAudio(e.dataTransfer.files && e.dataTransfer.files[0]);
});

// The key saves itself as you type. It used to save only when a button was
// pressed, which is how you could end up retyping it on every visit — typing it
// and going straight to Transcribe left nothing stored.
function persistGeminiKey() {
  const v = docsKeyEl.value.trim();
  if (v) localStorage.setItem(GEMINI_KEY, v);
  else   localStorage.removeItem(GEMINI_KEY);
  renderKeyState();
}

// Say plainly whether a key is stored, and show the last four characters so you
// can tell one key from another without revealing the whole secret.
function renderKeyState() {
  const k  = (localStorage.getItem(GEMINI_KEY) || '').trim();
  const el = document.getElementById('docsKeyState');
  el.textContent = k ? '\u2713 Key saved in this browser (\u2026' + k.slice(-4) + ')'
                     : 'No key saved yet \u2014 voice notes need one.';
  el.className = 'docs-keystate' + (k ? ' ok' : '');
}

let keySaveTimer = null;
docsKeyEl.addEventListener('input', () => {
  clearTimeout(keySaveTimer);
  keySaveTimer = setTimeout(persistGeminiKey, 400);
});
docsKeyEl.addEventListener('blur', persistGeminiKey);

document.getElementById('docsKeyShow').addEventListener('click', () => {
  docsKeyEl.type = docsKeyEl.type === 'password' ? 'text' : 'password';
});

document.getElementById('docsKeyClear').addEventListener('click', () => {
  docsKeyEl.value = '';
  localStorage.removeItem(GEMINI_KEY);
  renderKeyState();
  docStatus('Gemini key cleared.');
});

docsRunBtn.addEventListener('click', async () => {
  if (docsBusy || !audioFile) return;
  docsBusy = true; setDocsEnabled(false);
  try {
    const transcript = await transcribe(audioFile, (msg, frac) => { docStatus(msg); docProgress(frac); });
    docsTranscript.value = transcript;

    docStatus('Writing the work log…'); docProgress(0.95);
    docsNotesEl.value = await draftNotes(transcript, docsQuestionsEl.value);

    if (!docsTitleEl.value.trim()) {
      docsTitleEl.value = audioFile.name.replace(/\.[^.]+$/, '');
    }
    docProgress(1);
    docStatus('Done — read it over, edit anything, then save.', 'on');
  } catch (e) {
    docProgress(null);
    docStatus(e.message, 'err');
  } finally {
    docsBusy = false; setDocsEnabled(true);
  }
});

docsAskBtn.addEventListener('click', askAboutRecording);
docsSaveBtn.addEventListener('click', saveDocEntry);

document.getElementById('docsModeCompile').addEventListener('click', () => setDocsMode('compile'));
document.getElementById('docsCompile').addEventListener('click', compileRange);
document.getElementById('docsSaveReview').addEventListener('click', saveReview);

// Default the range to the month so far — the common case is "what have I done
// this month", and any wider range is two clicks away.
function defaultCompileRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromEl = document.getElementById('docsFrom');
  const toEl   = document.getElementById('docsTo');
  if (!fromEl.value) fromEl.value = isoDate(first);
  if (!toEl.value)   toEl.value   = isoDate(now);
}

// ─── Monthly rollup and range compile ─────────────────────────────────────────
// Two months of daily Docs is unreadable one file at a time. Google Docs tabs
// would be the obvious answer, but the Docs API cannot create them — there is no
// CreateTabRequest, they can only be made by hand in the UI. So navigation comes
// from headings instead: each day is an <h1> in a per-month document, which Docs
// turns into a clickable outline sidebar on its own. Transcripts stay out of it,
// both to keep it readable and because a Doc caps at 1.02 million characters —
// a month of half-hour transcripts alone would be over half of that.

const ROLLUP_IDS_KEY = 'tm_doc_rollups';   // { '2026-08': fileId }
let rollupIds = {};
try { rollupIds = JSON.parse(localStorage.getItem(ROLLUP_IDS_KEY) || '{}'); } catch (_) { rollupIds = {}; }

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// Entries saved before this feature have no explicit date; fall back to when
// they were created so old logs still land in the right month.
function entryDate(e) { return e.date || isoDate(new Date(e.createdAt || e.id)); }

function monthLabel(key) {
  const parts = key.split('-');
  return MONTH_NAMES[Number(parts[1]) - 1] + ' ' + parts[0];
}
function rollupName(key) { return key + ' ' + monthLabel(key) + ' — Work Log'; }

function dayHeading(iso) {
  const p = iso.split('-').map(Number);
  return pad(p[2]) + '-' + pad(p[1]) + '-' + String(p[0]).slice(-2) +
         '_' + DAY_NAMES[new Date(p[0], p[1] - 1, p[2]).getDay()];
}

// Push note headings down a level so the rollup nests cleanly: day is h1, the
// entry title h2, and the note's own "## Key notes" becomes h3 rather than
// competing with the entry title in the outline.
function demoteHeadings(html) {
  return html.replace(/<(\/?)h([1-5])>/g, function (_, slash, n) {
    return '<' + slash + 'h' + (Number(n) + 1) + '>';
  });
}

// Built from the app's own index rather than appended to, so rebuilding is
// idempotent and self-healing. The daily Docs stay the editable source of truth;
// this one is generated, and says so at the top.
function rollupHtml(key, entries) {
  const byDay = new Map();
  for (const e of entries) {
    const d = entryDate(e);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const days = Array.from(byDay.keys()).sort();

  let h = '<h1>' + esc(monthLabel(key)) + ' — Work Log</h1>\n' +
          '<p><i>Generated from the daily entries in ' + esc(DOCS_ROOT) + ', and rebuilt every ' +
          'time one is saved — edits made here are overwritten, so edit the daily document ' +
          'instead. ' + days.length + ' day' + (days.length === 1 ? '' : 's') + ' recorded.</i></p>\n<hr>\n';

  for (const day of days) {
    h += '<h1>' + esc(dayHeading(day)) + '</h1>\n';
    for (const e of byDay.get(day)) {
      h += '<h2>' + esc(e.title) + '</h2>\n' +
           '<p><i><a href="' + esc(e.url) + '">Open the full entry</a></i></p>\n' +
           (e.notes ? demoteHeadings(mdToHtml(e.notes))
                    : '<p><i>No notes were stored for this entry.</i></p>') + '\n';
    }
    h += '<hr>\n';
  }
  return '<html><body>' + h + '</body></html>';
}

// Replace an existing Doc's contents. Drive re-converts the HTML and keeps the
// same file id, so the rollup's link stays stable across rebuilds.
async function replaceDocHtml(id, html) {
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + id +
                        '?uploadType=media&fields=id,webViewLink', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'text/html; charset=UTF-8' },
    body: html,
  });
  if (r.status === 401) {
    gcalConnected = false; accessToken = null;
    updateGcalUI(); attemptSilentReconnect();
    throw new Error('expired');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ('Drive HTTP ' + r.status));
  return data;
}

async function findDocByName(name, parentId) {
  const q = "mimeType='application/vnd.google-apps.document' and trashed=false" +
            " and name='" + name.replace(/'/g, "\\'") + "'" +
            " and '" + parentId + "' in parents";
  const res = await drive('GET',
    'https://www.googleapis.com/drive/v3/files?fields=files(id,webViewLink)&q=' + encodeURIComponent(q));
  return (res && res.files && res.files[0]) || null;
}

// Rebuild the rollup for one month. Safe to call repeatedly.
async function rebuildRollup(key) {
  const entries = docs.filter(e => entryDate(e).slice(0, 7) === key)
                      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!entries.length) return null;

  const rootId = await ensureFolder(DOCS_ROOT, 'root');
  const name = rollupName(key);
  const html = rollupHtml(key, entries);

  // A remembered id can be stale — deleted, or from another device. Fall back to
  // looking it up by name before giving up and making a second one.
  let id = rollupIds[key] || null;
  if (id) {
    try {
      const meta = await drive('GET',
        'https://www.googleapis.com/drive/v3/files/' + id + '?fields=id,trashed');
      if (!meta || meta.trashed) id = null;
    } catch (e) {
      if (e.message === 'expired') throw e;
      id = null;
    }
  }
  if (!id) {
    const found = await findDocByName(name, rootId);
    if (found) id = found.id;
  }

  let url;
  if (id) {
    const up = await replaceDocHtml(id, html);
    url = up.webViewLink || ('https://docs.google.com/document/d/' + id + '/edit');
  } else {
    const made = await createDoc(name, html, rootId);
    id = made.id;
    url = made.webViewLink || ('https://docs.google.com/document/d/' + id + '/edit');
  }

  rollupIds[key] = id;
  localStorage.setItem(ROLLUP_IDS_KEY, JSON.stringify(rollupIds));
  renderRollups();
  return url;
}

function renderRollups() {
  const wrap = document.getElementById('docsRollups');
  if (!wrap) return;
  const keys = Object.keys(rollupIds).sort().reverse();
  if (!keys.length) { wrap.innerHTML = '<div class="empty-msg">None yet.</div>'; return; }
  wrap.innerHTML = keys.map(k =>
    '<div class="docs-entry">' +
      '<a href="https://docs.google.com/document/d/' + esc(rollupIds[k]) + '/edit" ' +
        'target="_blank" rel="noopener">' + esc(monthLabel(k)) + ' — Work Log</a>' +
      '<span>' + esc(k) + '</span>' +
    '</div>').join('');
}

// ─── Compile a range ──────────────────────────────────────────────────────────

function entriesInRange(from, to) {
  return docs.filter(e => { const d = entryDate(e); return d >= from && d <= to; })
             .sort((a, b) => entryDate(a).localeCompare(entryDate(b)) ||
                             (a.createdAt || 0) - (b.createdAt || 0));
}

// A plain record of what happened, not a pitch. The rules below are ordered by
// how much damage breaking them does: inventing a result is worse than dull
// prose, and a quiet week reported as quiet is the correct answer.
function compilePrompt(entries, from, to) {
  const logs = entries.map(e =>
    '### ' + entryDate(e) + ' — ' + e.title + '\n' + (e.notes || '(no notes stored)')
  ).join('\n\n');

  return 'Below are my daily work logs from ' + from + ' to ' + to + '. Consolidate them ' +
    'into one review of that period. Use Markdown.\n\n' +
    'This is a factual record, not a pitch. In order of importance:\n' +
    '- Use only what the logs say. Never add an achievement, result, metric or ' +
    'conclusion that is not written in them.\n' +
    '- Do not inflate. Avoid "led", "drove", "spearheaded", "significantly", ' +
    '"successfully" and similar colouring unless that word appears in the log itself. ' +
    'Plain, neutral wording throughout.\n' +
    '- Carry numbers, names, dates and technical specifics through exactly as written. ' +
    'Do not round or approximate them.\n' +
    '- Where the logs are thin, or a stretch was quiet, say so plainly. Do not pad it out ' +
    'to look busier. A short honest section is the correct output.\n' +
    '- If two days contradict each other, say the logs differ rather than picking one.\n' +
    '- Do not editorialise about how the period went overall.\n\n' +
    'Structure:\n\n' +
    '## Period covered\nThe dates, and how many days have entries.\n\n' +
    '## What I worked on\nGrouped by project or theme rather than day by day. Every point ' +
    'must be traceable to a log entry.\n\n' +
    '## Tasks and ownership\nCarry through owners and deadlines as recorded, and mark which ' +
    'are still open.\n\n' +
    '## Data specifications recorded\nConsolidated across the period, exact names and numbers ' +
    'verbatim, duplicates merged.\n\n' +
    '## Decisions and approvals recorded\n\n' +
    '## Still open\nQuestions, blockers and dependencies the logs leave unresolved.\n\n' +
    'Keep every heading. Where the logs have nothing for one, write "Nothing recorded." ' +
    'underneath it.\n\n' +
    'LOGS:\n' + logs;
}

async function compileRange() {
  if (docsBusy) return;
  const from = document.getElementById('docsFrom').value;
  const to   = document.getElementById('docsTo').value;
  if (!from || !to) return docStatus('Pick both dates first.', 'err');
  if (from > to)    return docStatus('The From date is after the To date.', 'err');

  const entries = entriesInRange(from, to);
  if (!entries.length) return docStatus('No saved entries in that range.', 'err');

  docsBusy = true; setDocsEnabled(false);
  try {
    const days = new Set(entries.map(entryDate)).size;
    docStatus('Reading ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') +
              ' across ' + days + ' day' + (days === 1 ? '' : 's') + '…');
    document.getElementById('docsReview').value =
      await gemini([{ text: compilePrompt(entries, from, to) }]);
    docStatus('Compiled — read it over, then save.', 'on');
  } catch (e) {
    docStatus(e.message, 'err');
  } finally {
    docsBusy = false; setDocsEnabled(true);
  }
}

async function saveReview() {
  if (docsBusy) return;
  if (!driveReady()) return;

  const text = document.getElementById('docsReview').value.trim();
  if (!text) return docStatus('Nothing to save — compile a range first.', 'err');

  const from = document.getElementById('docsFrom').value;
  const to   = document.getElementById('docsTo').value;

  docsBusy = true; setDocsEnabled(false);
  try {
    docStatus('Creating the review document…');
    const rootId = await ensureFolder(DOCS_ROOT, 'root');
    const name = 'Work review ' + from + ' to ' + to;
    const html = '<html><body><h1>' + esc(name) + '</h1>\n' +
                 '<p><i>Compiled ' + esc(new Date().toLocaleString()) +
                 ' from the daily entries in ' + esc(DOCS_ROOT) + '.</i></p>\n' +
                 mdToHtml(text) + '</body></html>';

    const made = await createDoc(name, html, rootId);
    const url = made.webViewLink || ('https://docs.google.com/document/d/' + made.id + '/edit');

    docs.unshift({
      id: Date.now(), title: name, folder: DOCS_ROOT, date: isoDate(new Date()),
      createdAt: Date.now(), docId: made.id, url: url, notes: '', review: true,
    });
    saveDocsIndex();
    renderDocsList();
    docStatus('Review saved to ' + DOCS_ROOT, 'on');
  } catch (e) {
    docStatus(e.message === 'expired'
      ? 'Google session expired — tap Re-sync at the top, then save again.'
      : 'Could not save: ' + e.message, 'err');
  } finally {
    docsBusy = false; setDocsEnabled(true);
  }
}
