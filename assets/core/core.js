'use strict';

/* Core: config, Google auth, Drive and Calendar
   Everything the feature scripts share — tunable config, the OAuth token
   dance, the Drive and Calendar REST helpers, the daily review event, and
   the small utilities (esc, pad, todayStr, flash) used across the app.
   Loads first: the feature scripts call into this, not the other way round. */
/* ════════════════════════════════════════════════════════════════════════════
   CONFIG — edit these three lines, then deploy.
   ──────────────────────────────────────────────────────────────────────────── */

// Paste the OAuth Client ID you create in Google Cloud (see README). NOT a secret.
const GOOGLE_CLIENT_ID = '574004484248-974don3f0deh34qfufuaupt77dg1lq06.apps.googleusercontent.com';

// Your timezone, and the time of the daily review (24h clock, CAL_TIMEZONE).
// 10 + 0 = 10:00 AM.  7 + 30 = 7:30 AM.  18 + 45 = 6:45 PM.
// Change these, redeploy, then hit Re-sync: today's review event moves to the
// new time in place. Editing the event inside Google Calendar does NOT stick —
// the next sync rewrites it from here, so this is the one place to set it.
const CAL_TIMEZONE = 'Asia/Kolkata';
const DAILY_HOUR   = 11;   // 0-23
const DAILY_MINUTE = 0;    // 0-59

// Popup alerts on a task's deadline event, in minutes before the deadline.
// Empty = the deadline still appears in your calendar but never pops up.
//   []          no alerts        (current)
//   [0]         at the deadline
//   [300, 120]  5 hours and 2 hours before
// Edit this list — do not comment the line out, taskEventBody() reads it.
const DEADLINE_REMINDERS = [];

/* ════════════════════════════════════════════════════════════════════════════ */

// ─── Shared UI refs ──────────────────────────────────────────────────────────
const statusEl   = document.getElementById('status');
const gcalBtn    = document.getElementById('gcalBtn');
const gcalStatus = document.getElementById('gcalStatus');

// ─── Google Calendar state ─────────────────────────────────────────────────────
let tokenClient   = null;
let accessToken   = null;
let gcalConnected = false;
// Whether the token we hold actually carries drive.file. A device that connected
// before Work Documentation existed gets a silent token with the OLD scopes, so
// this stays false until the user approves the new one.
let driveFileGranted = false;
let syncTimer     = null;

// "Remember me" state. Once you've connected on this device, we stash a flag and
// then try to get fresh tokens SILENTLY (no popup, no consent screen) on every
// later visit. Google only re-prompts if your Google session itself has lapsed.
const GCAL_REMEMBER_KEY     = 'tm_gcal_remember';
let   silentReauth          = false;   // a silent (prompt:'') request is in flight
let   suppressSyncOnToken   = false;   // token arrived from a background refresh only
let   refreshTimer          = null;    // periodic silent-refresh interval

// ─── Google Drive sync state ───────────────────────────────────────────────────
const DRIVE_FILE_NAME = 'task-matrix.json';
let driveFileId       = localStorage.getItem('tm_drive_file') || null;  // id of the appData file
let driveModifiedSeen = localStorage.getItem('tm_drive_mtime') || null; // last modifiedTime we merged

