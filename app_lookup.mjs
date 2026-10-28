// app_lookup.mjs
//
// Shows every app in your archive with its total time, so you can check
// whether an app is there and how much time it has.
//
//   "raw"     = every record added up, overlaps included
//   "counted" = after overlap merging (what the report and dashboard use)
//
// A big gap between raw and counted means the app's time overlapped with
// other apps and was given to them instead.
//
// Run:
//   node --no-warnings app_lookup.mjs              (all apps, all devices)
//   node --no-warnings app_lookup.mjs instagram    (matching apps, day by day)

import {
  formatDuration, sortDevices, requireArchive, loadRows, mergeOverlaps,
} from "./screen_time_lib.mjs";

const SEARCH = (process.argv[2] || "").toLowerCase();

function main() {
  if (!requireArchive()) return;

  const rows = loadRows();
  const segs = mergeOverlaps(rows);

  // "device|app" -> { device, app, raw, counted, sessions, days: day -> { raw, counted, sessions } }
  const stats = new Map();
  const get = (device, app, day) => {
    const key = device + "|" + app;
    if (!stats.has(key)) stats.set(key, { device, app, raw: 0, counted: 0, sessions: 0, days: new Map() });
    const s = stats.get(key);
    if (!s.days.has(day)) s.days.set(day, { raw: 0, counted: 0, sessions: 0 });
    return [s, s.days.get(day)];
  };

  for (const r of rows) {
    const [s, d] = get(r.device, r.app, r.day);
    s.raw += r.end - r.start; d.raw += r.end - r.start;
    s.sessions++; d.sessions++;
  }
  for (const g of segs) {
    const [s, d] = get(g.device, g.app, g.day);
    s.counted += g.end - g.start; d.counted += g.end - g.start;
  }

  let list = [...stats.values()];
  if (SEARCH) list = list.filter((s) => s.app.toLowerCase().includes(SEARCH));

  if (list.length === 0) {
    console.log(`No app IDs contain "${SEARCH}". Run without a search term to see them all.`);
    return;
  }

  if (SEARCH) {
    // Day-by-day detail for each matching app
    for (const s of list.sort((a, b) => b.counted - a.counted)) {
      console.log("\n" + "=".repeat(60));
      console.log(`${s.app} on ${s.device}`);
      console.log(`Total: ${formatDuration(s.counted)} counted, ${formatDuration(s.raw)} raw, ${s.sessions} sessions`);
      console.log("=".repeat(60));
      console.log(`  ${"day".padEnd(12)}${"counted".padStart(10)}${"raw".padStart(10)}${"sessions".padStart(10)}`);
      for (const day of [...s.days.keys()].sort()) {
        const d = s.days.get(day);
        console.log(
          `  ${day.padEnd(12)}${formatDuration(d.counted).padStart(10)}` +
            `${formatDuration(d.raw).padStart(10)}${String(d.sessions).padStart(10)}`
        );
      }
    }
    console.log();
    return;
  }

  // Overview: every app per device, sorted by counted time
  for (const device of sortDevices(new Set(list.map((s) => s.device)))) {
    console.log("\n" + "=".repeat(60));
    console.log(device);
    console.log("=".repeat(60));
    console.log(`  ${"counted".padStart(8)}${"raw".padStart(9)}${"days".padStart(6)}  app`);
    for (const s of list.filter((x) => x.device === device).sort((a, b) => b.counted - a.counted)) {
      console.log(
        `  ${formatDuration(s.counted).padStart(8)}${formatDuration(s.raw).padStart(9)}` +
          `${String(s.days.size).padStart(6)}  ${s.app}`
      );
    }
  }
  console.log();
}

main();
