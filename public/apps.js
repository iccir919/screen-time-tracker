// public/apps.js
//
// The Apps page: every app ranked by time per day, for the last 7 days,
// 30 days or all time, on any or all devices, each with its last two weeks
// and its change from the period before. Click an app for its details.
// Loads /api/usage from the local server (server.mjs). Shared helpers are
// in common.js.
//
// What you picked is kept in the address (#range=30&device=all&app=...),
// so a reload or Refresh keeps it.

import { setupRefresh, showLastArchived } from "./refresh.js";
import { DAY, loadUsage, esc, fmt, fmtDate, isoDay, todayIdx } from "./common.js";

const SESSION_GAP = 60;       // uses of the same app less than this apart count as one open
const SHOW_FIRST = 15;        // apps listed before "Show all"
const SPARK_DAYS = 14;
const MIN_COMPARE_DAYS = 3;   // compare with the period before only with this many days of data in it
const NEW_BELOW_SECS = 60;    // under a minute a day before: the app counts as new
const UNTRACKED = -1;         // stands in for an app index for untracked time
const RANGES = [["7", "7 days"], ["30", "30 days"], ["all", "All time"]];

setupRefresh();

const DATA = await loadUsage();
if (!DATA) throw new Error("Data didn't load (the message is on the page).");
showLastArchived(DATA.lastArchived);

const nDev = DATA.devices.length;
const appName = (app) => (app === UNTRACKED ? "Untracked" : DATA.apps[app].name);
const appKey = (app) => (app === UNTRACKED ? "untracked" : DATA.apps[app].id);
const dayOf = (secs) => Math.floor(secs / DAY);

// ---------- the data ----------

// Days each device has data for (any app time)
const deviceDays = DATA.devices.map(() => new Set());
for (const [dev, , start] of DATA.segs) deviceDays[dev].add(dayOf(start));
const firstDay = Math.min(todayIdx, ...deviceDays.flatMap((s) => [...s]));

// Sessions: back-to-back uses of the same app on one device, within a day.
// [device, app, start, end, activeSecs]. The server sends segs sorted by
// device, then start time.
const SESSIONS = (() => {
  const out = [];
  let cur = null;
  for (const [dev, app, start, end] of DATA.segs) {
    if (cur && cur[0] === dev && cur[1] === app && dayOf(cur[2]) === dayOf(start) && start - cur[3] <= SESSION_GAP) {
      cur[3] = Math.max(cur[3], end);
      cur[4] += end - start;
    } else {
      if (cur) out.push(cur);
      cur = [dev, app, start, end, end - start];
    }
  }
  if (cur) out.push(cur);
  return out;
})();

// ---------- what you picked ----------

const state = { range: "30", device: "all", app: null, showAll: false };

function readAddress() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (RANGES.some(([v]) => v === params.get("range"))) state.range = params.get("range");
  const device = params.get("device");
  if (device === "all" || (device !== null && DATA.devices[Number(device)] !== undefined)) state.device = device;
  if (params.get("app")) state.app = params.get("app");
}

function writeAddress() {
  const params = new URLSearchParams({ range: state.range, device: state.device });
  if (state.app) params.set("app", state.app);
  history.replaceState(null, "", "#" + params);
}

const selectedDevices = () => (state.device === "all" ? DATA.devices.map((_, i) => i) : [Number(state.device)]);

function rangeBounds() {
  const end = todayIdx;
  const start = state.range === "all" ? firstDay : end - Number(state.range) + 1;
  return { start, end, length: end - start + 1 };
}

function daysWithData(from, to, devs) {
  const days = [];
  for (let d = from; d <= to; d++) if (devs.some((dev) => deviceDays[dev].has(d))) days.push(d);
  return days;
}

// ---------- the numbers for the current choice ----------

