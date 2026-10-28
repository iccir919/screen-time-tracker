// find_screen_time_store.mjs
//
// Read-only discovery script. Finds the database that the Screen Time
// screen in System Settings reads from (RMAdminStore), and reports what's
// in it: tables, devices, date ranges, and daily totals per device.
//
// Databases are copied to a temp folder before being opened, so Apple's
// files are never touched.
//
// Run:
//   node --no-warnings tools/find_screen_time_store.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const APPLE_EPOCH_OFFSET = 978307200;
const DAYS_TO_SHOW = 10;

function header(title) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

function appleTimeToLocal(value) {
  if (value === null || value === undefined) return "n/a";
  const d = new Date((value + APPLE_EPOCH_OFFSET) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Places the Screen Time store has lived across macOS versions
function candidateDirs() {
  const dirs = [];
  try {
    const userDir = execSync("getconf DARWIN_USER_DIR", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    dirs.push(path.join(userDir, "com.apple.ScreenTimeAgent", "Store"));
  } catch {
    // getconf not available; fall through to the other locations
  }
  dirs.push(path.join(os.homedir(), "Library/Application Support/com.apple.remotemanagementd"));
  dirs.push(path.join(os.homedir(), "Library/Application Support/com.apple.ScreenTimeAgent/Store"));
  return dirs;
}

function findStores() {
  const found = [];
  for (const dir of candidateDirs()) {
    console.log(`Checking ${dir}`);
    try {
      if (!fs.existsSync(dir)) { console.log("  not found"); continue; }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite"));
      if (!files.length) console.log("  folder exists, no .sqlite files");
      for (const f of files) {
        const full = path.join(dir, f);
        console.log(`  found ${f} (${Math.round(fs.statSync(full).size / 1024)} KB)`);
        found.push(full);
      }
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        console.log("  permission denied (check Full Disk Access for Terminal)");
      } else {
        console.log(`  error: ${err.message}`);
      }
    }
  }
  return found;
}

function copyDbToTemp(dbPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "screen_time_store_"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tempDir, path.basename(src)));
  }
  return { dbCopy: path.join(tempDir, path.basename(dbPath)), tempDir };
}

function describeTables(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log("\nTables (rows):");
  for (const t of tables) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    if (count === 0) continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    console.log(`  ${t} (${count}): ${cols.join(", ")}`);
  }
  return tables;
}

// The usual layout: ZUSAGETIMEDITEM (per app per hour) -> ZUSAGECATEGORY
// -> ZUSAGEBLOCK (the hour) -> ZUSAGE -> ZCOREDEVICE (which device)
function summarizeUsage(db, tables) {
  const needed = ["ZUSAGETIMEDITEM", "ZUSAGECATEGORY", "ZUSAGEBLOCK", "ZUSAGE", "ZCOREDEVICE"];
  const missing = needed.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.log(`\nUsage tables not in the expected layout (missing ${missing.join(", ")}).`);
    return;
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(d.ZNAME, d.ZIDENTIFIER, 'unknown') AS device,
              d.ZPLATFORM AS platform,
              b.ZSTARTDATE AS start,
              t.ZBUNDLEIDENTIFIER AS app,
              t.ZDOMAIN AS domain,
              t.ZTOTALTIMEINSECONDS AS secs
       FROM ZUSAGETIMEDITEM t
       JOIN ZUSAGECATEGORY c ON t.ZCATEGORY = c.Z_PK
       JOIN ZUSAGEBLOCK b ON c.ZBLOCK = b.Z_PK
       JOIN ZUSAGE u ON b.ZUSAGE = u.Z_PK
       LEFT JOIN ZCOREDEVICE d ON u.ZDEVICE = d.Z_PK`
    )
    .all();

  if (!rows.length) {
    console.log("\nNo usage rows found.");
    return;
  }

  header("Usage by device");
  const byDevice = new Map();
  for (const r of rows) {
    if (!byDevice.has(r.device)) byDevice.set(r.device, { platform: r.platform, rows: [] });
    byDevice.get(r.device).rows.push(r);
  }

  for (const [device, { platform, rows: devRows }] of byDevice) {
    const starts = devRows.map((r) => r.start).filter((v) => v !== null);
    const appRows = devRows.filter((r) => r.app);
    const webRows = devRows.filter((r) => r.domain);
    console.log(
      `\n${device} (platform ${platform ?? "?"}): ${devRows.length} rows ` +
        `(${appRows.length} apps, ${webRows.length} websites), ` +
        `${appleTimeToLocal(Math.min(...starts))} to ${appleTimeToLocal(Math.max(...starts))}`
    );

    // Daily app totals for the most recent days
    const byDay = new Map();
    for (const r of appRows) {
      const day = appleTimeToLocal(r.start).slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (r.secs ?? 0));
    }
    const days = [...byDay.keys()].sort().slice(-DAYS_TO_SHOW);
    for (const day of days) {
      console.log(`  ${day}  ${formatDuration(byDay.get(day)).padStart(8)}`);
    }
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.log("This script only runs on macOS.");
    return;
  }

  header("Looking for the Screen Time store");
  const stores = findStores();
  if (!stores.length) {
    console.log("\nNo Screen Time store found. Paste this output back into the chat.");
    return;
  }

  for (const store of stores) {
    header(path.basename(store));
    let tempDir;
    try {
      const copy = copyDbToTemp(store);
      tempDir = copy.tempDir;
      const db = new DatabaseSync(copy.dbCopy, { readOnly: true });
      const tables = describeTables(db);
      summarizeUsage(db, tables);
      db.close();
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        console.log("Permission denied. Check Full Disk Access for Terminal.");
      } else {
        console.log(`Could not read: ${err.message}`);
      }
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  header("Done");
  console.log("Paste this output back into the chat.");
}

main();