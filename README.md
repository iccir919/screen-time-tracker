# Screen Time Tracker

Apple only keeps about four weeks of Screen Time history. This project saves your iPhone and Mac usage into your own database on your Mac, so it's kept for as long as you want, and gives you a dashboard to explore it.

Everything runs locally. Nothing is uploaded anywhere, and Apple's files are only ever read, never changed.

Tested on macOS 14 and macOS 27. This is an independent project, not affiliated with or supported by Apple.

## Requirements

- A Mac (the scripts read Screen Time data stored on macOS)
- Node.js 22.13 or newer (uses the built-in `node:sqlite` module, so there are no dependencies to install)
- **Full Disk Access** for the app you run the scripts from: System Settings > Privacy & Security > Full Disk Access. Add Terminal (or your editor, if you use its built-in terminal), then quit and reopen it.
- For iPhone data: **Share Across Devices** turned on in Screen Time on both your iPhone and Mac, signed into the same Apple ID

## Getting started

```
git clone https://github.com/iccir919/screen-time-tracker.git
cd screen-time-tracker
npm run archive          # save your Screen Time data (the first run takes the longest)
npm start                # open the dashboard
```

If the archiver says it can't read Apple's files, Full Disk Access isn't set up yet for the app you're running it from. Add it, then quit and reopen that app.

Then:

