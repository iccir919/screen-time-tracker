// tools/find_deleted_app.mjs
//
// Read-only. Looks for an app's history everywhere it could still be, for
// example after the app was deleted and Apple erased its Screen Time
// records. It changes nothing.
//
//   1. Your archive database: rows from any source, including ones the
//      dashboard doesn't show because a better source covered that day
//   2. The archiver's saved copies of Apple's Biome files
//      (~/screen_time_archive/biome_raw), including records marked deleted
//   3. Apple's live Biome files and knowledgeC.db (needs Full Disk Access
//      for Terminal; skipped with a note if it can't read them)
//
// For records marked deleted, it tries to read them anyway: Apple may only
// flip a flag and leave the contents in place.
//
// Run, with part of the app's ID or name:
//   node tools/find_deleted_app.mjs grindr

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = os.homedir();
const ARCHIVE_DB = path.join(HOME, "screen_time_archive", "screen_time.db");
const BIOME_RAW_DIR = path.join(HOME, "screen_time_archive", "biome_raw");
const BIOME_LIVE_DIR = path.join(HOME, "Library/Biome/streams/restricted");
const KNOWLEDGE_DB = path.join(HOME, "Library/Application Support/Knowledge/knowledgeC.db");
const APPLE_EPOCH_OFFSET = 978307200;

// The same field layout the archiver uses (archive_screen_time.mjs)
const STREAMS = [
  { name: "App.InFocus", stateField: 3, timeField: 4, appField: 6, toUnix: (t) => t + APPLE_EPOCH_OFFSET },
  { name: "ScreenTime.AppUsage", stateField: 1, stateDefault: 0, timeField: 2, appField: 3, toUnix: (t) => t },
];

const term = (process.argv[2] ?? "").toLowerCase();
if (!term) {
  console.log("Give part of the app's ID or name, for example: node tools/find_deleted_app.mjs grindr");
  process.exit(1);
}

const localDay = (unixSecs) => new Date(unixSecs * 1000).toLocaleDateString("en-CA"); // 2026-10-05
const clock = (unixSecs) => new Date(unixSecs * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const mins = (secs) => (secs < 60 ? "<1m" : Math.round(secs / 60) + "m");
const isPermissionError = (err) => err && (err.code === "EPERM" || err.code === "EACCES" || /authoriz|permission|not permitted/i.test(err.message));

// ---------- 1. the archive database ----------

function checkArchive() {
  console.log("1. Your archive database");
  if (!fs.existsSync(ARCHIVE_DB)) return console.log("   No archive found at " + ARCHIVE_DB + "\n");
  const db = new DatabaseSync(ARCHIVE_DB, { readOnly: true });
  const rows = db.prepare(
    `SELECT app, source, device_model, start_utc, seconds FROM app_usage
     WHERE lower(app) LIKE ? ORDER BY start_utc`
  ).all("%" + term + "%");
  db.close();
  if (!rows.length) return console.log("   Nothing matching \"" + term + "\".\n");
  const groups = new Map(); // source/device/app -> day -> { n, secs }
  for (const r of rows) {
    const key = r.source + " · " + (r.device_model ?? "unknown device") + " · " + r.app;
    if (!groups.has(key)) groups.set(key, new Map());
    const day = localDay(Date.parse(r.start_utc) / 1000);
    const d = groups.get(key).get(day) ?? { n: 0, secs: 0 };
    d.n++;
    d.secs += r.seconds ?? 0;
    groups.get(key).set(day, d);
  }
  for (const [key, days] of groups) {
    const total = [...days.values()].reduce((a, d) => a + d.secs, 0);
    console.log("   " + key + ": " + days.size + " days, " + mins(total) + " in all");
    for (const [day, d] of days) console.log("     " + day + "  " + d.n + " uses, " + mins(d.secs));
  }
  console.log("");
}

// ---------- 2 and 3. Biome files ----------

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

function decodeEvent(buf, start, end, stream) {
  let pos = start, starting = null, ts = null, app = null;
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos, end);
    const field = Math.floor(key / 8), wire = key % 8;
    pos = p1;
    if (wire === 0) { const [v, p2] = readVarint(buf, pos, end); if (field === stream.stateField) starting = v; pos = p2; }
    else if (wire === 1) { if (pos + 8 > end) throw new Error("short"); if (field === stream.timeField) ts = buf.readDoubleLE(pos); pos += 8; }
    else if (wire === 2) { const [len, p2] = readVarint(buf, pos, end); if (p2 + len > end) throw new Error("long"); if (field === stream.appField) app = buf.toString("utf8", p2, p2 + len); pos = p2 + len; }
    else if (wire === 5) pos += 4;
    else throw new Error("wire " + wire);
  }
  if (starting === null) starting = stream.stateDefault ?? null;
  if (starting === null || ts === null || !app) return null;
  return { starting: starting === 1, ts: stream.toUnix(ts), app };
}

