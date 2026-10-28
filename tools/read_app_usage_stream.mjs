// tools/read_app_usage_stream.mjs
//
// Read-only. Decodes the ScreenTime.AppUsage Biome stream that macOS 27
// started writing, turns it into app sessions, and shows:
//   - which fields appear in the records (to spot anything we don't know yet)
//   - daily totals and top apps
//   - every session in a time window
//
// Record layout as seen so far (each app switch writes a pair of records
// with the same timestamp):
//   field 1 (varint) 1 = app came on screen, 0 = app left the screen
//   field 2 (double) timestamp, Unix seconds (not Apple's 2001-based time)
//   field 3 (string) app ID
//   field 5 (varint) unknown, always 1 so far
//
// Run:
//   node tools/read_app_usage_stream.mjs                          (every session today)
//   node tools/read_app_usage_stream.mjs 2026-10-20 09:00 12:00   (any day and window)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STREAM_DIR = path.join(os.homedir(), "Library/Biome/streams/restricted/ScreenTime.AppUsage");
// Today's date on this Mac, as YYYY-MM-DD
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const [DAY = today, FROM = "00:00", TO = "23:59"] = process.argv.slice(2);
const MAX_SESSION_SECS = 4 * 60 * 60;
const TOP_APPS = 5;

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

// Every top-level field in one record: { fieldNumber: value }
function decodeFields(buf, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos, end);
    const field = Math.floor(key / 8), wire = key % 8;
    pos = p1;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos, end);
      fields[field] = v; pos = p2;
    } else if (wire === 1) {
      fields[field] = buf.readDoubleLE(pos); pos += 8;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos, end);
      fields[field] = buf.toString("utf8", p2, p2 + len); pos = p2 + len;
    } else if (wire === 5) {
      fields[field] = buf.readUInt32LE(pos); pos += 4;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return fields;
}

// Records via the SEGB v2 index at the end of the file
function readSegb(file, stats) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48 || buf.toString("latin1", 0, 4) !== "SEGB") { stats.unreadableFiles++; return []; }
  const count = buf.readUInt32LE(4);
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < count; i++) {
    const idx = buf.length - 16 * (i + 1);
    if (idx < 32) break;
    const endRel = buf.readUInt32LE(idx);
    const state = buf.readUInt32LE(idx + 4);
    const start = 32 + Math.ceil(prevEnd / 4) * 4;
    const end = 32 + endRel;
    prevEnd = endRel;
    if (end > idx || start + 8 > end) { stats.badRecords++; break; }
    if (state !== 1) { stats.deleted++; continue; }
    try { out.push(decodeFields(buf, start + 8, end)); } catch { stats.badRecords++; }
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const fmtTime = (s) => new Date(s * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const localDay = (s) => new Date(s * 1000).toLocaleDateString("en-CA");
function fmtDur(secs) {
  const m = Math.round(secs / 60), h = Math.floor(m / 60);
  if (!m && secs > 0) return "<1m";
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

// Same pairing as the archiver: one app on screen at a time
function toSessions(events) {
  events.sort((a, b) => a.ts - b.ts || a.on - b.on); // at the same instant, "left" first
  const sessions = [];
  let open = null;
  const close = (t) => {
    if (open) sessions.push({ app: open.app, start: open.ts, end: Math.min(t, open.ts + MAX_SESSION_SECS) });
    open = null;
  };
  for (const e of events) {
    if (e.on) {
      if (open && open.app === e.app) continue;
      close(e.ts);
      open = e;
    } else if (open && open.app === e.app) {
      close(e.ts);
    }
  }
  return { sessions: sessions.filter((s) => s.end > s.start), stillOpen: open };
}

function main() {
  const files = listFiles(STREAM_DIR);
  if (!files.length) { console.log(`No files in ${STREAM_DIR}`); return; }

  const stats = { unreadableFiles: 0, badRecords: 0, deleted: 0 };
  const records = files.flatMap((f) => readSegb(f, stats));

  // What fields and values show up, to catch anything new
  console.log(`${files.length} file(s), ${records.length} records ` +
    `(${stats.deleted} deleted, ${stats.badRecords} unreadable, ${stats.unreadableFiles} files in an unknown format)`);
  const fieldSummary = new Map();
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      if (!fieldSummary.has(k)) fieldSummary.set(k, new Map());
      const key = k === "2" ? "(timestamps)" : k === "3" ? "(app IDs)" : String(v);
      const m = fieldSummary.get(k);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  console.log("\nFields seen:");
  for (const [k, values] of [...fieldSummary].sort((a, b) => a[0] - b[0])) {
    const shown = [...values].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => `${v} x${n}`).join(", ");
    console.log(`  field ${k}: ${shown}`);
  }

  const events = records
    .filter((r) => typeof r[2] === "number" && typeof r[3] === "string" && (r[1] === 0 || r[1] === 1 || r[1] === undefined))
    .map((r) => ({ on: r[1] === 1, ts: r[2], app: r[3] }));
  const { sessions, stillOpen } = toSessions(events);
  const first = Math.min(...events.map((e) => e.ts)), last = Math.max(...events.map((e) => e.ts));
  console.log(`\nCovers ${new Date(first * 1000).toLocaleString()} to ${new Date(last * 1000).toLocaleString()}, ${sessions.length} sessions`);
  if (stillOpen) console.log(`On screen right now: ${stillOpen.app} since ${fmtTime(stillOpen.ts)}`);

  // Daily totals and top apps
  const byDay = new Map();
  for (const s of sessions) {
    const d = localDay(s.start);
    if (!byDay.has(d)) byDay.set(d, new Map());
    const apps = byDay.get(d);
    apps.set(s.app, (apps.get(s.app) ?? 0) + (s.end - s.start));
  }
  console.log("\nDaily totals:");
  for (const [d, apps] of [...byDay].sort()) {
    const total = [...apps.values()].reduce((a, b) => a + b, 0);
    console.log(`\n  ${d}   total ${fmtDur(total)}`);
    for (const [app, secs] of [...apps].sort((a, b) => b[1] - a[1]).slice(0, TOP_APPS)) {
      console.log(`    ${fmtDur(secs).padStart(8)}  ${app}`);
    }
  }

  // Sessions in the requested window
  const winStart = new Date(`${DAY}T${FROM}:00`).getTime() / 1000;
  const winEnd = new Date(`${DAY}T${TO}:00`).getTime() / 1000;
  console.log(`\nSessions on ${DAY} from ${FROM} to ${TO}:`);
  const inWindow = sessions.filter((s) => s.end > winStart && s.start < winEnd);
  if (!inWindow.length) console.log("  none");
  for (const s of inWindow) {
    console.log(`  ${fmtTime(s.start).padStart(11)} to ${fmtTime(s.end).padStart(11)}  ${fmtDur(s.end - s.start).padStart(7)}  ${s.app}`);
  }
}

main();