function compute() {
  const devs = selectedDevices();
  const devSet = new Set(devs);
  const { start, end, length } = rangeBounds();
  const prevStart = start - length, prevEnd = start - 1;
  const days = daysWithData(start, end, devs);
  const prevDays = state.range === "all" ? [] : daysWithData(prevStart, prevEnd, devs);

  const stats = new Map(); // app -> details
  const get = (app) => {
    if (!stats.has(app)) {
      stats.set(app, { app, byDay: new Map(), hours: new Array(24).fill(0), devs: new Set(), opens: 0, lengths: [], longest: null });
    }
    return stats.get(app);
  };

  // Time per day (all days, for the 14-day line and the period before) and
  // per hour of the day (in the range only)
  const addTime = (app, dev, from, to) => {
    const d = dayOf(from);
    const s = get(app);
    s.byDay.set(d, (s.byDay.get(d) ?? 0) + to - from);
    if (d < start || d > end) return;
    s.devs.add(dev);
    for (let t = from; t < to;) {
      const hourEnd = (Math.floor(t / 3600) + 1) * 3600;
      const upTo = Math.min(to, hourEnd);
      s.hours[Math.floor((t % DAY) / 3600)] += upTo - t;
      t = upTo;
    }
  };
  for (const [dev, app, from, to] of DATA.segs) if (devSet.has(dev)) addTime(app, dev, from, to);
  for (const [dev, from, to] of DATA.gaps) if (devSet.has(dev)) addTime(UNTRACKED, dev, from, to);

  // Opens and session lengths, in the range
  const addSession = (app, from, active) => {
    const d = dayOf(from);
    if (d < start || d > end) return;
    const s = get(app);
    s.opens++;
    s.lengths.push(active);
    if (!s.longest || active > s.longest.secs) s.longest = { secs: active, day: d };
  };
  for (const [dev, app, from, , active] of SESSIONS) if (devSet.has(dev)) addSession(app, from, active);
  for (const [dev, from, to] of DATA.gaps) if (devSet.has(dev)) addSession(UNTRACKED, from, to - from);

  const sumDays = (s, from, to) => { let t = 0; for (let d = from; d <= to; d++) t += s.byDay.get(d) ?? 0; return t; };
  const nDays = Math.max(1, days.length);
  const rows = [];
  for (const s of stats.values()) {
    const secs = sumDays(s, start, end);
    if (secs <= 0) continue;
    const perDay = secs / nDays;
    let change = null;
    if (state.range !== "all") {
      if (prevDays.length < MIN_COMPARE_DAYS) change = { kind: "unknown" };
      else {
        const before = sumDays(s, prevStart, prevEnd) / prevDays.length;
        change = before < NEW_BELOW_SECS ? { kind: "new", before } : { kind: "pct", before, pct: Math.round(((perDay - before) / before) * 100) };
      }
    }
    rows.push({ ...s, secs, perDay, opensPerDay: s.opens / nDays, change });
  }
  rows.sort((a, b) => b.perDay - a.perDay);
  return { devs, start, end, days, prevDays, rows };
}

// ---------- drawing ----------

function rangeLabel(start) {
  if (state.range === "all") return "since " + fmtDate(start, { month: "short", day: "numeric" });
  return "last " + state.range + " days";
}

function renderFilters() {
  const seg = (el, options, current, pick) => {
    el.innerHTML = options.map(([v, label]) =>
      '<button data-v="' + esc(v) + '" aria-pressed="' + (v === current) + '">' + esc(label) + "</button>").join("");
    el.onclick = (e) => {
      const b = e.target.closest("button[data-v]");
      if (b) pick(b.dataset.v);
    };
  };
  seg(document.getElementById("range-filter"), RANGES, state.range, (v) => { state.range = v; state.showAll = false; render(); });
  const deviceEl = document.getElementById("device-filter");
  deviceEl.hidden = nDev < 2;
  seg(deviceEl, [["all", "All devices"]].concat(DATA.devices.map((name, i) => [String(i), name])), state.device,
    (v) => { state.device = v; state.showAll = false; render(); });
}

function sparkline(s, isGap) {
  const vals = [];
  for (let d = todayIdx - SPARK_DAYS + 1; d <= todayIdx; d++) vals.push(s.byDay.get(d) ?? 0);
  const max = Math.max(...vals) || 1;
  const pts = vals.map((v, i) => ((i / (vals.length - 1)) * 140).toFixed(1) + "," + (29 - (v / max) * 26).toFixed(1)).join(" ");
  return '<svg class="spark' + (isGap ? " gap" : "") + '" viewBox="0 0 140 32" preserveAspectRatio="none" aria-hidden="true">' +
    '<polyline points="' + pts + '"></polyline></svg>';
}

