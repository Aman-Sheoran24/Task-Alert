'use strict';

/* Reading practice
   RSVP speed-reading trainer: the passage library, the word scheduler, and
   the player controls. */
// ─── Fast Reading (RSVP) ────────────────────────────────────────────────────────
// Rapid Serial Visual Presentation: words are flashed one at a time at a fixed
// point so the eyes don't have to move (no saccades). Each word is split at its
// Optimal Recognition Point (ORP) — the focal letter, shown in red — which is the
// spot the eye naturally lands on. The "custom database" is a small library of
// saved passages kept in localStorage on this device.

const RSVP_LIB_KEY = 'tm_reading_lib';
const RSVP_WPM_KEY = 'tm_reading_wpm';

let rsvpLib     = [];
let rsvpCurId   = null;       // id of the passage being edited/read
let rsvpWords   = [];
let rsvpIdx     = 0;
let rsvpTimer   = null;
let rsvpPlaying = false;
let rsvpWpm     = parseInt(localStorage.getItem(RSVP_WPM_KEY) || '300', 10);

// UI refs
const readModal   = document.getElementById('readModal');
const readLib     = document.getElementById('readLib');
const readTitle   = document.getElementById('readTitle');
const readContent = document.getElementById('readContent');
const rsvpWordEl  = document.getElementById('rsvpWord');
const rsvpBar     = document.getElementById('rsvpBar');
const rsvpPos     = document.getElementById('rsvpPos');
const rsvpEta     = document.getElementById('rsvpEta');
const rsvpWpmEl   = document.getElementById('rsvpWpm');
const rsvpWpmLbl  = document.getElementById('rsvpWpmLabel');
const rsvpPlayBtn = document.getElementById('rsvpPlay');
const rsvpJumpText = document.getElementById('rsvpJumpText');
const readEditToggle    = document.getElementById('readEditToggle');
const readTextHintLabel = document.getElementById('readTextHintLabel');
let rsvpWordEls = [];   // cached <span> elements in rsvpJumpText, one per word

// The passage textarea and the tap-to-jump rendering share one slot and are
// never shown together — 'edit' while writing/pasting, 'tap' while reading.
let readMode = 'edit';

function applyReadMode() {
  const editing = readMode === 'edit';
  readContent.classList.toggle('hidden', !editing);
  rsvpJumpText.classList.toggle('hidden', editing);
  readEditToggle.textContent = editing ? '✓ Done' : '✏️ Edit text';
  readTextHintLabel.textContent = editing
    ? 'Editing — tap Done to pick a start point instead'
    : 'Tap a word to start reading from there';
}

readEditToggle.addEventListener('click', () => {
  readMode = readMode === 'edit' ? 'tap' : 'edit';
  if (readMode === 'tap') renderJumpText();   // reflect whatever was just typed
  applyReadMode();
  if (readMode === 'edit') readContent.focus();
});

function loadRsvpLib() {
  try { rsvpLib = JSON.parse(localStorage.getItem(RSVP_LIB_KEY) || '[]'); }
  catch (_) { rsvpLib = []; }
  if (!Array.isArray(rsvpLib)) rsvpLib = [];
  // Seed a friendly sample the very first time.
  if (!rsvpLib.length) {
    rsvpLib = [{
      id: Date.now(),
      title: 'Sample — how this works',
      text: 'Welcome to fast reading. Words appear one at a time in the same spot, so your eyes stay still instead of jumping across the line. The single red letter in each word marks the point your eye naturally focuses on. Start around three hundred words per minute, then nudge the speed up as it begins to feel easy. Reading this way takes a little practice, but it can roughly double your pace with good comprehension.'
    }];
    saveRsvpLib();
  }
}

function saveRsvpLib() { localStorage.setItem(RSVP_LIB_KEY, JSON.stringify(rsvpLib)); }

function refreshLibDropdown() {
  readLib.innerHTML = rsvpLib
    .map(p => `<option value="${p.id}">${esc(p.title || 'Untitled')}</option>`)
    .join('');
  if (rsvpCurId != null) readLib.value = String(rsvpCurId);
}

function selectPassage(id) {
  const p = rsvpLib.find(x => String(x.id) === String(id));
  if (!p) return;
  saveReadingPosition();   // persist progress on whichever passage we're leaving, if any
  rsvpCurId = p.id;
  readTitle.value = p.title || '';
  readContent.value = p.text || '';
  refreshLibDropdown();
  // Resume from wherever this passage was left off, instead of always restarting
  // at word 0 — that's the whole point of remembering a position per passage.
  rsvpIdx = p.lastIdx || 0;
  prepareWords(false);
  // A passage that already has text opens ready to tap-and-read; an empty one
  // (e.g. a freshly created passage) opens ready to type into.
  readMode = (p.text || '').trim() ? 'tap' : 'edit';
  applyReadMode();
}

