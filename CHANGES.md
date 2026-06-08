# Changes — Task Matrix update

Everything below was changed in the single file **`index.html`**. Nothing else
needs editing, redeploy as usual (push to GitHub → Vercel rebuilds). Your Google
Client ID, timezone and reminder settings at the top of the script are untouched.

Summary of what was done:

1. **"Remember me" Google sign-in** — stop having to tap *Connect* every visit.
2. **Phone not loading** — explained below (this one is environmental, not a code bug).
3. **New: Activity log** of completed tasks (with timing / delay) under the four quadrants.
4. **New: Fast Reading practice** (RSVP speed-reading trainer with your own saved texts).

---

## 1. Stay signed in to Google (the "connect every time" problem)

### What was wrong
The old code only kept the Google access token in a variable in memory. As soon
as you reloaded the page that token was gone, so it always made you press
**Connect** again, and because it had no memory of you it showed the full consent
popup each time.

A browser app like this one **cannot** store a permanent login — Google's
browser sign-in (Google Identity Services token flow) deliberately only issues
short-lived (~1 hour) tokens and gives no long-term refresh token to a static
site. So "never ask again" isn't possible. But "ask silently, and only show a
popup if your Google session has truly lapsed" **is** possible, and that's what
real sites do. That's now implemented.

### What changed (in `index.html`, the `<script>` section)
- Added a remembered-device flag in `localStorage` (`tm_gcal_remember`). It's set
  the first time you successfully connect.
- **`initGis()`** was rewritten: on every page load, if that flag is present, it
  asks Google for a token **silently** (`prompt: ''` — no popup, no consent
  screen). If your Google session is still alive (it usually is on your own
  phone/laptop), you're reconnected automatically with no tap. The status bar
  briefly shows "Reconnecting to Google…" then "Calendar alerts: on".
- Added an **`error_callback`** to the token client. If the silent reconnect
  can't complete without UI (e.g. you've been signed out of Google for a long
  while), it fails *quietly* and just shows the normal **Connect** button again —
  no scary error.
- Added **`startTokenRefresh()`**: while you're connected it quietly refreshes the
  token every 50 minutes in the background, so a long session never interrupts you.
- Added **`attemptSilentReconnect()`** and wired it into the `401 (token expired)`
  handling inside `gcal()` and `drive()`. When a token expires mid-use, the app now
  tries to recover the session on its own instead of immediately telling you to
  reconnect.

### Net effect
First time on a device: you tap **Connect** once and approve (one consent screen).
After that, opening the site signs you back in automatically. You'll only see a
sign-in prompt again if you've been logged out of Google itself for a long time —
which is exactly the behaviour you asked for. A manual **Re-sync** is of course
still there whenever you want it.

> Note: this is `localStorage`, so it's **per browser, per device**. The first
> visit on a *new* phone/browser will still need the one-time Connect tap.

---

## 2. Site loads on your computer but not on your phone

This is almost certainly **not** a problem in the app's code — the same deployed
files are served to every device, and they render fine (verified). When a page
loads in one place "this afternoon" and then won't load on the phone later, it's
normally one of these, in rough order of likelihood:

1. **Stale mobile cache / bad cached load.** Mobile browsers aggressively cache.
   Fix: on the phone, hard-refresh or clear the site data —
   - *Chrome (Android):* ⋮ → History → Clear browsing data → Cached images & files,
     or open the site in an Incognito tab to test.
   - *Safari (iPhone):* Settings → Safari → Clear History and Website Data, or use a
     Private tab.
2. **Network/DNS on the phone.** Try toggling Wi‑Fi ↔ mobile data. Sometimes one
   network's DNS hasn't picked up the Vercel domain yet. Test the URL on mobile data.
3. **A transient Vercel deploy/region issue.** Check the deployment is green in the
   Vercel dashboard, and try the exact `*.vercel.app` URL (not a typo'd custom one).
4. **`http` vs `https`.** Make sure you're opening the `https://…vercel.app` URL.
   Google sign-in (and often the page) won't behave from a plain `http://` link.

If it loads in an Incognito/Private tab on the phone but not a normal tab, it's
definitely the cache — clearing site data fixes it. I deliberately did **not**
add a Service Worker to "force" offline loading, because a broken cached Service
Worker is itself a common cause of "works once, then won't load" — adding one
here would risk making this exact symptom worse, not better. If you'd like, the
next step could be a *carefully versioned* PWA/offline cache, but I'd treat that
as its own change.

---

## 3. New — Activity log of completed tasks

A panel titled **Activity log** now sits directly below the four quadrants. Every
time you tick a task as done it's recorded there, newest first, showing:

- a status badge — **Completed**, or for tasks that had a deadline, **On time**
  (green) or **Delayed** (red);
- if it had a deadline: how long **before/after** the deadline you finished it;
- how long the task **took** overall (from when it was added to when it was done);
- the time it was completed, and a **↩ reopen** link to put it back on the board.

There's a **Clear completed** button to tidy the log (it soft-deletes done tasks
the same safe way the ✕ button does, so the clear also syncs to your other
devices and removes their calendar events on the next sync).

