// archive_screen_time.mjs
//
// Saves Screen Time data into your own archive so it survives Apple's
// pruning. Safe to run as often as you like, and Apple's files are never
// modified.
//
// What it does:
//   1. Reads app usage and screen-on periods from knowledgeC.db
//   2. Copies the raw Biome stream files into ~/screen_time_archive/biome_raw/
//      (files Apple later deletes stay in your copy):
//        App.InFocus          Mac and synced iPhone, every macOS version
//        ScreenTime.AppUsage  Mac only, macOS 27 and later. Matches Apple's
//                             Screen Time per-app numbers most closely.
//   3. Decodes every saved Biome file into app sessions. Decoded sessions are
//      rebuilt from the saved files on each run, so a change to the decoding
//      rules applies to your whole history (and can be undone the same way).
//
// The report, lookup and dashboard (server.mjs) pick the best source for
// each device and day (see loadRows in screen_time_lib.mjs).
//
// Requirements: macOS, Node 22.13+, Full Disk Access for Terminal.
//
// Run:
//   node --no-warnings archive_screen_time.mjs

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HOME, ARCHIVE_DIR, ARCHIVE_DB, BIOME_RAW_DIR, APPLE_EPOCH_OFFSET, SOURCE_NAMES,
  copyDbToTemp, isPermissionError, loadRows, sortDevices, localDay, ensureAppSettings,
} from "./screen_time_lib.mjs";

const KNOWLEDGE_DB = path.join(HOME, "Library/Application Support/Knowledge/knowledgeC.db");
const BIOME_STREAMS = path.join(HOME, "Library/Biome/streams/restricted");

// The Biome streams we save and decode, and where each keeps its fields
const STREAMS = [
  {
    name: "App.InFocus",
    source: "biome",
    stateField: 3,      // 1 = came on screen, 0 = left
    timeField: 4,       // seconds since 2001 (Apple time)
    appField: 6,
    toUnix: (t) => t + APPLE_EPOCH_OFFSET,
  },
  {
    name: "ScreenTime.AppUsage",
    source: "appusage",
    stateField: 1,      // 1 = came on screen, 0 = left (may be left out when 0)
    stateDefault: 0,
    timeField: 2,       // Unix seconds
    appField: 3,
    toUnix: (t) => t,
  },
];

// A session with no "left screen" event is cut off after this long
const MAX_SESSION_SECS = 4 * 60 * 60;

// Not screen time: the lock screen, screen saver and home screen
const IGNORED_APPS = new Set([
  "com.apple.loginwindow",
  "com.apple.ScreenSaver.Engine",
  "com.apple.springboard",
  "com.apple.SpringBoard",
]);

// Panels pulled down over another app. Their time is credited to the app
// underneath, with the same start and end (never extended), because Apple's
// Screen Time counts it that way and the phone often doesn't log the app
// coming back when the panel closes.
const OVERLAY_APPS = new Set([
  "com.apple.control-center",
]);


function appleTimeToIso(value) {
  if (value === null || value === undefined) return null;
  return new Date((value + APPLE_EPOCH_OFFSET) * 1000).toISOString();
}

// This Mac's UTC offset at a given moment, in seconds (handles daylight saving)
function localOffsetSecs(ms) {
  return -new Date(ms).getTimezoneOffset() * 60;
}

