// screen_time_report.mjs
//
// Prints daily screen time totals and top apps from your archive, in
// local time, so you can compare against Apple's Screen Time screen.
//
// Overlapping or duplicate records are merged so no minute is counted
// twice, and sessions that cross midnight are split across both days.
// "Untracked" is time the Mac's screen was on but no app was recorded (for
// example, a game in Game Mode). Apple's Screen Time counts it in "All
// Usage" without listing an app, so the total includes it and the line
// shows the split.
//
// Run:
//   node --no-warnings screen_time_report.mjs        (last 7 days)
//   node --no-warnings screen_time_report.mjs 14     (last 14 days)

import {
  formatDuration, weekday, lastDays, sortDevices, requireArchive, loadRows, mergeOverlaps,
  loadScreenOn, untrackedGaps,
} from "./screen_time_lib.mjs";

const DAYS = Number(process.argv[2]) || 7;
const TOP_APPS = 5;

function main() {
  if (!requireArchive()) return;

  const rows = loadRows();
  const segs = mergeOverlaps(rows);
  const days = lastDays(DAYS);

  // device -> day -> app -> seconds (after removing overlaps)
  const counted = new Map();
  for (const s of segs) {
    if (!counted.has(s.device)) counted.set(s.device, new Map());
    const byDay = counted.get(s.device);
    if (!byDay.has(s.day)) byDay.set(s.day, new Map());
    const apps = byDay.get(s.day);
    apps.set(s.app, (apps.get(s.app) ?? 0) + (s.end - s.start));
  }

  // device -> day -> untracked seconds
  const untracked = new Map();
  for (const g of untrackedGaps(segs, loadScreenOn())) {
    if (!untracked.has(g.device)) untracked.set(g.device, new Map());
    const byDay = untracked.get(g.device);
    byDay.set(g.day, (byDay.get(g.day) ?? 0) + (g.end - g.start));
  }

  // device -> day -> seconds before removing overlaps
  const raw = new Map();
  for (const r of rows) {
    if (!raw.has(r.device)) raw.set(r.device, new Map());
    const byDay = raw.get(r.device);
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.end - r.start));
  }

  for (const device of sortDevices(counted.keys())) {
    console.log("\n" + "=".repeat(60));
    console.log(device);
    console.log("=".repeat(60));

    for (const day of days) {
      const apps = counted.get(device).get(day);
      if (!apps) {
        console.log(`\n${weekday(day)} ${day}   no data`);
        continue;
      }
      const total = [...apps.values()].reduce((a, b) => a + b, 0);
      const rawTotal = raw.get(device).get(day) ?? 0;

      const gapSecs = untracked.get(device)?.get(day) ?? 0;
      let line = `\n${weekday(day)} ${day}   total ${formatDuration(total + gapSecs)}`;
      if (gapSecs) line += `   (${formatDuration(total)} in apps + ${formatDuration(gapSecs)} untracked)`;
      if (rawTotal - total > 60) line += `   (${formatDuration(rawTotal)} before removing overlaps)`;
      console.log(line);

      const top = [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_APPS);
      for (const [app, secs] of top) {
        console.log(`  ${formatDuration(secs).padStart(8)}  ${app}`);
      }
    }
  }
  console.log();
}

main();