function changeCell(r) {
  if (!r.change) return '<span class="change flat">–</span>';
  if (r.change.kind === "unknown") {
    return '<span class="change flat" data-tip="Not enough data from before this period to compare">–</span>';
  }
  const tip = "Last " + state.range + " days: " + fmt(r.perDay) + " a day\nThe " + state.range + " days before: " + fmt(r.change.before) + " a day";
  if (r.change.kind === "new") return '<span class="change more" data-tip="' + esc(tip) + '">new</span>';
  const p = r.change.pct;
  if (p === 0) return '<span class="change flat" data-tip="' + esc(tip) + '">0%</span>';
  return '<span class="change ' + (p > 0 ? "more" : "less") + '" data-tip="' + esc(tip) + '">' + (p > 0 ? "+" : "−") + Math.abs(p) + "%</span>";
}

function renderList(c) {
  const total = c.rows.reduce((sum, r) => sum + r.perDay, 0);
  const apps = c.rows.filter((r) => r.app !== UNTRACKED).length;
  document.getElementById("summary").textContent = c.rows.length
    ? fmt(total) + " a day across " + apps + (apps === 1 ? " app" : " apps") + ", " + rangeLabel(c.start)
    : "No app time " + rangeLabel(c.start) + ".";

  const table = document.getElementById("app-table");
  const showAll = document.getElementById("show-all");
  if (!c.rows.length) {
    table.innerHTML = '<p class="hint list-empty">Nothing recorded for this range and device.</p>';
    showAll.innerHTML = "";
    return;
  }
  const shown = state.showAll ? c.rows : c.rows.slice(0, SHOW_FIRST);
  let rank = 0;
  table.innerHTML =
    '<div class="app-line head"><span>#</span><span>App</span><span class="col-spark">Last ' + SPARK_DAYS + ' days</span>' +
    '<span class="num">Per day</span><span class="num opens">Opens</span><span class="num">Change</span></div>' +
    shown.map((r) => {
      const isGap = r.app === UNTRACKED;
      if (!isGap) rank++;
      const where = isGap ? "Screen on, no app recorded" : [...r.devs].sort((a, b) => a - b).map((d) => DATA.devices[d]).join(" and ");
      return '<div class="app-line' + (appKey(r.app) === state.app ? " selected" : "") + '" data-key="' + esc(appKey(r.app)) + '">' +
        '<span class="rank">' + (isGap ? "" : rank) + "</span>" +
        '<button class="app-who" aria-label="' + esc(appName(r.app) + ", " + fmt(r.perDay) + " a day. Show details") + '">' +
        "<b>" + esc(appName(r.app)) + "</b><span>" + esc(where) + "</span></button>" +
        sparkline(r, isGap) +
        '<span class="num per-day">' + fmt(r.perDay) + "</span>" +
        '<span class="num opens" data-tip="' + esc(isGap ? "Not counted for untracked time" : r.opens + " opens in all") + '">' +
        (isGap ? "–" : r.opensPerDay >= 10 ? Math.round(r.opensPerDay) : r.opensPerDay.toFixed(1).replace(/\.0$/, "")) + "</span>" +
        '<span class="num">' + changeCell(r) + "</span></div>";
    }).join("");
  showAll.innerHTML = c.rows.length > SHOW_FIRST
    ? '<button class="show-all" id="show-all-button">' + (state.showAll ? "Show the top " + SHOW_FIRST : "Show all " + c.rows.length) + "</button>"
    : "";
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const hourLabel = (h) => (h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : h - 12 + " PM");

function renderDetail(c) {
  const el = document.getElementById("detail");
  const r = c.rows.find((x) => appKey(x.app) === state.app);
  if (!r) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const isGap = r.app === UNTRACKED;
  const nDays = Math.max(1, c.days.length);
  const where = isGap ? "screen on, no app recorded" : "on " + [...r.devs].sort((a, b) => a - b).map((d) => DATA.devices[d]).join(" and ");

  const facts = [
    [isGap ? "Times a day" : "Opens a day", (r.opens / nDays).toFixed(1).replace(/\.0$/, "")],
    [isGap ? "Typical stretch" : "Typical session", fmt(median(r.lengths))],
    ["Longest", r.longest ? fmt(r.longest.secs) : "–", r.longest ? fmtDate(r.longest.day, { weekday: "long", month: "short", day: "numeric" }) : ""],
  ];

  // Average minutes in each hour, over the days with data
  const hours = r.hours.map((s) => s / nDays);
  const hourMax = Math.max(...hours) || 1;
  const hourBars = hours.map((s, h) =>
    '<span class="b' + (s < 30 ? " zero" : "") + (isGap ? " gap" : "") + '" style="height:' + Math.max(3, (s / hourMax) * 100).toFixed(1) +
    '%" data-tip="' + esc(hourLabel(h) + ": " + fmt(s) + " a day") + '"></span>').join("");

  // Each day in the range; each bar opens that day on the Today page
  const dayMax = Math.max(...Array.from({ length: c.end - c.start + 1 }, (_, i) => r.byDay.get(c.start + i) ?? 0)) || 1;
  const daySet = new Set(c.days);
  let dayBars = "";
  for (let d = c.start; d <= c.end; d++) {
    const secs = r.byDay.get(d) ?? 0;
    const label = fmtDate(d, { weekday: "short", month: "short", day: "numeric" });
    if (!daySet.has(d)) {
      dayBars += '<span class="b none" data-tip="' + esc(label + ": no data") + '"></span>';
    } else {
      const href = "/#day=" + isoDay(d) + (state.device === "all" ? "" : "&device=" + state.device);
      dayBars += '<a class="b' + (secs === 0 ? " zero" : "") + (isGap ? " gap" : "") + '" href="' + href + '" style="height:' +
        Math.max(3, (secs / dayMax) * 100).toFixed(1) + '%" data-tip="' + esc(label + ": " + fmt(secs) + "\nClick to see the day") +
        '" aria-label="' + esc(label + ": " + fmt(secs)) + '"></a>';
    }
  }
  const first = fmtDate(c.start, { month: "short", day: "numeric" });

  el.innerHTML =
    '<div class="detail-head"><span class="label">Selected</span><h2>' + esc(appName(r.app)) + "</h2>" +
    '<span class="line">' + fmt(r.perDay) + " a day, " + esc(where) + "</span></div>" +
    '<div class="facts">' + facts.map(([label, value, tip]) =>
      '<div class="fact"' + (tip ? ' data-tip="' + esc(tip) + '"' : "") + "><span>" + esc(label) + "</span><b>" + esc(value) + "</b></div>").join("") + "</div>" +
    "<div><h3>When during the day</h3>" + '<div class="mini-bars">' + hourBars + "</div>" +
    '<div class="mini-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>' +
    "<div><h3>Each day</h3>" + '<div class="mini-bars">' + dayBars + "</div>" +
    '<div class="mini-axis"><span>' + esc(first) + "</span><span>Today</span></div></div>" +
    (isGap ? "" : '<a class="detail-link" href="/organize#search=' + encodeURIComponent(appName(r.app)) + '">Rename it or change its category</a>');
}

function render() {
  const c = compute();
  // Keep the picked app if it's still listed, otherwise pick the top one
  if (!c.rows.some((r) => appKey(r.app) === state.app)) state.app = c.rows.length ? appKey(c.rows[0].app) : null;
  writeAddress();
  renderFilters();
  renderList(c);
  renderDetail(c);
}

// ---------- clicks ----------

document.getElementById("app-table").addEventListener("click", (e) => {
  const line = e.target.closest(".app-line[data-key]");
  if (!line) return;
  state.app = line.dataset.key;
  render();
  // When the details are below the list (narrow windows), bring them into view
  const detail = document.getElementById("detail");
  if (detail.getBoundingClientRect().top > window.innerHeight - 120) detail.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("show-all").addEventListener("click", (e) => {
  if (!e.target.closest("#show-all-button")) return;
  state.showAll = !state.showAll;
  render();
});

readAddress();
render();
