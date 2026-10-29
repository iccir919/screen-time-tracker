// server.mjs
//
// The local dashboard. Serves the pages in public/ and a small JSON API that
// reads your archive. It only listens on this Mac (127.0.0.1), so nothing is
// reachable from your network.
//
// API:
//   GET /api/usage         sessions, untracked time, devices and apps for the dashboard
//   GET /api/apps          every app seen, with name, category, devices and total time
//   PUT /api/apps/:id      save a name and category ID: {"name": "...", "category": "social"}
//                          or go back to the built-in name: {"reset": true}
//   GET /api/categories    your categories in order, plus Other and the colors
//   POST /api/categories   add one: {"name": "...", "color": 2} (color is optional)
//   PUT /api/categories/:id     rename and/or recolor: {"name": "...", "color": 2}
//   DELETE /api/categories/:id  delete one; its apps move to Other
//   PUT /api/category-order     reorder: {"ids": ["social", "web", ...]}
//   POST /api/archive      run the archiver now (the dashboard's Refresh button)
//
// Run:
//   npm start                      (opens http://localhost:3000)
//   npm start -- --no-open         (don't open a browser)
//   PORT=4000 npm start            (another port)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_DB, COLOR_NAMES, OTHER_ID, OTHER_NAME, SettingsError, openArchiveDb, loadRows, mergeOverlaps,
  loadScreenOn, untrackedGaps, sortDevices, ensureAppSettings, loadAppSettings, saveAppSetting,
  removeAppSetting, appInfo, loadCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
} from "./screen_time_lib.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PROJECT_DIR, "public");
const ARCHIVE_SCRIPT = path.join(PROJECT_DIR, "archive_screen_time.mjs");
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 10_000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Friendly page paths
const PAGES = { "/": "index.html", "/apps": "apps.html" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// decodeURIComponent, but a bad %-sequence is the client's mistake, not a crash
function decodePath(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new HttpError(400, "Bad URL.");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": CONTENT_TYPES[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function withArchive(fn, { readOnly = true } = {}) {
  if (!fs.existsSync(ARCHIVE_DB)) throw new HttpError(404, "No archive yet. Click Refresh on the dashboard, or run npm run archive.");
  const db = openArchiveDb({ readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------- API ----------

// Everything the dashboard needs, in the compact form it expects:
//   categories: [{ name, color }] in your order
//   apps: [{ id, name, cat }] where cat is an index into categories, or -1 for Other
//   segs: [deviceIndex, appIndex, localStartSecs, localEndSecs]
//   gaps: [deviceIndex, localStartSecs, localEndSecs, [[appIndex, localStartSecs], ...]]
function getUsage() {
  return withArchive((db) => {
    const settings = loadAppSettings(db);
    const categories = loadCategories(db);
    const segs = mergeOverlaps(loadRows(db));
    const devices = sortDevices(new Set(segs.map((s) => s.device)));
    const apps = [];
    const appIndex = new Map();
    for (const s of segs) {
      if (appIndex.has(s.app)) continue;
      appIndex.set(s.app, apps.length);
      const info = appInfo(s.app, settings, categories);
      apps.push({ id: s.app, name: info.name, cat: categories.findIndex((c) => c.id === info.category) });
    }
    const out = segs
      .map((s) => [devices.indexOf(s.device), appIndex.get(s.app), Math.round(s.start), Math.round(s.end)])
      .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const gaps = untrackedGaps(segs, loadScreenOn(db))
      .filter((g) => devices.includes(g.device))
      .map((g) => [devices.indexOf(g.device), Math.round(g.start), Math.round(g.end),
        g.hint.map((h) => [appIndex.get(h.app), Math.round(h.start)])]);
    return {
      devices, categories: categories.map((c) => ({ name: c.name, color: c.color })),
      apps, segs: out, gaps, lastArchived: lastArchived(db), generatedAt: new Date().toISOString(),
    };
  });
}

// Every app seen, for the Apps page
function getApps() {
  return withArchive((db) => {
    const settings = loadAppSettings(db);
    const categories = loadCategories(db);
    const stats = new Map();
    for (const s of mergeOverlaps(loadRows(db))) {
      if (!stats.has(s.app)) stats.set(s.app, { devices: new Set(), seconds: 0, firstDay: s.day, lastDay: s.day });
      const st = stats.get(s.app);
      st.devices.add(s.device);
      st.seconds += s.end - s.start;
      if (s.day < st.firstDay) st.firstDay = s.day;
      if (s.day > st.lastDay) st.lastDay = s.day;
    }
    return [...stats].map(([id, st]) => {
      const info = appInfo(id, settings, categories);
      return {
        id, name: info.name, category: info.category, source: info.source,
        devices: sortDevices(st.devices), seconds: Math.round(st.seconds),
        firstDay: st.firstDay, lastDay: st.lastDay,
      };
    });
  });
}

function updateApp(appId, body) {
  if (!appId || appId.length > 200) throw new HttpError(400, "Invalid app ID.");
  return withArchive((db) => {
    if (body?.reset === true) removeAppSetting(db, appId);
    else saveAppSetting(db, appId, body?.name, body?.category);
    const info = appInfo(appId, loadAppSettings(db), loadCategories(db));
    return { id: appId, name: info.name, category: info.category, source: info.source };
  }, { readOnly: false });
}

// When the archiver last finished, or null if it hasn't run since this
// was added
function lastArchived(db) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_info'").get();
  if (!hasTable) return null;
  return db.prepare("SELECT value FROM archive_info WHERE key = 'last_run'").get()?.value ?? null;
}

// Runs the archiver, the same as npm run archive. If a run is already going
// (a second click, or two tabs), this waits for that one instead of
// starting another.
let archiveRun = null;

function runArchiver() {
  if (archiveRun) return archiveRun;
  const started = Date.now();
  archiveRun = new Promise((resolve) => {
    execFile(process.execPath, ["--no-warnings", ARCHIVE_SCRIPT],
      { cwd: PROJECT_DIR, timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = (stdout + (stderr ? "\n" + stderr : "")).trim();
        console.log(output);
        let error = null;
        if (err?.killed) error = "The archiver took more than 10 minutes, so it was stopped.";
        else if (err?.code === 2) {
          error = "The archiver couldn't read Apple's Screen Time files. Give the app you ran npm start from " +
            "(usually Terminal) Full Disk Access in System Settings > Privacy & Security, then quit it, reopen it and start the dashboard again.";
        } else if (err) error = "The archiver stopped with an error. See the terminal for details.";
        resolve({ ok: !error, error, seconds: Math.round((Date.now() - started) / 1000) });
      });
  }).finally(() => { archiveRun = null; });
  return archiveRun;
}

function getCategories() {
  return { categories: withArchive(loadCategories), other: { id: OTHER_ID, name: OTHER_NAME }, colors: COLOR_NAMES };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new HttpError(400, "Body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

// ---------- static files ----------

function serveStatic(res, urlPath) {
  const file = PAGES[urlPath] ?? decodePath(urlPath).replace(/^\/+/, "");
  const full = path.resolve(PUBLIC_DIR, file);
  // Only files inside public/
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new HttpError(404, "Not found.");
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(full).pipe(res);
}

// ---------- requests ----------

// Only answer requests addressed to this server by its local name, so other
// websites open in your browser can't reach the API through tricks like
// pointing their own domain at 127.0.0.1
function checkHost(req) {
  const host = req.headers.host ?? "";
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!allowed.includes(host)) throw new HttpError(403, "Forbidden.");
  // Changes must come from this dashboard's own pages
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !allowed.some((h) => origin === `http://${h}`)) throw new HttpError(403, "Forbidden.");
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Send JSON.");
    }
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  try {
    checkHost(req);
    if (p === "/api/usage" && req.method === "GET") return sendJson(res, 200, getUsage());
    if (p === "/api/apps" && req.method === "GET") return sendJson(res, 200, getApps());
    const appMatch = /^\/api\/apps\/([^/]+)$/.exec(p);
    if (appMatch && req.method === "PUT") {
      return sendJson(res, 200, updateApp(decodePath(appMatch[1]), await readJsonBody(req)));
    }
    if (p === "/api/categories" && req.method === "GET") return sendJson(res, 200, getCategories());
    if (p === "/api/categories" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 201, withArchive((db) => createCategory(db, body), { readOnly: false }));
    }
    const catMatch = /^\/api\/categories\/([^/]+)$/.exec(p);
    if (catMatch && req.method === "PUT") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, withArchive((db) => updateCategory(db, decodePath(catMatch[1]), body), { readOnly: false }));
    }
    if (catMatch && req.method === "DELETE") {
      withArchive((db) => deleteCategory(db, decodePath(catMatch[1])), { readOnly: false });
      return sendJson(res, 200, { deleted: true });
    }
    if (p === "/api/archive" && req.method === "POST") {
      if (process.platform !== "darwin") throw new HttpError(400, "The archiver only runs on macOS.");
      const result = await runArchiver();
      return sendJson(res, result.ok ? 200 : 500, result);
    }
    if (p === "/api/category-order" && req.method === "PUT") {
      const body = await readJsonBody(req);
      withArchive((db) => reorderCategories(db, body?.ids), { readOnly: false });
      return sendJson(res, 200, { ok: true });
    }
    if (p.startsWith("/api/")) throw new HttpError(404, "Not found.");
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    return serveStatic(res, p);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof SettingsError ? 400 : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "Something went wrong. See the terminal." : err.message });
    else res.end();
  }
}

// Set up the settings tables once at startup (this also moves app
// categories saved by earlier versions over to category IDs)
if (fs.existsSync(ARCHIVE_DB)) {
  const db = openArchiveDb({ readOnly: false });
  try {
    ensureAppSettings(db);
  } finally {
    db.close();
  }
}

const server = http.createServer(handle);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${PORT} is already in use. Is the dashboard already running? Or try: PORT=3001 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`Screen Time dashboard: ${address}  (Ctrl+C to stop)`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, "vendor", "chart.umd.min.js"))) {
    console.log("Tip: run  node tools/download_chart_js.mjs  once so the dashboard works offline.");
  }
  if (process.platform === "darwin" && !process.argv.includes("--no-open")) execFile("open", [address]);
});
