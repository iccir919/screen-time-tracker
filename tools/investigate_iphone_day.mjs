// tools/investigate_iphone_day.mjs
//
// Read-only. Looks closely at one day of iPhone App.InFocus data from your
// archive, to find where it differs from Apple's Screen Time:
//   - how many records that day are valid vs marked deleted
//   - the "reason" text some records carry (field 1)
//   - minutes per hour: all apps, YouTube, Control Center, and how much more
//     there would be if deleted records were counted
//   - optionally, every raw event in one hour
//
// Compare the hourly table with Apple's hourly bars (in System Settings >
// Screen Time, pick the iPhone and the day, then click an hour's bar).
//
// Run:
//   node tools/investigate_iphone_day.mjs 2026-10-19          (hourly table)
//   node tools/investigate_iphone_day.mjs 2026-10-19 14       (plus every event from 2 to 3 PM)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = path.join(os.homedir(), "screen_time_archive", "biome_raw", "App.InFocus", "remote");
const APPLE_EPOCH_OFFSET = 978307200;
const MAX_SESSION_SECS = 4 * 60 * 60;
const IGNORED_APPS = new Set(["com.apple.springboard", "com.apple.SpringBoard"]);
const WATCH = [
  ["YouTube", "com.google.ios.youtube"],
  ["Control Center", "com.apple.control-center"],
];

const DAY = process.argv[2];
const HOUR = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY ?? "")) {
  console.log("Usage: node tools/investigate_iphone_day.mjs YYYY-MM-DD [hour 0-23]");
  process.exit(0);
}

function readVarint(buf, pos, end) {
  let result = 0, mult = 1;
  while (pos < end) {
    const b = buf[pos++];
    result += (b & 0x7f) * mult;
    if (!(b & 0x80)) return [result, pos];
    mult *= 128;
    if (mult > 2 ** 63) break;
  }
  throw new Error("bad varint");
}

// App.InFocus record: field 1 reason text, 3 on/off, 4 Apple time, 6 app
function decode(buf, start, end) {
  let pos = start;
  const r = { reason: null, starting: null, ts: null, app: null };
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos, end);
    const field = Math.floor(key / 8), wire = key % 8;
    pos = p1;
    if (wire === 0) { const [v, p2] = readVarint(buf, pos, end); if (field === 3) r.starting = v === 1; pos = p2; }
    else if (wire === 1) { if (field === 4) r.ts = buf.readDoubleLE(pos) + APPLE_EPOCH_OFFSET; pos += 8; }
    else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos, end);
      const text = buf.toString("utf8", p2, p2 + len);
      if (field === 6) r.app = text;
      if (field === 1) r.reason = text;
      pos = p2 + len;
    } else if (wire === 5) pos += 4;
    else throw new Error("bad wire type");
  }
  return r.starting === null || r.ts === null || !r.app ? null : r;
}

// Every record in a SEGB file, including ones marked deleted
function readAll(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48 || buf.toString("latin1", 0, 4) !== "SEGB") return [];
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < buf.readUInt32LE(4); i++) {
    const idx = buf.length - 16 * (i + 1);
    if (idx < 32) break;
    const endRel = buf.readUInt32LE(idx), state = buf.readUInt32LE(idx + 4);
    const start = 32 + Math.ceil(prevEnd / 4) * 4, end = 32 + endRel;
    prevEnd = endRel;
    if (end > idx || start + 8 > end) break;
    try {
      const r = decode(buf, start + 8, end);
      if (r) out.push({ ...r, deleted: state !== 1 });
    } catch { /* skip */ }
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// Same pairing rules as the archiver, except Control Center keeps its own
// name here (the archiver credits it to the app it was pulled over)
function toSessions(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.starting - b.starting);
  const sessions = [];
  let open = null;
  const close = (t) => {
    if (open && !IGNORED_APPS.has(open.app)) {
      const end = Math.min(t, open.ts + MAX_SESSION_SECS);
      if (end > open.ts) sessions.push({ app: open.app, start: open.ts, end });
    }
    open = null;
  };
  for (const e of sorted) {
    if (e.starting) { if (open && open.app === e.app) continue; close(e.ts); open = e; }
    else if (open && open.app === e.app) close(e.ts);
  }
  return sessions;
}