- Run `npm run schedule -- install` so new data is saved every day (see [Run it automatically](#run-it-automatically)). Apple deletes Screen Time data after about four weeks, so anything not archived by then is gone.

## Usage

```
npm run archive          # save new Screen Time data into the archive
npm start                # open the dashboard in your browser (Ctrl+C to stop)
npm run report           # daily totals and top apps, last 7 days
npm run report -- 14     # last 14 days
npm run lookup           # every app with its total time
npm run lookup -- maps   # apps matching "maps", day by day
```

Running the archiver more often is harmless: each run only adds what's new.

### The dashboard

`npm start` runs a small server on your Mac and opens http://localhost:3000. It only listens on this Mac, so nothing is reachable from your network.

The **Refresh** button at the top saves new Screen Time data (the same as `npm run archive`) and reloads the page, keeping your filters. Next to it, the dashboard shows when the archive was last updated. If you archive from Terminal instead, just reload the page.

Refresh runs with the permissions of the app you started `npm start` from. If that's VS Code's terminal or another app rather than Terminal, that app needs Full Disk Access too.

```
npm start -- --no-open   # don't open a browser
PORT=4000 npm start      # use another port
```

It has three pages:

- **Today** (the home page): three cards at the top show the day, the 7-day average and the 30-day average, each with a bar of its categories and split by device. Click a card and the whole page follows it: the timeline (the day, or an average day by hour), the top apps or categories (that day, or per day on average), the bar chart (7 or 30 days with the average drawn in) and the hours of the week. The arrows move back and forward by a day, 7 days or 30 days, and clicking a day in the bar chart shows that day. Below, **Week by week** is a line through each of the last 6 weeks' daily average (this week so far), with a gray band from each week's lightest day to its heaviest; hover for the details, click a week to see it. The device switch (all devices, iPhone or Mac) applies to everything.
- **Apps**: every app by time per day, for the last 7 days, 30 days or all time, on any or all devices, grouped by category. Each app shows its device, its last 14 days and its change from the period before. Pick a category above the list to see only its apps. Click an app for its opens, typical and longest session, when during the day you use it, and each day (click a day to open it on the Today page).
- **Organize**: your categories and app names, with each one's time per day (see below).

Color always means category: the color you pick for each one on Organize. Amounts without a category, like the hours of the week, are in grays.

Averages count only days with data, and leave out today while it's still going, so a morning doesn't pull them down. The cards say which dates they cover, and, when some days have no data, how many do ("27 of 30 days with data").

The pages need no libraries and work without internet. Only the typeface (Plus Jakarta Sans, from Google Fonts) needs it; offline, they use your system font.

### App names and categories

Open the **Organize** page (the link at the top of the dashboard, or http://localhost:3000/organize). Changes save as you make them, and the dashboard uses them the next time it loads.

- **Categories:** add your own and pick each one's color from 10 (click its color). Each category's **⋯** menu renames it, moves it up or down, or deletes it. Deleting a category moves its apps to Other. Other is always there and always gray. The order here is the order on the other pages.
- **Apps:** rename any app and pick its category. Apps you haven't set yet are listed first. The **Set by** column shows whether an app's name and category come from the built-in list or from you, and **Reset** goes back to the built-in ones.

Common apps start with built-in names and categories (`default_apps.mjs`). Anything else shows as the last part of its app ID, under Other, until you name it. Your categories and app names are saved in your archive database, not in the project files, so they stay private and survive updates.

### Run it automatically

```
npm run schedule -- install          # every day at 10:00 PM
npm run schedule -- install 08:30    # or pick a time (24-hour)
npm run schedule -- status           # is it scheduled, and how did the last run go
npm run schedule -- run              # run the scheduled job now, to test it
npm run schedule -- uninstall        # stop running automatically
```

This uses launchd, the Mac's built-in scheduler. If the Mac is asleep or off at the scheduled time, it runs when the Mac wakes up. Each run archives new data and logs to `~/screen_time_archive/logs/archive.log`.

Scheduled runs don't go through Terminal, so **Node itself needs Full Disk Access**. The install step prints the exact path to add. If you move the project folder or update Node, run `install` again.

Without the schedule, run `npm run archive` at least every couple of weeks so nothing ages out before it's saved.

## Your data

Everything is stored in `~/screen_time_archive/`, outside the project folder:

- `screen_time.db`: the archive (SQLite), including your app names and categories
- `biome_raw/`: raw copies of Apple's Biome files, kept even after Apple deletes them
- `logs/archive.log`: output from scheduled runs

This is a detailed record of which apps you use and when, so treat it as private: don't commit it, upload it, or attach it to an issue. To start over, delete the folder.

## How it works

macOS records app usage in a few places, and the archiver reads all of them:

**Biome** (`~/Library/Biome/streams/restricted/`) holds Apple's event streams. Each file uses Apple's SEGB container format, and each record inside is a protobuf message. The archiver copies the raw files into the archive, then pairs the events into sessions.

- **ScreenTime.AppUsage** (macOS 27 and later, this Mac only) matches Apple's own Screen Time numbers most closely.
- **App.InFocus** marks each app coming on screen and leaving it. It has a `local` folder for this Mac and a `remote/<id>` folder for each synced device, which is where the iPhone data comes from.

**knowledgeC.db** (`~/Library/Application Support/Knowledge/`) is a SQLite database with older-style app usage and records of when the Mac's screen was on. Its synced iPhone data is unreliable: it arrives in batches and can stop entirely.

For each device and day, the most accurate source with data wins: ScreenTime.AppUsage, then App.InFocus, then knowledgeC. A lower source only fills in the parts of the day the better one doesn't cover.

The Screen Time screen in System Settings reads from another store (`RMAdminStore`), but macOS protects it so that not even an administrator can read it.

### Counting rules

- **Overlaps:** only one app is on screen at a time, so overlapping records are trimmed and no minute is counted twice.
- **Midnight:** sessions that cross midnight are split across both days.
- **Not counted:** the lock screen, screen saver, and home screen.
- **Control Center:** time with Control Center pulled down counts toward the app underneath it, as Apple does.
- **Missing end:** a session with no "left screen" event is cut off after 4 hours.
- **Opens:** uses of the same app less than a minute apart count as one open.
- **Untracked:** time the Mac's screen was on but no app was recorded, for 2 minutes or more. Apple's own Screen Time has this too: its "All Usage" total includes time it doesn't credit to any app. A game in Game Mode is one known cause, and there are others not yet pinned down. It's included in the daily total (as Apple does), shown hatched in the dashboard, and never credited to an app, with the last apps opened before it as a hint. If you leave the screen on and walk away, that time can count as untracked until the display sleeps.

### Compared with Apple's numbers

Per-app times have been checked against Apple's Screen Time screen and match to within a few minutes.

Daily iPhone totals can come out lower than Apple's. Apple's iPhone total includes time it doesn't credit to any app (the gray part of its bars), such as some phone calls, and that time isn't in the synced data. Calls that are recorded show up as "Phone calls".

## Files

| File | Purpose |
|---|---|
| `archive_screen_time.mjs` | Reads Biome and knowledgeC and saves new sessions to the archive |
| `server.mjs` | The local dashboard server and its API |
| `public/` | The dashboard pages (HTML, CSS and browser JavaScript): `today.*`, `apps.*` and `organize.*`, plus the shared `base.css`, `common.js` and `refresh.js` (the Refresh button) |
| `screen_time_report.mjs` | Daily totals and top apps in the terminal |
| `app_lookup.mjs` | Per-app totals, for checking numbers against Apple |
| `schedule_archive.mjs` | Sets up the daily automatic run |
| `default_apps.mjs` | Built-in names and categories for common apps |
| `screen_time_lib.mjs` | Shared code: paths, device names, source selection, overlap merging, app settings |
| `tools/` | Discovery scripts used to work out where Apple stores the data. Useful if a macOS update changes the formats. |

### Tools

All of these only read data.

| Script | What it shows |
|---|---|
| `tools/check_screen_time_data.mjs` | What's in knowledgeC and the Biome folders on this Mac |
| `tools/find_screen_time_store.mjs` | Whether the protected `RMAdminStore` can be read |
| `tools/inspect_biome.mjs` | Which app IDs appear in each archived Biome device folder |
| `tools/dump_biome_records.mjs` | The raw structure of a few records from any Biome stream |
| `tools/read_app_usage_stream.mjs` | Sessions from the ScreenTime.AppUsage stream (macOS 27) |
| `tools/inspect_games_db.mjs` | Whether the protected Games.RecentlyPlayed database can be read |
| `tools/investigate_iphone_day.mjs` | One iPhone day hour by hour, to compare with Apple's hourly bars |

## Known limitations

- **Unofficial formats.** These are Apple's internal files, not a public API. A macOS update could change them, and the scripts would need updating.
- **History starts when you start.** The first run can only save what Apple still has, about the last four weeks.
- **Time zones.** iPhone sessions from Biome use the Mac's time zone, so days can shift if your phone was in another time zone.
- **Older devices.** Biome folders from older devices may not decode yet.
- **Game Mode** hides games from both App.InFocus and ScreenTime.AppUsage. That time shows up as untracked rather than under the game. Untracked time is Mac-only, since the screen-on records come from this Mac.

## License

MIT. See [LICENSE](LICENSE).