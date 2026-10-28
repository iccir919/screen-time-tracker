// tools/inspect_games_db.mjs
//
// Read-only. Shows what's in macOS's Games.RecentlyPlayed database: every
// table, its columns, row count, and the most recent rows, with anything
// that looks like a timestamp converted to local time. The database is
// copied to a temp folder first, so Apple's file is never touched.
//
// Run:
//   node --no-warnings tools/inspect_games_db.mjs
//   node --no-warnings tools/inspect_games_db.mjs 20     (show 20 rows per table)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME, APPLE_EPOCH_OFFSET } from "../screen_time_lib.mjs";

const GAMES_DB = path.join(HOME, "Library/Biome/databases/Games.RecentlyPlayed/Games.RecentlyPlayed.sqlite3");
const ROWS_PER_TABLE = Number(process.argv[2]) || 8;

function localTime(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

// Show numbers that look like dates as readable times
function describe(value) {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "string") return value.length > 80 ? JSON.stringify(value.slice(0, 80)) + "..." : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") {
    const n = Number(value);
    if (n > 6e8 && n < 9.5e8) return `${n}  (${localTime(n + APPLE_EPOCH_OFFSET)}, Apple time)`;
    if (n > 1.6e9 && n < 2e9) return `${n}  (${localTime(n)}, Unix time)`;
    if (n > 1.6e12 && n < 2e12) return `${n}  (${localTime(n / 1000)}, Unix ms)`;
    return String(n);
  }
  return String(value);
}

function main() {
  console.log(`Path: ${GAMES_DB}`);
  if (!fs.existsSync(GAMES_DB)) {
    console.log("Not found.");
    return;
  }

  // Copy each file on its own (reading and writing the bytes rather than
  // using the system copy), so one blocked file doesn't stop the rest and
  // we can see exactly which one is the problem
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "games_db_"));
  const dbCopy = path.join(tempDir, path.basename(GAMES_DB));
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = GAMES_DB + suffix;
    if (!fs.existsSync(src)) continue;
    try {
      fs.writeFileSync(path.join(tempDir, path.basename(src)), fs.readFileSync(src));
      console.log(`  copied ${path.basename(src)}`);
    } catch (err) {
      console.log(`  could not copy ${path.basename(src)}: ${err.code ?? err.message}`);
    }
  }
  if (!fs.existsSync(dbCopy)) {
    console.log("The main database file couldn't be copied, so there's nothing to open.");
    fs.rmSync(tempDir, { recursive: true, force: true });
    return;
  }

  try {
    const db = new DatabaseSync(dbCopy, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);

    for (const t of tables) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => `${c.name} ${c.type}`.trim());
      console.log("\n" + "=".repeat(60));
      console.log(`${t}  (${count} rows)`);
      console.log("=".repeat(60));
      console.log(`Columns: ${cols.join(", ")}`);
      if (!count) continue;

      // Most recent rows (by rowid when the table has one)
      let rows;
      try {
        rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT ${ROWS_PER_TABLE}`).all();
      } catch {
        rows = db.prepare(`SELECT * FROM "${t}" LIMIT ${ROWS_PER_TABLE}`).all();
      }
      rows.forEach((row, i) => {
        console.log(`\n  row ${i + 1}:`);
        for (const [k, v] of Object.entries(row)) console.log(`    ${k}: ${describe(v)}`);
      });
    }
    db.close();
  } catch (err) {
    console.log(`Could not read: ${err.message}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