const dedupe = (events) => {
  const seen = new Set();
  return events.filter((e) => {
    const k = `${e.ts}|${e.app}|${e.starting}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Minutes per local hour of DAY, for sessions matching `test`
function hourly(sessions, dayStart, test = () => true) {
  const mins = new Array(24).fill(0);
  for (const s of sessions) {
    if (!test(s.app)) continue;
    for (let h = 0; h < 24; h++) {
      const a = dayStart + h * 3600, b = a + 3600;
      const overlap = Math.min(b, s.end) - Math.max(a, s.start);
      if (overlap > 0) mins[h] += overlap / 60;
    }
  }
  return mins;
}

const fmtMin = (m) => (m < 0.5 ? "-" : m >= 59.5 ? "60m" : `${Math.round(m)}m`);
const fmtTotal = (m) => `${Math.floor(Math.round(m) / 60)}h ${String(Math.round(m) % 60).padStart(2, "0")}m`;
const clock = (t) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const hourLabel = (h) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);

function main() {
  if (!fs.existsSync(BASE)) { console.log(`No archived iPhone data at ${BASE}`); return; }

  // The iPhone folder: the remote device with the most iPhone-style app IDs
  let best = null;
  for (const d of fs.readdirSync(BASE)) {
    const events = listFiles(path.join(BASE, d)).flatMap(readAll);
    const score = events.filter((e) => e.app.includes(".ios") || e.app === "com.apple.MobileSMS").length;
    if (!best || score > best.score) best = { folder: d, events, score };
  }
  if (!best || !best.events.length) { console.log("No iPhone events found."); return; }

  const dayStart = new Date(`${DAY}T00:00:00`).getTime() / 1000;
  const dayEnd = dayStart + 86400;
  // Pad a few hours either side so sessions crossing midnight pair correctly
  const near = dedupe(best.events).filter((e) => e.ts > dayStart - 4 * 3600 && e.ts < dayEnd + 4 * 3600);
  const onDay = near.filter((e) => e.ts >= dayStart && e.ts < dayEnd);
  const valid = near.filter((e) => !e.deleted);

  console.log(`iPhone folder: remote/${best.folder}`);
  console.log(`${DAY}: ${onDay.length} events, ${onDay.filter((e) => e.deleted).length} of them marked deleted`);

  // Reason text (field 1)
  const reasons = new Map();
  for (const e of onDay) {
    const k = e.reason ?? "(none)";
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log("\nReason text on that day's events:");
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${r}`);

  const sessions = toSessions(valid);
  const withDeleted = toSessions(near);
  const all = hourly(sessions, dayStart);
  const allDel = hourly(withDeleted, dayStart);
  const watched = WATCH.map(([, id]) => hourly(sessions, dayStart, (a) => a === id));

  console.log("\nMinutes per hour (archive pairing rules, with Control Center shown under its own name):");
  console.log(`  ${"hour".padEnd(7)}${"all apps".padStart(10)}${WATCH.map(([n]) => n.padStart(16)).join("")}${"if deleted counted".padStart(20)}`);
  for (let h = 0; h < 24; h++) {
    if (all[h] < 0.5 && allDel[h] < 0.5) continue;
    console.log(`  ${hourLabel(h).padEnd(7)}${fmtMin(all[h]).padStart(10)}${watched.map((w) => fmtMin(w[h]).padStart(16)).join("")}${fmtMin(allDel[h]).padStart(20)}`);
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(`  ${"total".padEnd(7)}${fmtTotal(sum(all)).padStart(10)}${watched.map((w) => fmtTotal(sum(w)).padStart(16)).join("")}${fmtTotal(sum(allDel)).padStart(20)}`);

  if (HOUR !== null) {
    const a = dayStart + HOUR * 3600, b = a + 3600;
    console.log(`\nEvery event from ${hourLabel(HOUR)} to ${hourLabel((HOUR + 1) % 24)}:`);
    for (const e of near.filter((e) => e.ts >= a && e.ts < b).sort((x, y) => x.ts - y.ts)) {
      console.log(`  ${clock(e.ts).padStart(11)}  ${e.starting ? "ON " : "off"}  ${e.app}` +
        (e.reason ? `   [${e.reason}]` : "") + (e.deleted ? "   (deleted)" : ""));
    }
    console.log(`\nSessions counted in that hour:`);
    for (const s of sessions.filter((s) => s.end > a && s.start < b)) {
      console.log(`  ${clock(s.start).padStart(11)} to ${clock(s.end).padStart(11)}  ${s.app}`);
    }
  }
}

main();