// Called by the Google Identity Services script once it has loaded.
function initGis() {
  if (GOOGLE_CLIENT_ID.indexOf('PASTE_YOUR_CLIENT_ID') === 0) {
    setGcalStatus('Add your Google Client ID in index.html to enable alerts', 'err');
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    // calendar.events = create/update reminder events; drive.appdata = a hidden,
    // app-private file in the user's Drive that holds the task list (cross-device sync);
    // drive.file = create the Work Documentation folders and Docs. drive.file is the
    // narrow one: it reaches only files this app itself created, never the rest of
    // your Drive. Adding it means Google shows the consent screen once more.
    scope: 'https://www.googleapis.com/auth/calendar.events ' +
           'https://www.googleapis.com/auth/drive.appdata ' +
           'https://www.googleapis.com/auth/drive.file',
    callback: (resp) => {
      if (resp && resp.access_token) {
        accessToken   = resp.access_token;
        gcalConnected = true;
        silentReauth  = false;
        driveFileGranted = !!(resp.scope && resp.scope.indexOf('drive.file') !== -1);
        // Consent just came back for a save that was waiting on it — finish the job.
        if (pendingDocSave && driveFileGranted) {
          pendingDocSave = false;
          setTimeout(saveDocEntry, 0);
        }
        // Remember this device so future visits reconnect silently.
        localStorage.setItem(GCAL_REMEMBER_KEY, '1');
        updateGcalUI();
        startTokenRefresh();
        const wasBackground = suppressSyncOnToken;
        suppressSyncOnToken = false;
        if (!wasBackground) onConnected();   // full pull + reconcile on real (re)connect
      } else {
        setGcalStatus('Could not connect to Google', 'err');
      }
    },
    // Fires when a token request fails — most importantly when a SILENT
    // (prompt:'') request can't complete without showing UI. We swallow that
    // quietly and just leave the Connect button for a one-tap manual sign-in.
    error_callback: (err) => {
      suppressSyncOnToken = false;
      pendingDocSave = false;   // consent was dismissed; don't save behind their back
      if (silentReauth) {
        silentReauth = false;
        updateGcalUI();   // back to "Connect Google Calendar", no scary error
      } else {
        setGcalStatus('Sign-in was cancelled — tap Connect to retry', 'err');
      }
    },
  });
  gcalBtn.disabled = false;
  updateGcalUI();

  // Remembered device? Try to reconnect SILENTLY so the user doesn't have to tap
  // Connect every visit. If their Google session is gone, error_callback fires
  // and we fall back to the normal Connect button.
  if (localStorage.getItem(GCAL_REMEMBER_KEY) === '1') {
    silentReauth = true;
    setGcalStatus('Reconnecting to Google…');
    try { tokenClient.requestAccessToken({ prompt: '' }); }
    catch (_) { silentReauth = false; updateGcalUI(); }
  }
}

// Google access tokens last ~1 hour. While connected, quietly refresh in the
// background so a long session never interrupts you to sign in again.
function startTokenRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (gcalConnected && tokenClient) {
      suppressSyncOnToken = true;   // a refresh shouldn't trigger a full re-sync
      try { tokenClient.requestAccessToken({ prompt: '' }); }
      catch (_) { suppressSyncOnToken = false; }
    }
  }, 50 * 60 * 1000);  // every 50 minutes
}

// Try to silently recover a token after one expired mid-use, without bugging
// the user. If it works, the next scheduled sync just succeeds.
function attemptSilentReconnect() {
  if (!tokenClient || localStorage.getItem(GCAL_REMEMBER_KEY) !== '1') return;
  silentReauth = true;
  try { tokenClient.requestAccessToken({ prompt: '' }); }
  catch (_) { silentReauth = false; }
}

gcalBtn.addEventListener('click', () => {
  if (!tokenClient) return;
  // A device that has connected before should never see the full login/consent
  // screen again on tapping Connect/Re-sync — even if a 401 mid-session dropped
  // gcalConnected back to false a moment ago (e.g. token expired between syncs).
  // Only a device that has genuinely never connected needs the 'consent' prompt.
  const remembered = localStorage.getItem(GCAL_REMEMBER_KEY) === '1';
  const trySilent  = gcalConnected || remembered;
  silentReauth = trySilent;
  if (trySilent && !gcalConnected) setGcalStatus('Reconnecting to Google…');
  tokenClient.requestAccessToken({ prompt: trySilent ? '' : 'consent' });
});

