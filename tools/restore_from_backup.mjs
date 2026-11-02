// tools/restore_from_backup.mjs
//
// Puts back sessions your archive lost, from an older copy of it (a backup
// file, or one from Time Machine). Older versions of the archiver dropped
// sessions once Apple erased them; this brings them back.
//
// A session is restored only if your archive doesn't have it and doesn't
// have another session from the same source and device covering that time,
// so nothing is doubled. Screen-on periods missing from your archive are
// restored too. App names and categories aren't touched.
//
//   node --no-warnings tools/restore_from_backup.mjs <older copy>           shows what it would restore
//   node --no-warnings tools/restore_from_backup.mjs <older copy> --apply   backs up your archive, then restores
//
// Don't press Refresh while it runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ARCHIVE_DIR = path.join(os.homedir(), "screen_time_archive");
const ARCHIVE_DB = path.join(ARCHIVE_DIR, "screen_time.db");
const APPLY = process.argv.includes("--apply");
const olderArg = process.argv.slice(2).find((a) => a !== "--apply");

if (!olderArg) {
  console.log("Give the older copy, for example:\n  node --no-warnings tools/restore_from_backup.mjs ~/screen_time_archive/safe_copies/screen_time_2026-10-30.db");
  process.exit(1);
}
const OLDER_DB = path.resolve(olderArg.replace(/^~(?=\/)/, os.homedir()));
if (!fs.existsSync(OLDER_DB)) { console.log("Not found: " + OLDER_DB); process.exit(1); }
if (!fs.existsSync(ARCHIVE_DB)) { console.log("No archive found at " + ARCHIVE_DB); process.exit(1); }
if (path.resolve(OLDER_DB) === path.resolve(ARCHIVE_DB)) { console.log("That's your archive itself; give an older copy."); process.exit(1); }

const COLUMNS = ["uuid", "device_id", "device_model", "app", "start_utc", "end_utc", "seconds", "gmt_offset_secs", "source", "archived_at"];
const SCREEN_COLUMNS = ["uuid", "device_id", "start_utc", "end_utc", "gmt_offset_secs", "archived_at"];
const secs = (iso) => Date.parse(iso) / 1000;
const hours = (s) => (s / 3600).toFixed(1) + "h";

// Whether a stretch of time overlaps any of these [start, end] pairs
function coverageChecker(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const starts = sorted.map((s) => s[0]);
  const maxEnd = [];
  sorted.forEach((s, i) => { maxEnd[i] = Math.max(s[1], i ? maxEnd[i - 1] : -Infinity); });
  return (start, end) => {
    let lo = 0, hi = starts.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < end) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 && maxEnd[idx] > start;
  };
}

const older = new DatabaseSync(OLDER_DB, { readOnly: true });
const current = new DatabaseSync(ARCHIVE_DB, { readOnly: !APPLY });
current.exec("PRAGMA busy_timeout = 5000");

// ---------- app sessions ----------

const have = new Set(current.prepare("SELECT uuid FROM app_usage").all().map((r) => r.uuid));
const spansBy = new Map(); // "source|device" -> [[start, end], ...] in your archive
for (const r of current.prepare("SELECT source, device_id, start_utc, end_utc FROM app_usage").all()) {
  const key = r.source + "|" + r.device_id;
  if (!spansBy.has(key)) spansBy.set(key, []);
  spansBy.get(key).push([secs(r.start_utc), secs(r.end_utc)]);
}
const checkers = new Map();
const covered = (key, start, end) => {
  if (!checkers.has(key)) checkers.set(key, coverageChecker(spansBy.get(key) ?? []));
  return checkers.get(key)(start, end);
};

const toRestore = [];
for (const r of older.prepare("SELECT " + COLUMNS.join(", ") + " FROM app_usage").all()) {
  if (have.has(r.uuid)) continue;
  if (!r.start_utc || !r.end_utc) continue;
  if (covered(r.source + "|" + r.device_id, secs(r.start_utc), secs(r.end_utc))) continue;
  toRestore.push(r);
}

// ---------- screen-on periods ----------

const haveScreen = new Set(current.prepare("SELECT uuid FROM screen_on").all().map((r) => r.uuid));
const screenToRestore = older.prepare("SELECT " + SCREEN_COLUMNS.join(", ") + " FROM screen_on").all().filter((r) => !haveScreen.has(r.uuid));

// ---------- the report ----------

console.log((APPLY ? "Restoring" : "Would restore (dry run, nothing changes)") + " from " + OLDER_DB + "\n");
if (!toRestore.length && !screenToRestore.length) {
  console.log("Nothing to restore: your archive already has everything in that copy.");
  process.exit(0);
}
const byGroup = new Map(); // device · source -> day -> { n, s }
const apps = new Map();
for (const r of toRestore) {
  const group = (r.device_model ?? r.device_id) + " · " + r.source;
  const day = new Date(secs(r.start_utc) * 1000).toLocaleDateString("en-CA");
  if (!byGroup.has(group)) byGroup.set(group, new Map());
  const d = byGroup.get(group).get(day) ?? { n: 0, s: 0 };
  d.n++;
  d.s += r.seconds ?? 0;
  byGroup.get(group).set(day, d);
  apps.set(r.app, (apps.get(r.app) ?? 0) + (r.seconds ?? 0));
}
for (const [group, days] of byGroup) {
  const total = [...days.values()].reduce((a, d) => a + d.s, 0);
  console.log(group + ": " + [...days.values()].reduce((a, d) => a + d.n, 0) + " sessions, " + hours(total));
  for (const [day, d] of [...days].sort()) console.log("  " + day + "  " + d.n + " sessions, " + hours(d.s));
}
console.log("\nApps (most time first): " + [...apps].sort((a, b) => b[1] - a[1]).map(([a, s]) => a + " " + hours(s)).join(", "));
if (screenToRestore.length) console.log("Screen-on periods: " + screenToRestore.length);

if (!APPLY) {
  console.log("\nTo restore these, run the same command with --apply at the end.");
  process.exit(0);
}

// ---------- restore ----------

const backup = path.join(ARCHIVE_DIR, "screen_time_before_restore_" + new Date().toISOString().slice(0, 10) + ".db");
if (fs.existsSync(backup)) {
  console.log("\nBackup already exists, keeping it: " + backup);
} else {
  current.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
  console.log("\nBackup saved: " + backup);
}
const insert = current.prepare("INSERT OR IGNORE INTO app_usage (" + COLUMNS.join(", ") + ") VALUES (" + COLUMNS.map(() => "?").join(", ") + ")");
const insertScreen = current.prepare("INSERT OR IGNORE INTO screen_on (" + SCREEN_COLUMNS.join(", ") + ") VALUES (" + SCREEN_COLUMNS.map(() => "?").join(", ") + ")");
current.exec("BEGIN");
for (const r of toRestore) insert.run(...COLUMNS.map((c) => r[c]));
for (const r of screenToRestore) insertScreen.run(...SCREEN_COLUMNS.map((c) => r[c]));
current.exec("COMMIT");
current.close();
older.close();
console.log("Restored " + toRestore.length + " sessions and " + screenToRestore.length + " screen-on periods. Reload the dashboard to see them.");
console.log("\nTo undo: stop npm start, then copy the backup over your archive:\n  cp " + backup + " " + ARCHIVE_DB);
