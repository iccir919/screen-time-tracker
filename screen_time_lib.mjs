// screen_time_lib.mjs
//
// Shared pieces used by the archiver, report, lookup and dashboard server, so
// they always agree on paths, device names, which source to trust, and how
// overlapping time is counted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COLOR_NAMES, OTHER_ID, OTHER_NAME, DEFAULT_CATEGORIES, DEFAULT_APPS } from "./default_apps.mjs";

export { COLOR_NAMES, OTHER_ID, OTHER_NAME };

export const HOME = os.homedir();
export const ARCHIVE_DIR = path.join(HOME, "screen_time_archive");
export const ARCHIVE_DB = path.join(ARCHIVE_DIR, "screen_time.db");
export const BIOME_RAW_DIR = path.join(ARCHIVE_DIR, "biome_raw");
export const BIOME_BACKUP_DIR = path.join(BIOME_RAW_DIR, "App.InFocus");

// Sources in order of trust: ScreenTime.AppUsage matches Apple's per-app
// numbers most closely (Mac, macOS 27+), then App.InFocus (Biome), then
// knowledgeC
export const SOURCE_RANK = { appusage: 0, biome: 1, knowledgeC: 2 };
export const SOURCE_NAMES = { appusage: "AppUsage", biome: "Biome", knowledgeC: "knowledgeC" };

// Apple stores timestamps as seconds since 2001-01-01 UTC
export const APPLE_EPOCH_OFFSET = 978307200;
export const DAY_SECS = 24 * 60 * 60;

// ---------- formatting ----------

export function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (!h && !m && seconds > 0) return "<1m";
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// "Local seconds" are UTC seconds shifted by the UTC offset, so reading
// them as UTC gives your local date and time.
export function localDay(localSecs) {
  return new Date(localSecs * 1000).toISOString().slice(0, 10);
}

export function todayLocalDay() {
  const now = Date.now() / 1000;
  return localDay(now - new Date().getTimezoneOffset() * 60);
}

export function weekday(day) {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

// The last `count` calendar days ending today, oldest first
export function lastDays(count) {
  const end = Date.parse(todayLocalDay() + "T00:00:00Z") / 1000;
  const days = [];
  for (let i = count - 1; i >= 0; i--) days.push(localDay(end - i * DAY_SECS));
  return days;
}

// ---------- devices ----------

// One name per device no matter which source the row came from
export function deviceLabel(deviceId, deviceModel) {
  if (deviceId === "this_mac") return "Mac";
  if (deviceModel && deviceModel.startsWith("iPhone")) return "iPhone";
  return deviceModel ?? `Device ${String(deviceId).slice(0, 8)}`;
}

// Fixed order so each device keeps the same position and color
export function sortDevices(labels) {
  const order = ["iPhone", "Mac"];
  return [...labels].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
}

// ---------- files ----------

// Copy a database and its WAL/SHM files to a temp folder, so we read a
// consistent snapshot and never touch the original
export function copyDbToTemp(dbPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "screen_time_"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tempDir, path.basename(src)));
  }
  return { dbCopy: path.join(tempDir, path.basename(dbPath)), tempDir };
}

export function isPermissionError(err) {
  return err && (err.code === "EPERM" || err.code === "EACCES");
}

