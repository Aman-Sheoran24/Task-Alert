'use strict';

/* Shared configuration.

   Lives on its own because two pages need it: index.html for tasks, calendar
   and work documents, and wardrobe.html for its own Drive sync. One copy of
   the client id and the scope list means they cannot drift apart and ask
   Google for different things.

   Loaded before everything else on both pages. */

/* ════════════════════════════════════════════════════════════════════════════
   CONFIG — edit these, then deploy.
   ──────────────────────────────────────────────────────────────────────────── */

// Paste the OAuth Client ID you create in Google Cloud (see README). NOT a secret.
const GOOGLE_CLIENT_ID = '574004484248-974don3f0deh34qfufuaupt77dg1lq06.apps.googleusercontent.com';

// calendar.events = create/update reminder events; drive.appdata = hidden,
// app-private files holding the task list and the wardrobe (cross-device sync);
// drive.file = the Work Documentation folders and Docs. drive.file is the
// narrow one: it reaches only files this app itself created, never the rest of
// your Drive.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

// Set once you have connected on this device, so later visits can get a token
// silently instead of showing the consent screen again. Both pages read it.
const GCAL_REMEMBER_KEY = 'tm_gcal_remember';

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