function updateGcalUI() {
  if (gcalConnected) {
    gcalBtn.textContent = 'Re-sync';
    setGcalStatus('Calendar alerts: on', 'on');
  } else {
    gcalBtn.textContent = 'Connect Google Calendar';
    setGcalStatus('Calendar alerts: off');
  }
}

function setGcalStatus(text, cls) {
  gcalStatus.textContent = text;
  gcalStatus.className = 'gcal-status' + (cls ? ' ' + cls : '');
}

// Low-level Google Calendar REST call.
async function gcal(method, path, body) {
  const r = await fetch('https://www.googleapis.com/calendar/v3' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (r.status === 401) {            // token expired
    gcalConnected = false;
    accessToken = null;
    updateGcalUI();
    setGcalStatus('Refreshing Google session…');
    attemptSilentReconnect();        // recover without bugging the user, if possible
    throw new Error('expired');
  }
  if (r.status === 204) return null; // e.g. successful DELETE
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  return data;
}

// Low-level Google Drive REST call. `url` is a full Drive API URL. Returns parsed
// JSON, or the raw text when raw=true (used to download the task-list file).
// Same Bearer auth + 401→expired handling as gcal().
async function drive(method, url, body, raw) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (r.status === 401) {            // token expired
    gcalConnected = false;
    accessToken = null;
    updateGcalUI();
    setGcalStatus('Refreshing Google session…');
    attemptSilentReconnect();
    throw new Error('expired');
  }
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = JSON.parse(text).error.message || msg; } catch (_) {}
    throw new Error(msg);
  }
  if (raw) return text;
  return text ? JSON.parse(text) : null;
}

