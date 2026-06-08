# Task Matrix + Google Calendar Alerts

An Eisenhower (Urgent–Important) task board that schedules its reminders as **Google Calendar events in your own account** — no bot, no database, no backend server.

- **Each task with a deadline** becomes a calendar event with popup reminders **5 hours** and **2 hours** before. The task name is the notification.
- **Every day at 10:00** a recurring "Urgent + Important — daily review" event fires, with your current Q1 tasks listed in its description.
- **Your task list syncs across every device** through a hidden, app-private file in your own Google Drive (`appDataFolder`). Sign in on any device and the same tasks appear. The alerts live in your Google Calendar. Nothing is sent to any third party.
- **Completed tasks are logged** in an Activity log below the board, showing whether each was on time or delayed and how long it took.
- **Fast Reading practice** — a built-in RSVP speed-reading trainer: save your own passages and read them one word at a time at an adjustable speed. (See `CHANGES.md` for details and sources.)

The whole app is one file: `index.html`.

---

## How the alerts actually fire

Once a calendar event exists, **Google** delivers its reminders — as notifications in the Google Calendar app on your phone — whether or not this webpage is open. The webpage's only job is to create and update those events while you're using it. So you can close the app and still get every reminder.

> Requirement: have the **Google Calendar app installed on your phone**, signed into the same Google account, with **notifications turned on** and your **primary calendar synced**. (Most people already do.)

---

## Setup (about 15 minutes, one time)

### 1. Push to GitHub
Use a **personal** repo (Vercel's free plan won't connect to org-owned repos).
```bash
git init
git add .
git commit -m "Task Matrix with Google Calendar alerts"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/task-matrix.git
git push -u origin main
```

### 2. Deploy to Vercel (do this before the Google step — you need the URL)
1. Sign in at https://vercel.com with GitHub, **Import** the repo.
2. Framework preset: **Other**. No build settings needed. **Deploy**.
3. Copy your live URL, e.g. `https://task-matrix.vercel.app`.

### 3. Create a Google OAuth Client ID
1. Go to https://console.cloud.google.com → create a project (any name).
2. **APIs & Services → Library →** enable **both**: search **Google Calendar API → Enable**, then search **Google Drive API → Enable**. (Calendar = the alerts; Drive = the cross-device task sync.)
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**. Fill the required name/email fields.
   - **Add yourself as a Test user** (your own Google email). Leave it in **Testing** — you do not need Google to "verify" the app for personal use.
   - Scope: you can leave scopes empty here; the app requests `calendar.events` and `drive.appdata` at sign-in.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins** — add both:
     - `https://YOUR-PROJECT.vercel.app` (your Vercel URL, no trailing slash)
     - `http://localhost:3000` (optional, for local testing)
   - Create, then **copy the Client ID** (looks like `1234-abcd.apps.googleusercontent.com`).

### 4. Paste the Client ID into the app
Open `index.html`, find the top of the `<script>` section, and set:
```js
const GOOGLE_CLIENT_ID = '1234-abcd.apps.googleusercontent.com';
```
While you're there, the timezone and times are also here if you want to change them:
```js
const CAL_TIMEZONE = 'Asia/Kolkata';   // your timezone
const DAILY_HOUR   = 10;               // daily review at 10:00
const REMIND_5H    = 300;              // minutes before deadline
const REMIND_2H    = 120;
```
Commit and push — Vercel redeploys automatically.

### 5. Connect and test
1. Open your live site, tap **Connect Google Calendar**.
2. A Google sign-in appears. Because the app is in "Testing", you'll see an **"unverified app"** screen — this is normal for a personal app you built. Click **Advanced → Continue** (you're the only user).
3. Add a test task with a deadline ~5 hours away. Open Google Calendar — you should see an `⏰` event with two reminders, plus the recurring 10:00 review event.

Done. The reminders now fire on their own.

---

## Adjusting things later
- **Daily time / timezone / reminder offsets** — edit the four `const` lines at the top of `index.html`, push.
- Want an **email reminder** as a backup too? In `taskEventBody`, add `{ method: 'email', minutes: 120 }` to the `overrides` list.

---

## Good to know / limitations
- **Tasks sync across devices via Google Drive.** Once you tap **Connect** on a device, the task list is read from (and written to) a hidden, app-private file in your Drive, so every signed-in device shows the same tasks. Changes you make on one device appear on another the next time it's brought to the foreground. A local copy is also kept in `localStorage` so the board still loads instantly and works offline; it reconciles with Drive on the next sync. Because the file carries each event's id, a second device **reuses** existing calendar events instead of creating duplicates.
- **Deleting a task** leaves a small hidden "tombstone" in the synced file so the deletion propagates to your other devices (it won't reappear). These are invisible in the app.
- **The 10:00 notification title is a fixed nudge** ("Urgent + Important — daily review"); the live task list is in the event's **description**. A live list in the popup itself would require a always-on backend, which this design deliberately avoids.
- **Sign-in is remembered on each device.** The first time on a device you tap **Connect** once and approve; after that the app reconnects to Google silently on later visits and refreshes your session in the background, so you won't normally have to tap Connect again. You'll only be asked to sign in again if you've been signed out of Google itself for a long while. Your existing calendar events keep firing regardless.
- **Editing or removing a task** updates/deletes its calendar event on the next sync automatically.
- Must be served over **https** (Vercel) or `http://localhost` — Google sign-in won't run from a `file://` page.
- Only **`calendar.events`** and **`drive.appdata`** are requested. The app can manage its own events but cannot read the rest of your calendar, and with `drive.appdata` it can only touch its own hidden file — it cannot see any other files in your Drive.