// Open the archive. Waits briefly instead of failing if another script
// (like the archiver) is writing at the same moment.
export function openArchiveDb({ readOnly = true } = {}) {
  const db = new DatabaseSync(ARCHIVE_DB, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function requireArchive() {
  if (!fs.existsSync(ARCHIVE_DB)) {
    console.log(`No archive found at ${ARCHIVE_DB}. Run archive_screen_time.mjs first.`);
    return false;
  }
  return true;
}

// ---------- loading usage ----------

// Every usage row, keeping only the best source:
//   Sources are ranked (SOURCE_RANK). For each device and day, a source
//   covers the window from its first session to its last. A row is kept only
//   if it falls outside the window of every higher-ranked source for that
//   device and day. So a lower source fills in days the better one doesn't
//   cover, and the start or end of a day where the better one began or
//   stopped recording (for example, around a macOS update).
// Returns rows with UTC seconds: { device, app, start, end, offset, source }
export function loadRows(db) {
  const ownDb = !db;
  if (ownDb) db = new DatabaseSync(ARCHIVE_DB, { readOnly: true });
  const raw = db
    .prepare(
      `SELECT device_id, device_model, app, start_utc, end_utc, gmt_offset_secs, source
       FROM app_usage
       WHERE seconds > 0 AND start_utc IS NOT NULL AND end_utc IS NOT NULL`
    )
    .all();
  if (ownDb) db.close();

  const rows = raw.map((r) => {
    const start = Date.parse(r.start_utc) / 1000;
    const offset = r.gmt_offset_secs ?? 0;
    return {
      device: deviceLabel(r.device_id, r.device_model),
      app: r.app,
      start,
      end: Date.parse(r.end_utc) / 1000,
      offset,
      day: localDay(start + offset),
      source: r.source,
    };
  });

  const rank = (src) => SOURCE_RANK[src] ?? 99;

  // Each source's window per device and day: first session start to last end
  const windows = new Map();
  for (const r of rows) {
    const key = rank(r.source) + "|" + r.device + "|" + r.day;
    const w = windows.get(key);
    if (!w) windows.set(key, { first: r.start, last: r.end });
    else { w.first = Math.min(w.first, r.start); w.last = Math.max(w.last, r.end); }
  }
  const ranks = [...new Set(rows.map((r) => rank(r.source)))].sort((a, b) => a - b);

  return rows.filter((r) => {
    for (const higher of ranks) {
      if (higher >= rank(r.source)) break;
      const w = windows.get(higher + "|" + r.device + "|" + r.day);
      if (w && r.end > w.first && r.start < w.last) return false;
    }
    return true;
  });
}

// Remove overlaps per device (only one thing is on screen at a time) and
// split sessions at local midnight. If a row starts before the previous one
// on the same device ended, only the part after that point counts.
// Returns segments in local seconds: { device, app, start, end, day }
export function mergeOverlaps(rows) {
  const sorted = [...rows].sort((a, b) => a.device.localeCompare(b.device) || a.start - b.start);
  const lastEnd = new Map();
  const segs = [];
  for (const r of sorted) {
    let start = r.start;
    const prevEnd = lastEnd.get(r.device) ?? -Infinity;
    if (start < prevEnd) start = prevEnd;
    if (r.end <= start) continue;
    lastEnd.set(r.device, r.end);

    let s = start + r.offset;
    const e = r.end + r.offset;
    while (s < e) {
      const chunkEnd = Math.min(e, Math.floor(s / DAY_SECS) * DAY_SECS + DAY_SECS);
      segs.push({ device: r.device, app: r.app, start: s, end: chunkEnd, day: localDay(s) });
      s = chunkEnd;
    }
  }
  return segs;
}

// ---------- untracked time ----------

// Untracked gaps shorter than this are just the moment between app switches
export const MIN_UNTRACKED_SECS = 2 * 60;

// When this Mac's screen was on. Returns [] for archives made before
// screen-on intervals were saved.
export function loadScreenOn(db) {
  const ownDb = !db;
  if (ownDb) db = new DatabaseSync(ARCHIVE_DB, { readOnly: true });
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screen_on'").get();
  const rows = hasTable
    ? db.prepare("SELECT start_utc, end_utc, gmt_offset_secs FROM screen_on").all()
    : [];
  if (ownDb) db.close();
  return rows.map((r) => ({
    device: "Mac",
    start: Date.parse(r.start_utc) / 1000,
    end: Date.parse(r.end_utc) / 1000,
    offset: r.gmt_offset_secs ?? 0,
  }));
}

// Time when the screen was on but no app was recorded (for example, a game
// in Game Mode). Takes the segments from mergeOverlaps and the screen-on
// intervals from loadScreenOn. Each gap includes `hint`: the apps opened in
// the few minutes before it, most recent first, as a clue to what it was.
// Returns gaps in local seconds: { device, start, end, day, hint: [{ app, start }] }
export function untrackedGaps(segs, screenOn, minSecs = MIN_UNTRACKED_SECS) {
  const gaps = [];
  for (const device of new Set(screenOn.map((s) => s.device))) {
    const used = segs.filter((s) => s.device === device).sort((a, b) => a.start - b.start);

    // Screen-on intervals in local time, merged and split at midnight
    const on = screenOn
      .filter((s) => s.device === device)
      .map((s) => [s.start + s.offset, s.end + s.offset])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of on) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    const pieces = [];
    for (let [a, b] of merged) {
      while (a < b) {
        const mid = Math.min(b, Math.floor(a / DAY_SECS) * DAY_SECS + DAY_SECS);
        pieces.push([a, mid]);
        a = mid;
      }
    }

    // Subtract the time apps were recorded from each screen-on piece
    let i = 0;
    for (const [a, b] of pieces) {
      while (i < used.length && used[i].end <= a) i++;
      let cursor = a;
      for (let j = i; j < used.length && used[j].start < b; j++) {
        if (used[j].start - cursor >= minSecs) gaps.push({ device, start: cursor, end: used[j].start });
        cursor = Math.max(cursor, used[j].end);
      }
      if (b - cursor >= minSecs) gaps.push({ device, start: cursor, end: b });
    }

    // Hint: apps opened in the 5 minutes before the gap, or else the last one
    for (const g of gaps) {
      if (g.device !== device || g.hint) continue;
      g.day = localDay(g.start);
      const before = used.filter((s) => s.start <= g.start).slice(-20).reverse();
      const recent = before.filter((s) => s.start >= g.start - 300);
      const hint = [];
      for (const s of recent.length ? recent : before.slice(0, 1)) {
        if (!hint.some((h) => h.app === s.app)) hint.push({ app: s.app, start: s.start });
        if (hint.length === 3) break;
      }
      g.hint = hint;
    }
  }
  return gaps.sort((a, b) => a.device.localeCompare(b.device) || a.start - b.start);
}

// ---------- app names and categories ----------
//
// Saved in your archive (never in the repo):
//   categories     your category list: name, color and order
//   app_settings   your name and category for each app you've changed
//
// Categories have a fixed ID, so renaming one keeps its apps. "Other" isn't
// in the table: it's always there, always gray, and can't be changed.

export const MAX_APP_NAME_LENGTH = 80;
export const MAX_CATEGORY_NAME_LENGTH = 40;

// A problem with what was asked for (a name too long, an unknown category),
// as opposed to a bug. The server shows these messages on the page.
export class SettingsError extends Error {}

const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

export function ensureAppSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      app_id     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (tableExists(db, "categories")) return;

  // First run with editable categories: start with the defaults
  db.exec(`
    CREATE TABLE categories (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      INTEGER NOT NULL,
      position   INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO categories (id, name, color, position, updated_at) VALUES (?, ?, ?, ?, ?)");
  DEFAULT_CATEGORIES.forEach((c, i) => insert.run(c.id, c.name, c.color, i, now));

  // Earlier versions saved each app's category by name ("Social"). Switch
  // those to IDs ("social"), so they follow the category if it's renamed.
  const byName = new Map(DEFAULT_CATEGORIES.map((c) => [c.name.toLowerCase(), c.id]));
  const ids = new Set(DEFAULT_CATEGORIES.map((c) => c.id).concat([OTHER_ID]));
  const update = db.prepare("UPDATE app_settings SET category = ? WHERE app_id = ?");
  for (const row of db.prepare("SELECT app_id, category FROM app_settings").all()) {
    if (ids.has(row.category)) continue;
    update.run(byName.get(String(row.category).toLowerCase()) ?? OTHER_ID, row.app_id);
  }
}

// Your categories in order: [{ id, name, color }]. Before the archive has a
// categories table, these are the defaults.
export function loadCategories(db) {
  if (!tableExists(db, "categories")) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return db.prepare("SELECT id, name, color FROM categories ORDER BY position, name").all()
    .map((r) => ({ id: r.id, name: r.name, color: Number(r.color) }));
}

function checkCategoryName(categories, name, exceptId = null) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean || clean.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new SettingsError(`A category name must be 1 to ${MAX_CATEGORY_NAME_LENGTH} characters.`);
  }
  const lower = clean.toLowerCase();
  if (lower === OTHER_NAME.toLowerCase() || categories.some((c) => c.id !== exceptId && c.name.toLowerCase() === lower)) {
    throw new SettingsError(`There's already a category called ${clean}.`);
  }
  return clean;
}