// Find (or lazily create) the hidden appData file that stores the task list.
async function ensureDriveFile() {
  if (driveFileId) return driveFileId;
  const q = encodeURIComponent("name='" + DRIVE_FILE_NAME + "'");
  const list = await drive('GET',
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&q=' + q);
  if (list && list.files && list.files.length) {
    driveFileId = list.files[0].id;
  } else {
    const meta = await drive('POST', 'https://www.googleapis.com/drive/v3/files',
      { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
    driveFileId = meta.id;
  }
  localStorage.setItem('tm_drive_file', driveFileId);
  return driveFileId;
}

// Union two task lists by id; for the same id keep the newer (larger updatedAt)
// record. eventId rides along, so a second device reuses the calendar event
// instead of duplicating it. Tombstones (deleted:true) are kept so deletes
// propagate; they're filtered out at render time.
function mergeTasks(a, b) {
  const byId = new Map();
  for (const t of a.concat(b)) {
    if (!t || t.id == null) continue;
    const prev = byId.get(t.id);
    if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

// Pull the task list from Drive and merge it into local state. Cheap-checks
// modifiedTime first so a no-op focus doesn't re-download or re-render.
async function loadFromDrive() {
  if (!gcalConnected || !accessToken) return;
  const id = await ensureDriveFile();

  const meta = await drive('GET',
    'https://www.googleapis.com/drive/v3/files/' + id + '?fields=modifiedTime');
  const mtime = meta && meta.modifiedTime;
  if (mtime && mtime === driveModifiedSeen) return;  // already merged this version

  const text = await drive('GET',
    'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', undefined, true);
  let remote = [];
  if (text) { try { remote = JSON.parse(text) || []; } catch (_) { remote = []; } }
  if (Array.isArray(remote) && remote.length) {
    tasks = mergeTasks(tasks, remote);
    localStorage.setItem('tm_tasks', JSON.stringify(tasks));
    render();
  }
  if (mtime) { driveModifiedSeen = mtime; localStorage.setItem('tm_drive_mtime', mtime); }
}

// Write the current task list to Drive and remember the resulting modifiedTime
// (so the next focus-pull doesn't re-download our own write).
async function saveToDrive() {
  if (!gcalConnected || !accessToken) return;
  const id = await ensureDriveFile();
  const meta = await drive('PATCH',
    'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media&fields=modifiedTime',
    tasks);
  if (meta && meta.modifiedTime) {
    driveModifiedSeen = meta.modifiedTime;
    localStorage.setItem('tm_drive_mtime', meta.modifiedTime);
  }
}

// Event body for a single task's deadline (absolute UTC instant + 5h/2h reminders).
function taskEventBody(t) {
  const startMs = t.deadline;
  return {
    summary: '⏰ ' + t.text,
    description: 'Deadline reminder from Task Matrix.',
    start: { dateTime: new Date(startMs).toISOString() },
    end:   { dateTime: new Date(startMs + 30 * 60000).toISOString() },
    reminders: {
      useDefault: false,
      overrides: DEADLINE_REMINDERS.map(m => ({ method: 'popup', minutes: m })),
    },
  };
}

// Single-day review event for TODAY at DAILY_HOUR, listing current Q1 tasks.
// Deliberately NOT a recurring event: an infinite RRULE:FREQ=DAILY event shows up
// on every future day forever, even days with zero Urgent+Important tasks, which
// is what was flooding the calendar. Instead we create at most one event, dated
// today, and only when there's actually something to review — so an empty board
// means no event at all, and a busy board only ever shows on the day it applies to.
const DAILY_SUMMARY = '🔴 Urgent + Important — daily review';

function dailyEventBody(q1, dateStr) {
  // Clamped so the 15-minute event always ends by 23:59: a start late enough
  // to spill past midnight would produce an invalid "24:10" and fail the sync.
  const startMin = Math.max(0, Math.min(DAILY_HOUR * 60 + DAILY_MINUTE, 23 * 60 + 44));
  const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return {
    summary: DAILY_SUMMARY,
    description: 'Urgent + Important right now:\n' + q1.map((t, i) => `${i + 1}. ${t.text}`).join('\n'),
    start: { dateTime: `${dateStr}T${hhmm(startMin)}:00`, timeZone: CAL_TIMEZONE },
    end:   { dateTime: `${dateStr}T${hhmm(startMin + 15)}:00`, timeZone: CAL_TIMEZONE },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    // Marker Google stores on the event and lets us query back by. This is what
    // makes today's review event findable from ANY device, so we update the one
    // that already exists instead of adding another. See findDailyEvents().
    extendedProperties: { private: { [DAILY_MARKER_KEY]: DAILY_MARKER_VAL } },
  };
}

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Reconcile every task and the daily event with Google Calendar.
async function syncCalendar() {
  if (!gcalConnected || !accessToken) return;
  setGcalStatus('Syncing…', 'on');

  try {
    for (const t of tasks) {
      const wantEvent = !t.deleted && !t.done && !!t.deadline;

      if (wantEvent && !t.eventId) {
        const ev = await gcal('POST', '/calendars/primary/events', taskEventBody(t));
        t.eventId = ev.id;
      } else if (wantEvent && t.eventId) {
        try {
          await gcal('PUT', '/calendars/primary/events/' + t.eventId, taskEventBody(t));
        } catch (e) {
          if (e.message === 'expired') throw e;
          // Event was deleted in Calendar — recreate it.
          const ev = await gcal('POST', '/calendars/primary/events', taskEventBody(t));
          t.eventId = ev.id;
        }
      } else if (!wantEvent && t.eventId) {
        try { await gcal('DELETE', '/calendars/primary/events/' + t.eventId); }
        catch (e) { if (e.message === 'expired') throw e; }
        t.eventId = null;
      }
    }

    await syncDailyEvent();
    localStorage.setItem('tm_tasks', JSON.stringify(tasks));
    setGcalStatus('Alerts on · synced ' + new Date().toLocaleTimeString(), 'on');
  } catch (e) {
    if (e.message !== 'expired') setGcalStatus('Sync error: ' + e.message, 'err');
    // Whatever event IDs we did get are saved so we don't duplicate next time.
    localStorage.setItem('tm_tasks', JSON.stringify(tasks));
  }
}

const DAILY_EVENT_KEY   = 'tm_daily_event_v2';   // JSON {id, date} — per-device hint, now only a fallback
const LEGACY_DAILY_KEY  = 'tm_daily_event';       // old infinitely-recurring event id, one-time cleanup

// Marker stamped onto every review event we create (see dailyEventBody). Google
// stores it on the event and lets us search events BY it, which is the whole
// point: the previous code remembered the event id in localStorage, so a second
// device — or the same device after clearing site data, or a second browser —
// had no idea an event already existed and cheerfully made another one. Nothing
// ever removed the extras, so they piled up and every copy fired its own alarm.
const DAILY_MARKER_KEY = 'tmDailyReview';
const DAILY_MARKER_VAL = '1';

// Every review event of ours in today's window. Two passes, because events made
// before this fix carry no marker:
//   1. by marker  — exact; catches everything created from now on, any device
//   2. today's events, filtered by title — catches the pre-existing duplicates
//      so they get cleaned up too
// Pass 2 reads the day's events rather than using Calendar's text search, whose
// matching on an emoji title isn't something to depend on. BOTH passes keep only
// an exact DAILY_SUMMARY match, so we can never delete an event that isn't ours.
async function findDailyEvents() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to   = new Date(from); to.setDate(to.getDate() + 1);

  const base = '/calendars/primary/events?singleEvents=true&orderBy=startTime' +
               '&timeMin=' + encodeURIComponent(from.toISOString()) +
               '&timeMax=' + encodeURIComponent(to.toISOString());

  // singleEvents=true expands a recurring series into one instance per day, so
  // what comes back for an old RRULE:FREQ=DAILY event is today's instance, whose
  // id is the master's plus a timestamp. recurringEventId points at the master —
  // we keep it, because deleting the instance only skips a single day.
  const found = new Map();   // id -> event, de-duped across both passes
  const collect = (res) => {
    for (const ev of (res && res.items) || []) {
      if (ev.id && ev.summary === DAILY_SUMMARY) found.set(ev.id, ev);
    }
  };

  collect(await gcal('GET', base + '&maxResults=50' +
    '&privateExtendedProperty=' + encodeURIComponent(DAILY_MARKER_KEY + '=' + DAILY_MARKER_VAL)));

  try {
    collect(await gcal('GET', base + '&maxResults=250'));
  } catch (e) {
    if (e.message === 'expired') throw e;   // legacy sweep is best-effort
  }

  return Array.from(found.values());
}

async function syncDailyEvent() {
  // One-time migration: the old scheme created a never-ending RRULE:FREQ=DAILY
  // event, which is what was flooding the calendar with an entry on every day
  // regardless of whether there was anything urgent. Delete it if we still have
  // its id on this device.
  const legacyId = localStorage.getItem(LEGACY_DAILY_KEY);
  if (legacyId) {
    try { await gcal('DELETE', '/calendars/primary/events/' + legacyId); }
    catch (e) { if (e.message === 'expired') throw e; }
    localStorage.removeItem(LEGACY_DAILY_KEY);
  }

  const q1 = tasks.filter(t => !t.done && !t.deleted && t.quad === 1);
  const today = todayStr();

  // Ask Calendar what is actually there rather than trusting this device's memory.
  let existing = [];
  try {
    existing = await findDailyEvents();
  } catch (e) {
    if (e.message === 'expired') throw e;
    // Couldn't list (offline, quota, ...). Fall back to this device's own id so
    // that a failed lookup can't be the reason we add yet another copy.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DAILY_EVENT_KEY) || 'null'); } catch (_) {}
    if (saved && saved.id && saved.date === today) existing = [{ id: saved.id }];
  }

  const drop = async (id) => {
    try { await gcal('DELETE', '/calendars/primary/events/' + id); }
    catch (e) { if (e.message === 'expired') throw e; }   // already gone is fine
  };

  // The very first version of this app created the review event with
  // RRULE:FREQ=DAILY — a series that never ends. Every device that connected back
  // then made its own, and they still fire every morning. They have to be deleted
  // at the MASTER (recurringEventId); deleting the instance we were handed only
  // cancels today and the series returns tomorrow, which is exactly what kept
  // happening. Nothing recurring is ever kept — today's event is always a plain
  // one-off, so any series found here is a leftover by definition.
  const series = new Set();
  const singles = [];
  for (const ev of existing) {
    if (ev.recurringEventId) series.add(ev.recurringEventId);
    else singles.push(ev);
  }
  for (const id of series) await drop(id);

  if (!q1.length) {
    // Nothing urgent+important right now — clear every review event, don't nag.
    for (const ev of singles) await drop(ev.id);
    localStorage.removeItem(DAILY_EVENT_KEY);
    return;
  }

  // Keep the first one-off, delete the rest. This is the self-heal: a calendar
  // carrying several copies collapses back to a single event on the next sync.
  for (const ev of singles.slice(1)) await drop(ev.id);

  const body = dailyEventBody(q1, today);
  const keep = singles[0];
  if (keep) {
    try {
      await gcal('PUT', '/calendars/primary/events/' + keep.id, body);
      localStorage.setItem(DAILY_EVENT_KEY, JSON.stringify({ id: keep.id, date: today }));
      return;
    } catch (e) {
      if (e.message === 'expired') throw e;
      // fall through and recreate
    }
  }
  const ev = await gcal('POST', '/calendars/primary/events', body);
  localStorage.setItem(DAILY_EVENT_KEY, JSON.stringify({ id: ev.id, date: today }));
}

// Only ever one sync in flight. Two overlapping runs was the other way copies
// appeared: a sync takes a network round-trip per task, so an edit part-way
// through (or the sync on connect, which isn't debounced) could start a second
// run while the first was still going. Both would look for today's event, both
// would see none yet, and both would create one.
let syncing    = false;
let syncQueued = false;

// Reconcile calendar, then push the (event-id-stamped) task list to Drive.
async function syncAll() {
  if (syncing) { syncQueued = true; return; }   // coalesce into one follow-up run
  syncing = true;
  try {
    await syncCalendar();
    if (!gcalConnected) return;      // syncCalendar may have hit 'expired'
    try {
      await saveToDrive();
      setGcalStatus('Synced · tasks + alerts ' + new Date().toLocaleTimeString(), 'on');
    } catch (e) {
      if (e.message !== 'expired') setGcalStatus('Drive sync error: ' + e.message, 'err');
    }
  } finally {
    syncing = false;
    if (syncQueued) { syncQueued = false; scheduleSync(); }
  }
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncAll, 800);
}

// Runs once a token arrives: pull tasks from Drive, then reconcile + push back.
async function onConnected() {
  try {
    await loadFromDrive();
  } catch (e) {
    if (e.message !== 'expired') setGcalStatus('Drive load error: ' + e.message, 'err');
  }
  syncAll();
}

// When the tab regains focus, pull any changes made on another device. The
// modifiedTime check inside loadFromDrive() makes a no-op pull cheap.
function pullOnFocus() {
  if (gcalConnected) loadFromDrive().catch(e => {
    if (e.message !== 'expired') setGcalStatus('Drive load error: ' + e.message, 'err');
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pullOnFocus();
});
window.addEventListener('focus', pullOnFocus);

// ─── Shared helpers ──────────────────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Status helpers ───────────────────────────────────────────────────────────
let flashTimer = null;

function flash(msg, ms = 2000) {
  statusEl.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(updateStatus, ms);
}

function updateStatus() {
  const n = tasks.filter(t => !t.done && !t.deleted).length;
  statusEl.textContent = n ? `${n} active task${n === 1 ? '' : 's'}` : 'All clear ✓';
}