// Every record in a SEGB file, valid or marked deleted
function readAllRecords(file, stream, totals) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48 || buf.toString("latin1", 0, 4) !== "SEGB") return [];
  const count = buf.readUInt32LE(4);
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < count; i++) {
    const idx = buf.length - 16 * (i + 1);
    if (idx < 32) break;
    const endRel = buf.readUInt32LE(idx);
    const state = buf.readUInt32LE(idx + 4);
    const recStart = 32 + Math.ceil(prevEnd / 4) * 4, recEnd = 32 + endRel;
    prevEnd = endRel;
    if (recEnd > idx || recStart + 8 > recEnd) break;
    const deleted = state !== 1;
    if (deleted) totals.deleted++;
    let ev = null;
    try { ev = decodeEvent(buf, recStart + 8, recEnd, stream); } catch { /* unreadable */ }
    // A deleted record whose bytes were wiped decodes to nothing
    if (deleted && !ev) totals.deletedEmpty++;
    if (ev) out.push({ ...ev, deleted });
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function checkBiome(label, root) {
  console.log(label);
  for (const stream of STREAMS) {
    const dir = path.join(root, stream.name);
    let files;
    try {
      if (!fs.existsSync(dir)) { console.log("   " + stream.name + ": not here"); continue; }
      files = listFiles(dir);
    } catch (err) {
      console.log("   " + stream.name + ": " + (isPermissionError(err) ? "can't read it (give Terminal Full Disk Access to check this one)" : err.message));
      continue;
    }
    const totals = { deleted: 0, deletedEmpty: 0 };
    const matches = new Map(); // day -> { valid, deleted, first, last, apps }
    let unreadable = 0;
    for (const f of files) {
      let records;
      try { records = readAllRecords(f, stream, totals); } catch { unreadable++; continue; }
      for (const r of records) {
        if (!r.starting || !r.app.toLowerCase().includes(term)) continue;
        const day = localDay(r.ts);
        const m = matches.get(day) ?? { valid: 0, deleted: 0, first: r.ts, last: r.ts, apps: new Set() };
        r.deleted ? m.deleted++ : m.valid++;
        m.first = Math.min(m.first, r.ts);
        m.last = Math.max(m.last, r.ts);
        m.apps.add(r.app);
        matches.set(day, m);
      }
    }
    const deletedNote = totals.deleted
      ? totals.deleted + " records marked deleted, " + (totals.deleted - totals.deletedEmpty) + " still readable"
      : "no records marked deleted";
    console.log("   " + stream.name + ": " + files.length + " files, " + deletedNote + (unreadable ? ", " + unreadable + " files unreadable" : ""));
    if (!matches.size) { console.log("     nothing matching \"" + term + "\""); continue; }
    for (const [day, m] of [...matches].sort()) {
      const opens = (n) => n + (n === 1 ? " open" : " opens");
      const kinds = [m.valid ? opens(m.valid) : "", m.deleted ? opens(m.deleted) + " marked deleted" : ""].filter(Boolean).join(", ");
      console.log("     " + day + "  " + kinds + ", " + clock(m.first) + " to " + clock(m.last) + "  (" + [...m.apps].join(", ") + ")");
    }
  }
  console.log("");
}

// ---------- 3b. Apple's live knowledgeC.db ----------

function checkKnowledge() {
  console.log("4. Apple's knowledgeC.db (live)");
  if (!fs.existsSync(KNOWLEDGE_DB)) return console.log("   not here\n");
  let tempDir;
  try {
    // Read a copy, so Apple's file is never opened directly
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "find_app_"));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(KNOWLEDGE_DB + suffix)) fs.copyFileSync(KNOWLEDGE_DB + suffix, path.join(tempDir, "k.db" + suffix));
    }
    const db = new DatabaseSync(path.join(tempDir, "k.db"), { readOnly: true });
    const rows = db.prepare(
      `SELECT ZVALUESTRING AS app, ZSTARTDATE AS start, ZENDDATE AS end FROM ZOBJECT
       WHERE ZSTREAMNAME = '/app/usage' AND lower(ZVALUESTRING) LIKE ? ORDER BY ZSTARTDATE`
    ).all("%" + term + "%");
    db.close();
    if (!rows.length) console.log("   nothing matching \"" + term + "\"");
    const days = new Map();
    for (const r of rows) {
      const day = localDay(r.start + APPLE_EPOCH_OFFSET);
      days.set(day, (days.get(day) ?? 0) + (r.end - r.start));
    }
    for (const [day, secs] of days) console.log("     " + day + "  " + mins(secs));
  } catch (err) {
    console.log("   " + (isPermissionError(err) ? "can't read it (give Terminal Full Disk Access to check this one)" : err.message));
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); // only the temporary copy
  }
  console.log("");
}

console.log("Looking for \"" + term + "\". Nothing will be changed.\n");
checkArchive();
checkBiome("2. The archiver's saved copies of Apple's files", BIOME_RAW_DIR);
checkBiome("3. Apple's live Biome files", BIOME_LIVE_DIR);
checkKnowledge();
