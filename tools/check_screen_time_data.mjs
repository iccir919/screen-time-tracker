// check_screen_time_data.mjs
//
// Read-only discovery script. Looks for Screen Time data on this Mac and
// reports what it finds. It never modifies Apple's files: databases are
// copied to a temp folder before being opened.
//
// Requirements:
//   - macOS
//   - Node.js 22.13 or newer (Node 24 LTS recommended), which includes
//     the built-in node:sqlite module. No npm install needed.
//   - Terminal needs Full Disk Access:
//     System Settings > Privacy & Security > Full Disk Access
//
// Run:
//   node tools/check_screen_time_data.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const HOME = os.homedir();
const KNOWLEDGE_DB = path.join(
  HOME,
  "Library/Application Support/Knowledge/knowledgeC.db"
);
const BIOME_DIRS = [
  path.join(HOME, "Library/Biome/streams/restricted/App.InFocus"),
  path.join(HOME, "Library/Biome/streams/public/App.InFocus"),
  path.join(HOME, "Library/Biome/streams/restricted/ScreenTime.AppUsage"),
];

// Apple stores many timestamps as seconds since 2001-01-01 UTC
const APPLE_EPOCH_OFFSET = 978307200;

function appleTimeToStr(value) {
  if (value === null || value === undefined) return "n/a";
  const date = new Date((value + APPLE_EPOCH_OFFSET) * 1000);
  return formatDate(date, true);
}

function formatDate(date, withTime = false) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

function header(title) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

function isPermissionError(err) {
  return err && (err.code === "EPERM" || err.code === "EACCES");
}

function copyDbToTemp(dbPath) {
  // Copy the db and its WAL/SHM files so we read a consistent snapshot
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "screen_time_check_"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tempDir, path.basename(src)));
    }
  }
  return { dbCopy: path.join(tempDir, path.basename(dbPath)), tempDir };
}

function checkKnowledgeDb() {
  header("1. knowledgeC.db (older storage)");
  console.log(`Path: ${KNOWLEDGE_DB}`);

  if (!fs.existsSync(KNOWLEDGE_DB)) {
    console.log("Not found.");
    return;
  }

  let dbCopy, tempDir;
  try {
    ({ dbCopy, tempDir } = copyDbToTemp(KNOWLEDGE_DB));
  } catch (err) {
    if (isPermissionError(err)) {
      console.log("Permission denied. Give Terminal Full Disk Access and rerun.");
      return;
    }
    throw err;
  }

  try {
    const db = new DatabaseSync(dbCopy);

    console.log("\nStreams in this database (top 15 by row count):");
    const streams = db
      .prepare(
        `SELECT ZSTREAMNAME AS name, COUNT(*) AS count,
                MIN(ZSTARTDATE) AS first, MAX(ZSTARTDATE) AS last
         FROM ZOBJECT
         GROUP BY ZSTREAMNAME
         ORDER BY COUNT(*) DESC
         LIMIT 15`
      )
      .all();
    for (const s of streams) {
      console.log(
        `  ${String(s.name).padEnd(35)} ${String(s.count).padStart(7)} rows  ` +
          `${appleTimeToStr(s.first)} to ${appleTimeToStr(s.last)}`
      );
    }

    console.log("\nApp usage by device (/app/usage):");
    const byDevice = db
      .prepare(
        `SELECT COALESCE(ZSOURCE.ZDEVICEID, 'this Mac') AS device,
                COUNT(*) AS count,
                MIN(ZOBJECT.ZSTARTDATE) AS first,
                MAX(ZOBJECT.ZSTARTDATE) AS last
         FROM ZOBJECT
         LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
         WHERE ZOBJECT.ZSTREAMNAME = '/app/usage'
         GROUP BY device`
      )
      .all();
    if (byDevice.length === 0) console.log("  No /app/usage rows found.");
    for (const d of byDevice) {
      console.log(
        `  ${d.device}: ${d.count} rows, ` +
          `${appleTimeToStr(d.first)} to ${appleTimeToStr(d.last)}`
      );
    }

    console.log("\nSynced devices (ZSYNCPEER):");
    try {
      const peers = db.prepare("SELECT ZDEVICEID, ZMODEL FROM ZSYNCPEER").all();
      if (peers.length === 0) console.log("  None listed.");
      for (const p of peers) {
        console.log(`  ${p.ZDEVICEID}  model: ${p.ZMODEL}`);
      }
    } catch {
      console.log("  ZSYNCPEER table not present.");
    }

    console.log("\nSample of 5 most recent app usage rows:");
    const recent = db
      .prepare(
        `SELECT ZOBJECT.ZVALUESTRING AS app,
                ZOBJECT.ZSTARTDATE AS start,
                ZOBJECT.ZENDDATE AS end,
                COALESCE(ZSOURCE.ZDEVICEID, 'this Mac') AS device
         FROM ZOBJECT
         LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
         WHERE ZOBJECT.ZSTREAMNAME = '/app/usage'
         ORDER BY ZOBJECT.ZSTARTDATE DESC
         LIMIT 5`
      )
      .all();
    for (const r of recent) {
      const minutes =
        r.start && r.end ? ((r.end - r.start) / 60).toFixed(1) : "?";
      console.log(
        `  ${appleTimeToStr(r.start)}  ${String(minutes).padStart(6)} min  ` +
          `${r.app}  [${r.device}]`
      );
    }

    db.close();
  } catch (err) {
    console.log(`Could not read database: ${err.message}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function listFilesRecursive(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function checkBiome() {
  header("2. Biome streams (newer storage)");

  for (const streamDir of BIOME_DIRS) {
    console.log(`\nPath: ${streamDir}`);

    let files;
    try {
      if (!fs.existsSync(streamDir)) {
        console.log("  Not found.");
        continue;
      }
      files = listFilesRecursive(streamDir);
    } catch (err) {
      if (isPermissionError(err)) {
        console.log("  Permission denied. Give Terminal Full Disk Access and rerun.");
        continue;
      }
      throw err;
    }

    if (files.length === 0) {
      console.log("  Folder exists but has no files.");
      continue;
    }

    // Group by subfolder (local vs remote/<device-id>)
    const groups = {};
    for (const f of files) {
      const relDir = path.dirname(path.relative(streamDir, f));
      const key = relDir === "." ? "(root)" : relDir;
      (groups[key] ||= []).push(f);
    }

    for (const key of Object.keys(groups).sort()) {
      const stats = groups[key].map((f) => fs.statSync(f));
      const totalKb = stats.reduce((sum, s) => sum + s.size, 0) / 1024;
      const mtimes = stats.map((s) => s.mtimeMs);
      const oldest = formatDate(new Date(Math.min(...mtimes)));
      const newest = formatDate(new Date(Math.max(...mtimes)));
      console.log(
        `  ${key}: ${groups[key].length} files, ${totalKb.toFixed(0)} KB, ` +
          `modified ${oldest} to ${newest}`
      );
    }
  }
}

function getMacVersion() {
  try {
    return execSync("sw_vers -productVersion").toString().trim();
  } catch {
    return "unknown";
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.log("This script only runs on macOS.");
    return;
  }

  header("System");
  console.log(`macOS version: ${getMacVersion()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Run at: ${formatDate(new Date(), true)}`);

  checkKnowledgeDb();
  checkBiome();

  header("Done");
  console.log("Paste this output back into the chat. App names and device IDs");
  console.log("are fine to share, but trim anything you'd rather keep private.");
}

main();