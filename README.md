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

- **Today** (the home page) has a Day and a Week view, like Apple's Screen Time. The cards show the day and the 7-day average (click either to switch views, in place) and the 30-day average (opens Trends). **Day**: the day through the hours by device, **So far today** (against that weekday last week and its 6-week average), and the last 8 days. **Week**: a row for each of the 7 days through the hours (click a day's name to see it), the week's average day added up against the week before, and the 7 days as bars. Beside the charts, **Most used** shows the apps or categories you used (daily averages in the Week view) and is the page's color key. Clicking one, or a block on the timeline, highlights it across the page (a timeline block picks its app, or its category when Most used shows categories). While something is highlighted, a bar above the cards says so (every time on the page, cards included, is for it alone); clear it there, by clicking it again, by clicking an empty part of the timeline, or with Esc.
- **Trends** is about the last 30 days; the arrows move 30 days at a time. Cards show the daily average, the busiest day and the most used app. The category buttons under them spotlight categories in every chart, cards included: the first click shows just that category, more clicks add others, and Show all goes back to everything. Below: **Day by day**; today against an average day, added up; **Patterns**: the average day by hour, by weekday or by week; and **Top apps**, each with its daily average, a small chart of its average day by hour, and four bars for its daily average in each of the last four weeks. Clicking a day opens it in Today; clicking an app or its category in Top apps, or a category's piece of a Patterns bar, opens it on the Apps page.
- **Follow one category or app** on Today or Trends: click it in "Where the time went", the legend, or a grid's row names, and every chart shows just that, with the rest in gray. A bar at the top says what you're following, opens it on the Apps page, and clears it. Click it again to go back. The grids are all shaded the same way: each cell against the busiest one.
- **Apps**: every app by time per day, for the last 7 days, 30 days or all time, on any or all devices, grouped by category, each category with its time per day and its change from the period before. Each app shows its device, its last 14 days and its change from the period before. Pick a category above the list to see only its apps. Category and app names anywhere on the dashboard open their views. Click an app, or a category's heading, to open its own view: its numbers for the range, a line through its last 6 weeks (with each week's lightest to heaviest day), its average for each weekday, today so far against the same weekday, and when during the week you use it. A category's view also lists its apps, each with its share of the category and its own trend.
- **Organize**: your categories and app names, with each one's time per day (see below).

Color always means category: the color you pick for each one on Organize. Amounts without a category, like the hours of the week, are in grays.

Averages count only days with data, and leave out today while it's still going, so a morning doesn't pull them down. The cards say which dates they cover, and, when some days have no data, how many do ("27 of 30 days with data").

The pages need no libraries and work without internet. Only the typeface (Plus Jakarta Sans, from Google Fonts) needs it; offline, they use your system font.

### App names and categories

Open the **Organize** page (the link at the top of the dashboard, or http://localhost:3000/organize). Changes save as you make them, and the dashboard uses them the next time it loads.

- **Categories:** add your own and pick each one's color from 12 (click its color). Each category's **⋯** menu renames it, moves it up or down, or deletes it. Deleting a category moves its apps to Other. Other is always there and always gray. The order here is the order on the other pages.
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
| `public/` | The dashboard pages (HTML, CSS and browser JavaScript): `today.html` and `trends.html` (which share `dashboard.js` and `dashboard.css`), `apps.*` and `organize.*`, plus the shared `base.css`, `common.js` and `refresh.js` (the Refresh button) |
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
| `tools/find_deleted_app.mjs` | Looks everywhere for an app's history, including records Apple marked deleted (read-only) |
| `tools/restore_from_backup.mjs` | Puts back sessions your archive is missing from an older copy of it, after a preview and a backup |

## Known limitations

- **Unofficial formats.** These are Apple's internal files, not a public API. A macOS update could change them, and the scripts would need updating.
- **History starts when you start.** The first run can only save what Apple still has, about the last four weeks.
- **What's archived stays archived.** Apple erases records older than about four weeks, and those of apps you delete, inside its own files. The archiver keeps every session it has already saved, and replaces one only when Apple's files have a corrected version of the same time. Each run reports how many sessions it kept that Apple no longer has. (Versions before November 2026 dropped erased sessions; `tools/restore_from_backup.mjs` can bring them back from an older copy of your archive.)
- **Time zones.** iPhone sessions from Biome use the Mac's time zone, so days can shift if your phone was in another time zone.
- **Older devices.** Biome folders from older devices may not decode yet.
- **Game Mode** hides games from both App.InFocus and ScreenTime.AppUsage. That time shows up as untracked rather than under the game. Untracked time is Mac-only, since the screen-on records come from this Mac.

## License

MIT. See [LICENSE](LICENSE).