function checkColor(color) {
  if (!Number.isInteger(color) || color < 0 || color >= COLOR_NAMES.length) {
    throw new SettingsError("Unknown color.");
  }
  return color;
}

function findCategory(categories, id) {
  const category = categories.find((c) => c.id === id);
  if (!category) throw new SettingsError(id === OTHER_ID ? "Other can't be changed." : "That category doesn't exist.");
  return category;
}

// Adds a category at the end. Without a color, it gets the first color no
// other category is using (or the first color, if all are in use).
export function createCategory(db, { name, color } = {}) {
  ensureAppSettings(db);
  const categories = loadCategories(db);
  const clean = checkCategoryName(categories, name);
  const used = new Set(categories.map((c) => c.color));
  const pick = color === undefined ? Math.max(0, COLOR_NAMES.findIndex((_, i) => !used.has(i))) : checkColor(color);
  const id = "cat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const position = categories.length;
  db.prepare("INSERT INTO categories (id, name, color, position, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, clean, pick, position, new Date().toISOString());
  return { id, name: clean, color: pick };
}

// Rename and/or recolor
export function updateCategory(db, id, { name, color } = {}) {
  ensureAppSettings(db);
  const categories = loadCategories(db);
  const category = findCategory(categories, id);
  const newName = name === undefined ? category.name : checkCategoryName(categories, name, id);
  const newColor = color === undefined ? category.color : checkColor(color);
  db.prepare("UPDATE categories SET name = ?, color = ?, updated_at = ? WHERE id = ?")
    .run(newName, newColor, new Date().toISOString(), id);
  return { id, name: newName, color: newColor };
}

// Deletes a category. Apps in it (yours and built-in ones) move to Other.
export function deleteCategory(db, id) {
  ensureAppSettings(db);
  findCategory(loadCategories(db), id);
  db.prepare("UPDATE app_settings SET category = ?, updated_at = ? WHERE category = ?")
    .run(OTHER_ID, new Date().toISOString(), id);
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
}

// ids: every category ID, in the new order
export function reorderCategories(db, ids) {
  ensureAppSettings(db);
  const current = loadCategories(db).map((c) => c.id);
  if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length ||
      !ids.every((id) => current.includes(id))) {
    throw new SettingsError("The new order has to list every category once.");
  }
  const update = db.prepare("UPDATE categories SET position = ? WHERE id = ?");
  ids.forEach((id, i) => update.run(i, id));
}