function openArchive() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archive = new DatabaseSync(ARCHIVE_DB);
  archive.exec("PRAGMA busy_timeout = 5000");
  ensureAppSettings(archive);
  archive.exec(`
    CREATE TABLE IF NOT EXISTS app_usage (
      uuid            TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      device_model    TEXT,
      app             TEXT,
      start_utc       TEXT,
      end_utc         TEXT,
      seconds         REAL,
      gmt_offset_secs INTEGER,
      source          TEXT NOT NULL,
      archived_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_usage_start ON app_usage (start_utc);
    CREATE INDEX IF NOT EXISTS idx_app_usage_device ON app_usage (device_id);

    -- When this Mac's screen was on, used to spot time with no app recorded
    CREATE TABLE IF NOT EXISTS screen_on (
      uuid            TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      start_utc       TEXT NOT NULL,
      end_utc         TEXT NOT NULL,
      gmt_offset_secs INTEGER,
      archived_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_screen_on_start ON screen_on (start_utc);

    -- When the archiver last ran (shown on the dashboard)
    CREATE TABLE IF NOT EXISTS archive_info (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Older versions picked the best source with these views; that logic
    -- now lives in screen_time_lib.mjs
    DROP VIEW IF EXISTS app_usage_best;
    DROP VIEW IF EXISTS app_usage_labeled;
  `);
  return archive;
}

