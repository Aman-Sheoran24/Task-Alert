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
  function makeClient() {
    if (tokenClient) return tokenClient;
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: (resp) => {
          if (resp && resp.access_token) {
            accessToken = resp.access_token;
            try { localStorage.setItem(GCAL_REMEMBER_KEY, '1'); } catch (_) { /* fine */ }
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
    } catch (_) {
      tokenClient = null;
    }
    return tokenClient;
  }

  function initDriveSync() {
    const client = makeClient();
    if (!client) { settle(false); return; }

    // Only ever silent on load. Connecting for the first time is something the
    // user asks for, not something a page does to them while they read it.
    if (remembered()) {
      try { client.requestAccessToken({ prompt: '' }); }
      catch (_) { settle(false); }
    } else {
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

  // ── a real, visible folder ────────────────────────────────────────────────
  let folderPromise = null;

  function folder() {
    if (folderPromise) return folderPromise;
    folderPromise = (async () => {
      if (typeof DRIVE_FOLDER_ID === 'string' && DRIVE_FOLDER_ID) {
        return DRIVE_FOLDER_ID;                 // one you have granted access to
      }
      const q = encodeURIComponent(
        "mimeType='application/vnd.google-apps.folder' and trashed=false and name='"
        + DRIVE_FOLDER_NAME.replace(/'/g, "\\'") + "' and 'root' in parents");
      const list = await call('GET',
        'https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + q);
      if (list && list.files && list.files.length) return list.files[0].id;
      const made = await call('POST', 'https://www.googleapis.com/drive/v3/files', {
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      });
      return made.id;
    })().catch((e) => { folderPromise = null; throw e; });
    return folderPromise;
  }

  const folderFileIds = {};    // name -> id inside that folder

  async function findInFolder(name) {
    if (folderFileIds[name]) return folderFileIds[name];
    const parent = await folder();
    const q = encodeURIComponent(
      "name='" + name + "' and trashed=false and '" + parent + "' in parents");
    const list = await call('GET',
      'https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + q);
    if (list && list.files && list.files.length) {
      folderFileIds[name] = list.files[0].id;
      return folderFileIds[name];
    }
    return null;
  }

  async function fileInFolder(name) {
    const found = await findInFolder(name);
    if (found) return found;
    const parent = await folder();
    const made = await call('POST', 'https://www.googleapis.com/drive/v3/files',
                            { name: name, parents: [parent] });
    folderFileIds[name] = made.id;
    return made.id;
  }

  // Everything in the folder, so a sync can tell in one request which photos
  // are already up there rather than asking about each in turn.
  async function listFolder() {
    const parent = await folder();
    const q = encodeURIComponent("trashed=false and '" + parent + "' in parents");
    const list = await call('GET',
      'https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=files(id,name)&q=' + q);
    return (list && list.files) || [];
  }

  // ── binary files ──────────────────────────────────────────────────────────
  // Photos go up one file each, not inside the records. A wardrobe of
  // twenty-five pictures is several megabytes; bundling them would mean
  // re-sending every one on every save, where a file each is sent once.
  async function putMedia(name, blob) {
    if (!accessToken) throw new Error('not connected');
    const id = await fileInFolder(name);
    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + accessToken,
                   'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
    if (r.status === 401) { accessToken = null; throw new Error('expired'); }
    if (!r.ok) throw new Error('Drive HTTP ' + r.status);
  }

  async function getMedia(name) {
    if (!accessToken) throw new Error('not connected');
    const id = await findInFolder(name);
    if (!id) return null;
    const r = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
    if (r.status === 401) { accessToken = null; throw new Error('expired'); }
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob || !blob.size) return null;
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  async function readFile(name) {
    const id = await fileInFolder(name);
    const text = await call('GET',
      'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', undefined, true);
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  async function writeFile(name, obj) {
    const id = await fileInFolder(name);
    await call('PATCH',
      'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', obj);
  }

  // Where to find it, for a link the user can click.
  async function folderUrl() {
    try { return 'https://drive.google.com/drive/folders/' + (await folder()); }
    catch (_) { return ''; }
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

  // Asked for by a button. Shows the consent screen if it has to.
  function connect() {
    const client = makeClient();
    if (!client) return false;
    try {
      client.requestAccessToken({ prompt: remembered() ? '' : 'consent' });
      return true;
    } catch (_) {
      return false;
    }
  }

  return { ready, connected, read, write, readFile, writeFile, folder, folderUrl,
           listFolder, putMedia, getMedia, connect, initDriveSync, onConnect: null };
})();

// The GIS script calls this by name from its onload attribute.
function initDriveSync() { WDrive.initDriveSync(); }