export function loadAppSettings(db) {
  if (!tableExists(db, "app_settings")) return new Map();
  return new Map(db.prepare("SELECT app_id, name, category FROM app_settings").all()
    .map((r) => [r.app_id, { name: r.name, category: r.category }]));
}

export function saveAppSetting(db, appId, name, categoryId) {
  ensureAppSettings(db);
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean || clean.length > MAX_APP_NAME_LENGTH) {
    throw new SettingsError(`A name must be 1 to ${MAX_APP_NAME_LENGTH} characters.`);
  }
  if (categoryId !== OTHER_ID) findCategory(loadCategories(db), categoryId);
  db.prepare(
    `INSERT INTO app_settings (app_id, name, category, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, category = excluded.category, updated_at = excluded.updated_at`
  ).run(appId, clean, categoryId, new Date().toISOString());
}

export function removeAppSetting(db, appId) {
  ensureAppSettings(db);
  db.prepare("DELETE FROM app_settings WHERE app_id = ?").run(appId);
}

// Name and category ID for an app: your setting first, then the built-in
// defaults, then the last part of the ID in Other. A category that no
// longer exists counts as Other.
// categories: from loadCategories. source is "yours", "default" or "unnamed".
export function appInfo(appId, settings = new Map(), categories = DEFAULT_CATEGORIES) {
  const exists = (id) => categories.some((c) => c.id === id) ? id : OTHER_ID;
  const mine = settings.get(appId);
  if (mine) return { name: mine.name, category: exists(mine.category), source: "yours" };
  const builtIn = DEFAULT_APPS[appId];
  if (builtIn) return { name: builtIn[0], category: exists(builtIn[1]), source: "default" };
  const last = String(appId || "Unknown").split(".").pop();
  return { name: last.charAt(0).toUpperCase() + last.slice(1), category: OTHER_ID, source: "unnamed" };
}
