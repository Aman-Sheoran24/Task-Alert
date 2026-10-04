'use strict';

/* Drive appData sync, for a page that is not the task board.

   core.js already does this for tasks, but it is tied to the board: it reads
   the connection bar's elements at load and would throw anywhere else. This is
   the same idea with no DOM at all, so wardrobe.html can keep its records in
   the same hidden Drive folder the task list uses.

   It only ever asks for a token silently. Connecting is done once on the main
   page; this picks that up and says so if it has not happened, rather than
   throwing a second consent screen at you from a different page. */

const WDrive = (function () {

  let tokenClient = null;
  let accessToken = null;
  let resolveReady = null;

  // Settles once we know whether we have a token, so callers can await it
  // rather than guess when sign-in finished.
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let settled = false;
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    resolveReady(ok);
  };

  const connected = () => !!accessToken;

  function remembered() {
    try { return localStorage.getItem(GCAL_REMEMBER_KEY) === '1'; }
    catch (_) { return false; }
  }

  // Called by the Google Identity Services script once it has loaded.
  function initDriveSync() {
    if (!remembered()) {
      // Never connected here. Staying local is the right default: a page that
      // throws up a consent screen on its own is worse than one that waits.
      settle(false);
      return;
    }
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: (resp) => {
          if (resp && resp.access_token) {
            accessToken = resp.access_token;
            settle(true);
            if (typeof WDrive.onConnect === 'function') WDrive.onConnect();
          } else {
            settle(false);
          }
        },
        // A silent request that cannot complete without showing something
        // lands here. Nothing to do but carry on locally.
        error_callback: () => settle(false),
      });
      tokenClient.requestAccessToken({ prompt: '' });
    } catch (_) {
      settle(false);
    }

    // Tokens last about an hour; refresh quietly so a long session does not
    // silently stop syncing.
    setInterval(() => {
      if (tokenClient) {
        try { tokenClient.requestAccessToken({ prompt: '' }); } catch (_) { /* keep going */ }
      }
    }, 50 * 60 * 1000);
  }

  // Give up waiting if the Google script never arrives — blocked, offline, or
  // simply absent. Without this, a caller awaiting ready() would hang.
  setTimeout(() => settle(false), 12000);

  async function call(method, url, body, raw) {
    if (!accessToken) throw new Error('not connected');
    const headers = { Authorization: 'Bearer ' + accessToken };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, {
      method: method, headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      accessToken = null;                       // expired; the refresh will fix it
      throw new Error('expired');
    }
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) {
      let msg = 'Drive HTTP ' + r.status;
      try { msg = JSON.parse(text).error.message || msg; } catch (_) { /* keep msg */ }
      throw new Error(msg);
    }
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  }

  const fileIds = {};          // name -> id, so we look it up once per session

  async function fileId(name) {
    if (fileIds[name]) return fileIds[name];
    const q = encodeURIComponent("name='" + name + "'");
    const list = await call('GET',
      'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id)&q=' + q);
    if (list && list.files && list.files.length) {
      fileIds[name] = list.files[0].id;
    } else {
      const made = await call('POST', 'https://www.googleapis.com/drive/v3/files',
                              { name: name, parents: ['appDataFolder'] });
      fileIds[name] = made.id;
    }
    return fileIds[name];
  }

  async function read(name) {
    const id = await fileId(name);
    const text = await call('GET',
      'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', undefined, true);
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  async function write(name, obj) {
    const id = await fileId(name);
    await call('PATCH',
      'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', obj);
  }

  return { ready, connected, read, write, initDriveSync, onConnect: null };
})();

// The GIS script calls this by name from its onload attribute.
function initDriveSync() { WDrive.initDriveSync(); }