// ---------------------------------------------------------------------------
// 1. knowledgeC
// ---------------------------------------------------------------------------
function archiveKnowledgeDb(archive) {
  console.log("knowledgeC.db");

  let dbCopy, tempDir;
  try {
    ({ dbCopy, tempDir } = copyDbToTemp(KNOWLEDGE_DB));
  } catch (err) {
    if (isPermissionError(err)) {
      console.log("  Permission denied. Give Terminal Full Disk Access and rerun.");
      permissionDenied = true;
      return;
    }
    throw err;
  }

  try {
    const source = new DatabaseSync(dbCopy, { readOnly: true });

    // ZSYNCPEER has duplicate rows per device, some with a null model,
    // so take any non-null model per device id.
    const rows = source
      .prepare(
        `SELECT ZOBJECT.ZUUID AS uuid,
                COALESCE(ZSOURCE.ZDEVICEID, 'this_mac') AS device_id,
                (SELECT MAX(ZMODEL) FROM ZSYNCPEER
                  WHERE ZSYNCPEER.ZDEVICEID = ZSOURCE.ZDEVICEID) AS device_model,
                ZOBJECT.ZVALUESTRING AS app,
                ZOBJECT.ZSTARTDATE AS start,
                ZOBJECT.ZENDDATE AS end,
                ZOBJECT.ZSECONDSFROMGMT AS gmt_offset
         FROM ZOBJECT
         LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
         WHERE ZOBJECT.ZSTREAMNAME = '/app/usage'`
      )
      .all();
    // Screen-on intervals for this Mac (synced devices have no source device id
    // here). Kept separate so a problem here never stops the app usage above.
    let screenRows = [];
    try {
      screenRows = source
        .prepare(
          `SELECT ZOBJECT.ZUUID AS uuid, ZOBJECT.ZSTARTDATE AS start, ZOBJECT.ZENDDATE AS end,
                  ZOBJECT.ZSECONDSFROMGMT AS gmt_offset
           FROM ZOBJECT
           LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
           WHERE ZOBJECT.ZSTREAMNAME = '/display/isBacklit'
             AND ZOBJECT.ZVALUEINTEGER = 1
             AND ZSOURCE.ZDEVICEID IS NULL
             AND ZOBJECT.ZSTARTDATE IS NOT NULL AND ZOBJECT.ZENDDATE > ZOBJECT.ZSTARTDATE`
        )
        .all();
    } catch (err) {
      console.log(`  Could not read screen-on periods: ${err.message}`);
    }
    source.close();

    const insert = archive.prepare(
      `INSERT OR IGNORE INTO app_usage
         (uuid, device_id, device_model, app, start_utc, end_utc,
          seconds, gmt_offset_secs, source, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'knowledgeC', ?)`
    );

    const now = new Date().toISOString();
    let added = 0;
    archive.exec("BEGIN");
    for (const r of rows) {
      const seconds = r.start !== null && r.end !== null ? r.end - r.start : null;
      const result = insert.run(
        r.uuid, r.device_id, r.device_model ?? null, r.app,
        appleTimeToIso(r.start), appleTimeToIso(r.end),
        seconds, r.gmt_offset ?? null, now
      );
      added += Number(result.changes);
    }
    const insertScreen = archive.prepare(
      `INSERT OR IGNORE INTO screen_on (uuid, device_id, start_utc, end_utc, gmt_offset_secs, archived_at)
       VALUES (?, 'this_mac', ?, ?, ?, ?)`
    );
    let screenAdded = 0;
    for (const r of screenRows) {
      const result = insertScreen.run(r.uuid, appleTimeToIso(r.start), appleTimeToIso(r.end), r.gmt_offset ?? null, now);
      screenAdded += Number(result.changes);
    }
    archive.exec("COMMIT");

    console.log(`  Found ${rows.length} app rows, added ${added} new.`);
    console.log(`  Found ${screenRows.length} screen-on periods, added ${screenAdded} new.`);
  } catch (err) {
    console.log(`  Could not read knowledgeC.db: ${err.message}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Back up Biome files
// ---------------------------------------------------------------------------
function backupStream(stream) {
  const srcRoot = path.join(BIOME_STREAMS, stream.name);
  const destRoot = path.join(BIOME_RAW_DIR, stream.name);
  if (!fs.existsSync(srcRoot)) {
    console.log(`  ${stream.name}: not on this Mac, skipping.`);
    return;
  }

  let copied = 0;
  let unchanged = 0;

  function walk(srcDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destRoot, path.relative(srcRoot, src));

      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (!entry.isFile()) continue;

      // Compare contents, not dates: Biome files are created at a fixed size
      // and written in place, which doesn't always update the modified date.
      const srcBuf = fs.readFileSync(src);
      if (fs.existsSync(dest) && fs.readFileSync(dest).equals(srcBuf)) {
        unchanged++;
        continue;
      }

      const srcStat = fs.statSync(src);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, srcBuf);
      fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
      copied++;
    }
  }

  try {
    walk(srcRoot);
    console.log(`  ${stream.name}: copied ${copied} new or changed files, ${unchanged} already saved.`);
  } catch (err) {
    if (isPermissionError(err)) {
      console.log(`  ${stream.name}: permission denied. Give Terminal Full Disk Access and rerun.`);
      permissionDenied = true;
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. Decode Biome files
// ---------------------------------------------------------------------------

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

// Pull the three fields we need out of one protobuf record, using the
// stream's field numbers. Returns { starting, ts (Unix seconds), app } or null.
function decodeEvent(buf, start, end, stream) {
  let pos = start;
  let starting = null, ts = null, app = null;
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos, end);
    const field = Math.floor(key / 8), wire = key % 8;
    pos = p1;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos, end);
      if (field === stream.stateField) starting = v;
      pos = p2;
    } else if (wire === 1) {
      if (pos + 8 > end) throw new Error("short double");
      if (field === stream.timeField) ts = buf.readDoubleLE(pos);
      pos += 8;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos, end);
      if (p2 + len > end) throw new Error("length past end");
      if (field === stream.appField) app = buf.toString("utf8", p2, p2 + len);
      pos = p2 + len;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  if (starting === null) starting = stream.stateDefault ?? null;
  if (starting === null || ts === null || !app) return null;
  return { starting: starting === 1, ts: stream.toUnix(ts), app };
}

// SEGB v2 file:
//   header (32 bytes): "SEGB", u32 record count, double created, padding
//   records from byte 32: 8-byte prefix (checksum, flags) then protobuf,
//     each padded to a multiple of 4 bytes
//   index at the very end, growing backwards, 16 bytes per record:
//     u32 end offset (relative to byte 32), u32 state (1 = valid), double
function readSegbFile(file, stream, stats) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48 || buf.toString("latin1", 0, 4) !== "SEGB") {
    stats.unreadable++;
    return [];
  }
  const count = buf.readUInt32LE(4);
  const events = [];
  let prevEnd = 0;
  for (let i = 0; i < count; i++) {
    const idx = buf.length - 16 * (i + 1);
    if (idx < 32) break;
    const endRel = buf.readUInt32LE(idx);
    const state = buf.readUInt32LE(idx + 4);
    const recStart = 32 + Math.ceil(prevEnd / 4) * 4;
    const recEnd = 32 + endRel;
    prevEnd = endRel;
    if (recEnd > idx || recStart + 8 > recEnd) { stats.badRecords++; break; }
    if (state !== 1) { stats.deleted++; continue; }
    try {
      const ev = decodeEvent(buf, recStart + 8, recEnd, stream);
      if (ev) events.push(ev);
    } catch {
      stats.badRecords++;
    }
  }
  return events;
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Turn on-screen / left-screen events into sessions. Only one app is on
// screen at a time, so a new app coming on screen ends the previous one.
function eventsToSessions(events) {
  // Dedupe (the same event can sit in a live file and its tombstone copy)
  const seen = new Set();
  const unique = [];
  for (const e of events) {
    const k = `${e.ts}|${e.app}|${e.starting}`;
    if (!seen.has(k)) { seen.add(k); unique.push(e); }
  }
  // Sort by time; at the same instant, process "left screen" first
  unique.sort((a, b) => a.ts - b.ts || (a.starting === b.starting ? 0 : a.starting ? 1 : -1));

  const sessions = [];
  let open = null;
  let lastEnded = null; // the app that most recently left the screen, and when
  const close = (endTs) => {
    if (!open) return;
    const end = Math.min(endTs, open.ts + MAX_SESSION_SECS);
    if (end > open.ts && !IGNORED_APPS.has(open.app)) {
      sessions.push({ app: open.under ?? open.app, start: open.ts, end });
    }
    lastEnded = { app: open.under ?? open.app, at: endTs };
    open = null;
  };
  for (const e of unique) {
    if (e.starting) {
      if (open && open.app === e.app) continue; // repeated "on screen", keep the earlier start
      // An overlay takes the name of the app it was pulled over: the one on
      // screen, or the one logged as leaving at the same moment
      let under = null;
      if (OVERLAY_APPS.has(e.app)) {
        if (open && !IGNORED_APPS.has(open.app)) under = open.under ?? open.app;
        else if (!open && lastEnded && e.ts - lastEnded.at <= 2 && !IGNORED_APPS.has(lastEnded.app)) under = lastEnded.app;
      }
      close(e.ts);
      open = { app: e.app, ts: e.ts, under };
    } else if (open && open.app === e.app) {
      close(e.ts);
    }
  }
  // A session still open at the end may be in progress; leave it for next run
  return sessions;
}

// Which device a Biome folder belongs to
function folderDevice(folderKey, apps) {
  if (folderKey === "local") return { id: "this_mac", model: "Mac" };
  const looksLikeIphone = [...apps].some((a) =>
    a.includes(".ios") || a === "com.apple.MobileSMS" || a === "com.apple.mobilephone" || a === "com.apple.camera");
  return { id: "biome:" + folderKey.replace(/^remote\//, ""), model: looksLikeIphone ? "iPhone" : null };
}

function decodeStream(archive, stream) {
  const backupRoot = path.join(BIOME_RAW_DIR, stream.name);
  if (!fs.existsSync(backupRoot)) return;

  // Group files by device folder: "local" or "remote/<id>" (tombstones included)
  const groups = new Map();
  for (const file of listFiles(backupRoot)) {
    const parts = path.relative(backupRoot, file).split(path.sep);
    let key;
    if (parts[0] === "local") key = "local";
    else if (parts[0] === "remote" && parts.length > 2) key = "remote/" + parts[1];
    else continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  const insert = archive.prepare(
    `INSERT OR REPLACE INTO app_usage
       (uuid, device_id, device_model, app, start_utc, end_utc,
        seconds, gmt_offset_secs, source, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const countRows = archive.prepare("SELECT COUNT(*) AS n FROM app_usage WHERE source = ? AND device_id = ?");
  const removeRows = archive.prepare("DELETE FROM app_usage WHERE source = ? AND device_id = ?");
  const now = new Date().toISOString();

  for (const [key, files] of [...groups].sort()) {
    const stats = { unreadable: 0, badRecords: 0, deleted: 0 };
    const events = [];
    for (const f of files) events.push(...readSegbFile(f, stream, stats));
    const sessions = eventsToSessions(events);
    const device = folderDevice(key, new Set(events.map((e) => e.app)));
    const label = `${stream.name} ${device.model ? `${device.model} (${key})` : key}`;
    const before = countRows.get(stream.source, device.id).n;

    // Rebuild this device's sessions from the saved files. If nothing could
    // be decoded, keep what's already archived rather than wiping it.
    if (!sessions.length) {
      console.log(`  ${label}: ${files.length} files, no sessions decoded` + (before ? `, kept ${before} archived` : ""));
    } else {
      archive.exec("BEGIN");
      removeRows.run(stream.source, device.id);
      for (const s of sessions) {
        const startMs = s.start * 1000;
        insert.run(
          `${stream.source}:${device.id}:${s.app}:${Math.round(startMs)}`,
          device.id, device.model, s.app,
          new Date(startMs).toISOString(), new Date(s.end * 1000).toISOString(), s.end - s.start,
          localOffsetSecs(startMs), stream.source, now
        );
      }
      archive.exec("COMMIT");
      const change = sessions.length - before;
      console.log(`  ${label}: ${files.length} files, ${events.length} events, ${sessions.length} sessions` +
        ` (${change >= 0 ? "+" : ""}${change})`);
    }

    const problems = [];
    if (stats.unreadable) problems.push(`${stats.unreadable} files not in a known format`);
    if (stats.deleted) problems.push(`${stats.deleted} records marked deleted`);
    if (stats.badRecords) problems.push(`${stats.badRecords} records unreadable`);
    if (problems.length) console.log(`    (${problems.join(", ")})`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function printSummary(archive) {
  console.log("\nArchive by device (best source per day):");
  const byDevice = new Map();
  for (const r of loadRows(archive)) {
    if (!byDevice.has(r.device)) byDevice.set(r.device, { sessions: 0, sources: new Map(), days: new Set(), first: Infinity, last: -Infinity });
    const d = byDevice.get(r.device);
    d.sessions++;
    d.sources.set(r.source, (d.sources.get(r.source) ?? 0) + 1);
    d.days.add(r.day);
    d.first = Math.min(d.first, r.start + r.offset);
    d.last = Math.max(d.last, r.start + r.offset);
  }
  for (const device of sortDevices(byDevice.keys())) {
    const d = byDevice.get(device);
    console.log(
      `  ${device}: ${d.sessions} sessions on ${d.days.size} days, ` +
        `${localDay(d.first)} to ${localDay(d.last)} ` +
        `(${[...d.sources].map(([src, n]) => `${n} from ${SOURCE_NAMES[src] ?? src}`).join(", ")})`
    );
  }
  console.log(`\nArchive: ${ARCHIVE_DB}`);
}

// Set when Apple's files can't be read, so the run ends with exit code 2.
// The dashboard's Refresh button uses that to explain the problem.
let permissionDenied = false;

function main() {
  if (process.platform !== "darwin") {
    console.log("This script only runs on macOS.");
    return;
  }

  // A timestamp at the top makes the scheduled run's log easy to read
  console.log(`=== Archive run ${new Date().toLocaleString()} ===`);

  const archive = openArchive();
  archiveKnowledgeDb(archive);
  console.log("Biome backup");
  for (const stream of STREAMS) backupStream(stream);
  console.log("Biome decode");
  for (const stream of STREAMS) decodeStream(archive, stream);
  printSummary(archive);
  archive.prepare("INSERT OR REPLACE INTO archive_info (key, value) VALUES ('last_run', ?)").run(new Date().toISOString());
  archive.close();
  if (permissionDenied) process.exitCode = 2;
}

main();