// Split text into display tokens (words keep their trailing punctuation).
// resetIdx=false keeps the current rsvpIdx (used when resuming a saved passage);
// resetIdx=true (the default, e.g. when the text itself was just edited) restarts at 0.
function prepareWords(resetIdx) {
  rsvpStop();
  rsvpWords = (readContent.value || '').trim().split(/\s+/).filter(Boolean);
  if (resetIdx !== false || rsvpIdx > rsvpWords.length) rsvpIdx = 0;
  renderJumpText();
  renderRsvpIdle();
  updateRsvpMeta();
}

// The tappable passage: lets you jump straight to any word by sight instead of
// hunting for a position on an abstract slider. Rebuilt whenever the word list
// changes; the "current" highlight during playback is a cheap class toggle.
function renderJumpText() {
  rsvpJumpText.innerHTML = rsvpWords
    .map((w, i) => `<span class="w" data-idx="${i}">${esc(w)}</span>`)
    .join(' ');
  rsvpWordEls = Array.from(rsvpJumpText.querySelectorAll('.w'));
  highlightJumpWord();
}

function highlightJumpWord() {
  if (!rsvpWordEls.length) return;
  const i = Math.min(rsvpIdx, rsvpWordEls.length - 1);
  rsvpWordEls.forEach((el, idx) => el.classList.toggle('current', idx === i));
}

rsvpJumpText.addEventListener('click', e => {
  const el = e.target.closest('.w');
  if (!el) return;
  const wasPlaying = rsvpPlaying;
  rsvpStop();
  rsvpIdx = parseInt(el.dataset.idx, 10) || 0;
  if (rsvpWords[rsvpIdx]) showRsvpWord(rsvpWords[rsvpIdx]);
  updateRsvpMeta();
  saveReadingPosition();
  if (wasPlaying) rsvpPlay();
});

function renderRsvpIdle() {
  if (!rsvpWords.length) {
    rsvpWordEl.innerHTML = '<span class="rsvp-idle">Add some text above</span>';
  } else if (rsvpIdx > 0 && rsvpIdx < rsvpWords.length) {
    showRsvpWord(rsvpWords[rsvpIdx]);   // show where we'll resume from, statically
  } else {
    rsvpWordEl.innerHTML = '<span class="rsvp-idle">Press play to begin</span>';
  }
}

// Remember this passage's reading position so reopening it (or reloading the
// page) resumes here instead of forcing a restart from the beginning.
function saveReadingPosition() {
  if (rsvpCurId == null) return;
  const p = rsvpLib.find(x => String(x.id) === String(rsvpCurId));
  if (!p) return;
  p.lastIdx = rsvpIdx;
  saveRsvpLib();
}

// ORP: focal letter index grows with word length (~30% in). Matches the standard
// table for 4 / 6 / 8 / 10–13-character words.
function orpIndex(word) {
  const n = word.length;
  if (n <= 1)  return 0;
  if (n <= 5)  return 1;
  if (n <= 9)  return 2;
  if (n <= 13) return 3;
  return 4;
}

function showRsvpWord(word) {
  const i = orpIndex(word);
  const left  = word.slice(0, i);
  const pivot = word.slice(i, i + 1);
  const right = word.slice(i + 1);
  rsvpWordEl.innerHTML =
    `<span class="l">${esc(left)}</span>` +
    `<span class="p">${esc(pivot)}</span>` +
    `<span class="r">${esc(right)}</span>`;
}

function updateRsvpMeta() {
  const total = rsvpWords.length;
  rsvpPos.textContent = `${Math.min(rsvpIdx, total)} / ${total} words`;
  rsvpBar.style.width = total ? (Math.min(rsvpIdx, total) / total * 100) + '%' : '0%';
  const remaining = Math.max(total - rsvpIdx, 0);
  const secs = Math.round(remaining / rsvpWpm * 60);
  rsvpEta.textContent = remaining ? `~${Math.floor(secs / 60)}m ${secs % 60}s left` : '';
  highlightJumpWord();
}

function rsvpTick() {
  if (rsvpIdx >= rsvpWords.length) {
    rsvpIdx = 0;   // finished — next time this passage is opened, start over
    rsvpStop();
    renderRsvpIdle();
    updateRsvpMeta();
    return;
  }
  const word = rsvpWords[rsvpIdx];
  showRsvpWord(word);
  rsvpIdx++;
  updateRsvpMeta();

  // Pace: base interval per word, with natural pauses on punctuation and a small
  // bump for long words — this keeps comprehension up at speed.
  let delay = 60000 / rsvpWpm;
  if (/[,;:)\]\u2013\u2014]$/.test(word)) delay *= 1.6;
  if (/[.!?\u2026]$/.test(word))          delay *= 2.3;
  if (word.length > 8)                    delay *= 1.15;

  rsvpTimer = setTimeout(rsvpTick, delay);
}