### Where, in `index.html`
- **CSS:** new `.log-section / .log-item / .log-badge …` rules (added just above the
  `@media (max-width: 440px)` block).
- **HTML:** new `<div class="log-section" id="logSection">…` block inserted right
  after `<div class="status">`.
- **JS:**
  - `toggleDone()` now stamps `t.completedAt` (and clears it when you un-tick).
  - new `reopenTask()` helper.
  - new `fmtDuration()` and `renderLog()` functions; `renderLog()` is called from
    inside the existing `render()` loop.
  - a click handler on **Clear completed**.

The timing math uses data the app already stored: each task's `id` is its creation
timestamp, and `deadline` already existed — so "how long it took" and "how late"
needed no new bookkeeping beyond the completion timestamp.

---

## 4. New — Fast Reading practice (RSVP trainer)

A full-width **📖 Fast Reading practice** button under the activity log opens a
reading trainer. It uses **RSVP (Rapid Serial Visual Presentation)**: words are
flashed one at a time at a single fixed point so your eyes don't have to scan
across lines. Each word is split at its **Optimal Recognition Point (ORP)** — the
focal letter, shown in red — which is the spot the eye naturally lands on, so the
word is recognised faster and your gaze stays put.

What it includes:

- **Your library (the "custom database").** A dropdown of saved passages, kept in
  `localStorage`. **＋ New** adds one; a title field + text box let you paste any
  text; **Save passage** / **Delete** manage them. A friendly sample passage is
  seeded the first time so there's something to try immediately.
- **The reader.** A dark "stage" with a fixed centre line shows one word at a time,
  ORP letter in red, with a live **progress bar**, **word count**, and an **ETA**.
- **Speed control.** A slider from **100–800 WPM** plus quick presets
  (200/300/400/500/600). Your chosen speed is remembered. Punctuation
  automatically inserts slightly longer pauses (commas longer, full stops longest),
  and long words get a small extra beat — this keeps comprehension up at speed.
- **Controls.** Play/Pause, skip back/forward 10 words, restart. **Spacebar**
  toggles play/pause and **Esc** closes the reader.

### Where, in `index.html`
- **CSS:** new `.read-launch`, `.read-box`, `.rsvp-stage`, `.rsvp-word`,
  `.rsvp-controls`, etc. (added with the log styles, above the `@media` block).
- **HTML:** the launcher `<button id="readLaunch">` (after the log section) and the
  `<div class="modal" id="readModal">…` reader modal (added after the existing
  deadline modal).
- **JS:** a self-contained "Fast Reading (RSVP)" block added just before the
  `// ─── Boot ───` line — library load/save, `orpIndex()`, `showRsvpWord()`, the
  play loop `rsvpTick()`, the speed/preset/control handlers, and open/close logic.

### Where the technique comes from (the "browse the internet" part)
RSVP and ORP highlighting are the established speed-reading approach popularised by
the Spritz app and many others. Sources I used to model the behaviour:

- **Wikipedia — *Rapid serial visual presentation*** — RSVP shows words/short groups
  sequentially at one fixed location so the reader makes no saccadic eye movements;
  it also notes the trade-off that comprehension can drop and fatigue rise at very
  high speeds (hence start moderate). <https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation>
- **easyreads — *RSVP Speed Reading Guide*** — practical guidance: start at
  ~250–300 WPM, add 25–50 WPM as it gets comfortable, most people plateau around
  400–600 WPM with good comprehension; highlight the ORP in a different colour to
  accelerate recognition. <https://easyreads.ai/blog/rapid-serial-visual-presentation>
- **Rapid Reader / Clayson** — the ORP sits near ~30% into the word; this informed
  the `orpIndex()` letter-position table. <https://rapidreader.clayson.io/>
- **Spritz analysis (ScienceDirect)** — the defining idea is single-word stationary
  RSVP combined with the ORP/Optimal Viewing Position, the letter most crucial for
  recognising the word. <https://www.sciencedirect.com/science/article/abs/pii/S0747563214007663>

The `orpIndex()` thresholds (1 / 2 / 3 / 4 for words up to 5 / 9 / 13 / longer
characters) follow the standard ORP-position tables those readers use.

---

## Things to be aware of
- The reading **library is local to each device** (it isn't synced through Google
  Drive like your tasks are). If you'd like passages to sync across devices too,
  that's a straightforward follow-up — say the word.
- The Google "remember me" behaviour relies on your browser keeping `localStorage`
  and you staying signed in to Google. Clearing site data or signing out of Google
  will (correctly) require the one-time Connect again.
- No new permissions were added — the app still requests only `calendar.events`
  and `drive.appdata`.
