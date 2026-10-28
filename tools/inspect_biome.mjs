// inspect_biome.mjs
//
// Looks inside the archived Biome App.InFocus files and lists, per device
// folder, which app IDs appear most often. Reads your archive copy in
// ~/screen_time_archive/biome_raw, so it doesn't need Full Disk Access.
//
// Run:
//   node tools/inspect_biome.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIOME_BACKUP_DIR = path.join(
  os.homedir(),
  "screen_time_archive",
  "biome_raw",
  "App.InFocus"
);
const TOP_APPS = 10;

// App IDs look like com.company.app (at least three dot-separated parts)
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/;

function listFilesRecursive(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

// Pull out runs of readable text from a binary file
function extractStrings(buffer, minLength = 8) {
  const found = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) found.push(current);
      current = "";
    }
  }
  if (current.length >= minLength) found.push(current);
  return found;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function main() {
  if (!fs.existsSync(BIOME_BACKUP_DIR)) {
    console.log(`No Biome backup at ${BIOME_BACKUP_DIR}. Run archive_screen_time.mjs first.`);
    return;
  }

  // Group files by device folder: "local" or "remote/<id>" (tombstones included)
  const groups = new Map();
  for (const file of listFilesRecursive(BIOME_BACKUP_DIR)) {
    const parts = path.relative(BIOME_BACKUP_DIR, file).split(path.sep);
    let key;
    if (parts[0] === "local") key = "local (this Mac)";
    else if (parts[0] === "remote") key = `remote/${parts[1]}`;
    else continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  for (const [key, files] of [...groups].sort()) {
    const counts = new Map();
    const mtimes = [];
    let magic = null;

    for (const file of files) {
      const buffer = fs.readFileSync(file);
      mtimes.push(fs.statSync(file).mtimeMs);
      if (!magic && buffer.length >= 4) {
        magic = buffer.subarray(0, 4).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
      }
      for (const s of extractStrings(buffer)) {
        // Strings can have a stray leading byte; try trimming one character too
        const candidate = BUNDLE_ID.test(s) ? s : BUNDLE_ID.test(s.slice(1)) ? s.slice(1) : null;
        if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(key);
    console.log("=".repeat(60));
    console.log(
      `${files.length} files, modified ${formatDate(Math.min(...mtimes))} to ` +
        `${formatDate(Math.max(...mtimes))}, first bytes: "${magic}"`
    );

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_APPS);
    if (top.length === 0) {
      console.log("  No app IDs found.");
    }
    for (const [app, count] of top) {
      console.log(`  ${String(count).padStart(6)}  ${app}`);
    }
  }
  console.log();
}

main();