function rsvpPlay() {
  if (!rsvpWords.length) return;
  if (rsvpIdx >= rsvpWords.length) rsvpIdx = 0;
  rsvpPlaying = true;
  rsvpPlayBtn.textContent = '⏸ Pause';
  rsvpTick();
}

function rsvpStop() {
  rsvpPlaying = false;
  clearTimeout(rsvpTimer);
  rsvpTimer = null;
  rsvpPlayBtn.textContent = '▶ Play';
  saveReadingPosition();
}

function rsvpToggle() { rsvpPlaying ? rsvpStop() : rsvpPlay(); }

// Controls
rsvpPlayBtn.addEventListener('click', rsvpToggle);
document.getElementById('rsvpReset').addEventListener('click', () => {
  rsvpStop(); rsvpIdx = 0; renderRsvpIdle(); updateRsvpMeta();
});
document.getElementById('rsvpPrev').addEventListener('click', () => {
  const wasPlaying = rsvpPlaying; rsvpStop();
  rsvpIdx = Math.max(0, rsvpIdx - 10);
  if (rsvpWords[rsvpIdx]) showRsvpWord(rsvpWords[rsvpIdx]);
  updateRsvpMeta();
  if (wasPlaying) rsvpPlay();
});
document.getElementById('rsvpNext').addEventListener('click', () => {
  const wasPlaying = rsvpPlaying; rsvpStop();
  rsvpIdx = Math.min(rsvpWords.length, rsvpIdx + 10);
  if (rsvpWords[rsvpIdx]) showRsvpWord(rsvpWords[rsvpIdx]);
  updateRsvpMeta();
  if (wasPlaying) rsvpPlay();
});

// Speed
function setWpm(v) {
  rsvpWpm = parseInt(v, 10);
  rsvpWpmEl.value = rsvpWpm;
  rsvpWpmLbl.textContent = rsvpWpm + ' WPM';
  localStorage.setItem(RSVP_WPM_KEY, String(rsvpWpm));
  document.querySelectorAll('#rsvpPresets button').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.wpm, 10) === rsvpWpm));
  updateRsvpMeta();
}
rsvpWpmEl.addEventListener('input', e => setWpm(e.target.value));
document.querySelectorAll('#rsvpPresets button').forEach(b =>
  b.addEventListener('click', () => setWpm(b.dataset.wpm)));

// Library editing
readLib.addEventListener('change', e => selectPassage(e.target.value));

document.getElementById('readNew').addEventListener('click', () => {
  const p = { id: Date.now(), title: 'New passage', text: '' };
  rsvpLib.unshift(p);
  saveRsvpLib();
  refreshLibDropdown();
  selectPassage(p.id);   // saves the outgoing passage's position, then switches
  readTitle.focus();
});

document.getElementById('readSave').addEventListener('click', () => {
  const p = rsvpLib.find(x => String(x.id) === String(rsvpCurId));
  if (!p) return;
  p.title = readTitle.value.trim() || 'Untitled';
  p.text  = readContent.value;
  saveRsvpLib();
  refreshLibDropdown();
  prepareWords();
  readMode = p.text.trim() ? 'tap' : 'edit';
  applyReadMode();
  flash('Passage saved');
});

document.getElementById('readDelete').addEventListener('click', () => {
  if (rsvpCurId == null) return;
  if (!confirm('Delete this passage?')) return;
  rsvpLib = rsvpLib.filter(x => String(x.id) !== String(rsvpCurId));
  saveRsvpLib();
  const nextId = rsvpLib[0] ? rsvpLib[0].id : null;
  if (nextId != null) {
    selectPassage(nextId);   // deleted passage is already gone from rsvpLib, so nothing stale gets saved
  } else {
    rsvpCurId = null;
    refreshLibDropdown();
    readTitle.value = ''; readContent.value = ''; prepareWords();
    readMode = 'edit'; applyReadMode();
  }
});

// Re-tokenize as the user types, so play always reflects the latest text.
// Editing the text invalidates any remembered position, so this always resets.
readContent.addEventListener('input', () => prepareWords(true));

// Open / close modal
function openReader() {
  loadRsvpLib();
  refreshLibDropdown();
  const idToOpen = rsvpCurId != null ? rsvpCurId : (rsvpLib[0] && rsvpLib[0].id);
  if (idToOpen != null) selectPassage(idToOpen);
  else applyReadMode();
  setWpm(rsvpWpm);
  readModal.classList.add('show');
}
function closeReader() { rsvpStop(); readModal.classList.remove('show'); }

document.getElementById('readLaunch').addEventListener('click', openReader);
document.getElementById('readClose').addEventListener('click', closeReader);
readModal.addEventListener('click', e => { if (e.target === readModal) closeReader(); });

// Spacebar toggles play/pause while the reader is open (unless typing in a field).
document.addEventListener('keydown', e => {
  if (!readModal.classList.contains('show')) return;
  if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); rsvpToggle();
  }
  if (e.key === 'Escape') closeReader();
});

