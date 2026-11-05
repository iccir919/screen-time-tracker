// public/apps.js
//
// The Apps page. Two views:
//
//   The list: every app by time per day, for the last 7 days, 30 days or all
//   time, on any or all devices, grouped by category (the colors you pick on
//   Organize). Each app shows its device, its last two weeks and its change
//   from the period before. The chips above the list show one category.
//
//   The view of one app or one category, opened by clicking an app or a
//   category's heading: its numbers for the range, a line through its last
//   6 weeks (with each week's lightest to heaviest day), its average for
//   each weekday, today so far against the same weekday, and when during
//   the week you use it. A category's view also lists its apps.
//
// Loads /api/usage from the local server (server.mjs). Shared helpers and
// charts are in common.js.
//
// What you picked is kept in the address
// (#range=30&device=all&cat=2&show=app:com.google.ios.youtube), so a reload
// or Refresh keeps it, and the browser's Back button returns to the list.

import { setupRefresh, showLastArchived } from "./refresh.js";
import {
  DAY, loadUsage, esc, fmt, fmtDate, todayIdx, weekdayOf, hideTip, UNTRACKED_KEY, categoryKeys, categoryColor, categoryName,
  weekLineHtml, weekdayHourHtml, addToHours, localNow, WEEKDAYS, fmtClock, STEPS, stepTotals, runningTotal, runningTotalHtml,
  weekdayBarsHtml,
} from "./common.js";

const SESSION_GAP = 60;       // uses of the same app less than this apart count as one open
const SHOW_FIRST = 5;         // apps listed in each category before "Show all"
const SPARK_DAYS = 14;
const MIN_COMPARE_DAYS = 3;   // compare with the period before only with this many days of data in it
const NEW_BELOW_SECS = 60;    // under a minute a day before: the app counts as new
const WEEKS_SHOWN = 6;        // weeks in an app's or category's trend
const UNTRACKED = -1;         // stands in for an app index for untracked time
const RANGES = [["7", "7 days"], ["30", "30 days"], ["all", "All time"]];

setupRefresh();

const DATA = await loadUsage();
if (!DATA) throw new Error("Data didn't load (the message is on the page).");
showLastArchived(DATA.lastArchived);

const nDev = DATA.devices.length;
const appName = (app) => (app === UNTRACKED ? "Untracked" : DATA.apps[app].name);
const appKey = (app) => (app === UNTRACKED ? "untracked" : DATA.apps[app].id);
// An app index from its key, or null if it isn't in the data
const appFromKey = (key) => {
  if (key === "untracked") return UNTRACKED;
  const i = DATA.apps.findIndex((a) => a.id === key);
  return i === -1 ? null : i;
};
const dayOf = (secs) => Math.floor(secs / DAY);
// The category key for an app index: its category, -1 for Other, or Untracked
const catOf = (app) => (app === UNTRACKED ? UNTRACKED_KEY : DATA.apps[app].cat);
const catKeyFromText = (text) => CAT_KEYS.find((k) => String(k) === text);
// Untracked's stripes can't be mixed into shades, so its charts use Other's gray
const catColor = (key) => categoryColor(DATA, key);
const solidColor = (key) => (key === UNTRACKED_KEY ? "var(--cat-other)" : catColor(key));
const catName = (key) => categoryName(DATA, key);
const CAT_KEYS = categoryKeys(DATA);
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

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

// show: null for the list, or { type: "app", app } / { type: "cat", key }
const state = { range: "30", device: "all", cat: "all", show: null, showAll: false };
let listScroll = 0; // where the list was scrolled to, for coming back to it

function readAddress() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (RANGES.some(([v]) => v === params.get("range"))) state.range = params.get("range");
  const device = params.get("device");
  if (device === "all" || (device !== null && DATA.devices[Number(device)] !== undefined)) state.device = device;
  state.cat = catKeyFromText(params.get("cat")) !== undefined ? params.get("cat") : "all";
  state.show = null;
  const show = params.get("show") ?? "";
  if (show.startsWith("app:")) {
    const app = appFromKey(show.slice(4));
    if (app !== null) state.show = { type: "app", app };
  } else if (show.startsWith("cat:")) {
    const key = catKeyFromText(show.slice(4));
    if (key !== undefined) state.show = { type: "cat", key };
  }
}

function addressText() {
  const params = new URLSearchParams({ range: state.range, device: state.device });
  if (state.cat !== "all") params.set("cat", state.cat);
  if (state.show) params.set("show", state.show.type === "app" ? "app:" + appKey(state.show.app) : "cat:" + state.show.key);
  return "#" + params;
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
    if (!stats.has(app)) stats.set(app, { app, byDay: new Map(), devs: new Set(), opens: 0, lengths: [], longest: null });
    return stats.get(app);
  };

  // Time per day, on every day (for the 14-day line and the period before)
  const addTime = (app, dev, from, to) => {
    const d = dayOf(from);
    const s = get(app);
    s.byDay.set(d, (s.byDay.get(d) ?? 0) + to - from);
    if (d >= start && d <= end) s.devs.add(dev);
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
  const totalPerDay = rows.reduce((sum, r) => sum + r.perDay, 0);
  // Each category's time per day in the period before (every app counts,
  // even ones not used in this period), for the headings' change
  const catBefore = new Map();
  if (prevDays.length) {
    for (const s of stats.values()) {
      const key = catOf(s.app);
      catBefore.set(key, (catBefore.get(key) ?? 0) + sumDays(s, prevStart, prevEnd) / prevDays.length);
    }
  }
  return { devs, start, end, days, prevDays, rows, totalPerDay, catBefore };
}

// ---------- the list ----------

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

// The category chips: All, then each category with time in the range, with
// its time per day. Picking one shows only its apps.
function renderChips(c) {
  const totals = new Map();
  for (const r of c.rows) totals.set(catOf(r.app), (totals.get(catOf(r.app)) ?? 0) + r.perDay);
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const chips = [["all", "All", "", sum]].concat(CAT_KEYS.filter((k) => totals.has(k))
    .map((k) => [String(k), catName(k), catColor(k), totals.get(k)]));
  document.getElementById("cat-filter").innerHTML = chips.map(([v, name, color, secs]) =>
    '<button class="chip" data-v="' + esc(v) + '" aria-pressed="' + (v === state.cat) + '">' +
    (color ? '<span class="swatch" style="background:' + color + '"></span>' : "") + esc(name) +
    '<span class="chip-time">' + fmt(secs) + "</span></button>").join("");
}

function sparkline(s, color) {
  const vals = [];
  for (let d = todayIdx - SPARK_DAYS + 1; d <= todayIdx; d++) vals.push(s.byDay.get(d) ?? 0);
  const max = Math.max(...vals) || 1;
  const pts = vals.map((v, i) => ((i / (vals.length - 1)) * 140).toFixed(1) + "," + (29 - (v / max) * 26).toFixed(1)).join(" ");
  return '<svg class="spark" viewBox="0 0 140 32" preserveAspectRatio="none" aria-hidden="true">' +
    '<polyline points="' + pts + '" style="stroke:' + color + '"></polyline></svg>';
}

// The change from the period before, in plain text: more time isn't
// always worse (or better), so it isn't colored
function changeCell(r) {
  if (!r.change) return '<span class="change flat">–</span>';
  if (r.change.kind === "unknown") {
    return '<span class="change flat" data-tip="Not enough data from before this period to compare">–</span>';
  }
  const tip = "Last " + state.range + " days: " + fmt(r.perDay) + " a day\nThe " + state.range + " days before: " + fmt(r.change.before) + " a day";
  if (r.change.kind === "new") return '<span class="change" data-tip="' + esc(tip) + '">new</span>';
  const p = r.change.pct;
  if (p === 0) return '<span class="change flat" data-tip="' + esc(tip) + '">0%</span>';
  return '<span class="change" data-tip="' + esc(tip) + '">' + (p > 0 ? "+" : "−") + Math.abs(p) + "%</span>";
}

const opensText = (perDay) => (perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1).replace(/\.0$/, "")) + "";

// A category's change from the period before, worked out like an app's
function categoryChange(c, key, perDay) {
  if (state.range === "all") return null;
  if (c.prevDays.length < MIN_COMPARE_DAYS) return { kind: "unknown" };
  const before = c.catBefore.get(key) ?? 0;
  return before < NEW_BELOW_SECS ? { kind: "new", before } : { kind: "pct", before, pct: Math.round(((perDay - before) / before) * 100) };
}

// The list, grouped by category: a heading for each category (its color,
// name, how many apps and its time per day), then its apps. Clicking an app
// or a heading opens its view.
function renderList(c) {
  const apps = c.rows.filter((r) => r.app !== UNTRACKED).length;
  document.getElementById("head-title").innerHTML = "<h1>Your apps</h1>" +
    '<p class="summary">' + esc(c.rows.length
      ? fmt(c.totalPerDay) + " a day across " + plural(apps, "app") + ", " + rangeLabel(c.start)
      : "No app time " + rangeLabel(c.start) + ".") + "</p>";

  const table = document.getElementById("app-table");
  const showAll = document.getElementById("show-all");
  const rows = c.rows.filter((r) => state.cat === "all" || String(catOf(r.app)) === state.cat);
  if (!rows.length) {
    table.innerHTML = '<p class="hint list-empty">Nothing recorded for this range and device.</p>';
    showAll.innerHTML = "";
    return;
  }

  // Categories by time per day, most first; Untracked last
  const groups = new Map();
  for (const r of rows) {
    const key = catOf(r.app);
    if (!groups.has(key)) groups.set(key, { key, rows: [], perDay: 0 });
    groups.get(key).rows.push(r);
    groups.get(key).perDay += r.perDay;
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (a.key === UNTRACKED_KEY) - (b.key === UNTRACKED_KEY) || b.perDay - a.perDay);
  // With every category showing, each lists its top few until "Show all";
  // with one picked, all its apps show
  const limit = state.cat === "all" && !state.showAll ? SHOW_FIRST : Infinity;
  let hidden = 0;

  const line = (r, color) => {
    const isGap = r.app === UNTRACKED;
    const where = isGap ? "–" : [...r.devs].sort((a, b) => a - b).map((d) => DATA.devices[d]).join(", ");
    return '<div class="app-line" data-app="' + esc(appKey(r.app)) + '">' +
      "<span></span>" +
      '<button class="app-who" aria-label="' + esc(appName(r.app) + ", " + fmt(r.perDay) + " a day. Open") + '">' +
      "<b>" + esc(appName(r.app)) + "</b>" + (isGap ? "<span>Screen on, no app recorded</span>" : "") + "</button>" +
      '<span class="device">' + esc(where) + "</span>" +
      sparkline(r, solidColor(catOf(r.app))) +
      '<span class="num per-day">' + fmt(r.perDay) + "</span>" +
      '<span class="num opens" data-tip="' + esc(isGap ? "Not counted for untracked time" : r.opens + " opens in all") + '">' +
      (isGap ? "–" : opensText(r.opensPerDay)) + "</span>" +
      '<span class="num">' + changeCell(r) + "</span></div>";
  };

  table.innerHTML =
    '<div class="app-line head"><span></span><span>App</span><span class="device">Device</span><span class="col-spark">Last ' + SPARK_DAYS + " days</span>" +
    '<span class="num">Per day</span><span class="num opens">Opens</span><span class="num">Change</span></div>' +
    ordered.map((g) => {
      const color = catColor(g.key);
      const appCount = g.rows.filter((r) => r.app !== UNTRACKED).length;
      const shown = g.rows.slice(0, limit);
      const more = g.rows.length - shown.length;
      hidden += more;
      return '<div class="group">' +
        '<button class="group-head" data-cat="' + esc(String(g.key)) + '" aria-label="' + esc("Open " + catName(g.key)) + '">' +
        '<span class="stripe" style="background:' + color + '"></span>' +
        '<span><b class="group-name">' + esc(catName(g.key)) + '</b><span class="open-mark" aria-hidden="true"> ›</span>' +
        (g.key === UNTRACKED_KEY ? "" : '<span class="muted"> · ' + plural(appCount, "app") + "</span>") + "</span>" +
        '<span class="group-time">' + fmt(g.perDay) + "</span>" +
        '<span class="group-change">' + changeCell({ perDay: g.perDay, change: categoryChange(c, g.key, g.perDay) }) + "</span></button>" +
        '<div class="group-rows">' + shown.map((r) => line(r, color)).join("") +
        (more ? '<button class="group-more" data-more>and ' + more + " more</button>" : "") + "</div></div>";
    }).join("");
  showAll.innerHTML = state.cat === "all" && (hidden || state.showAll)
    ? '<button class="show-all" id="show-all-button">' + (state.showAll ? "Show the top " + SHOW_FIRST + " in each" : "Show all " + rows.length) + "</button>"
    : "";
}

// ---------- the view of one app or one category ----------

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const pctText = (p) => (p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)) + "%";
const short = (d) => fmtDate(d, { month: "short", day: "numeric" });
const mondayOf = (day) => day - (weekdayOf(day) + 6) % 7;

// Time per day for whatever matches (an app, or a category's apps), and for
// everything, on the chosen devices. matches(app index) -> true or false.
function dailyTotals(matches) {
  const devSet = new Set(selectedDevices());
  const mine = new Map(), all = new Map();
  const add = (map, d, secs) => map.set(d, (map.get(d) ?? 0) + secs);
  for (const [dev, app, start, end] of DATA.segs) {
    if (!devSet.has(dev)) continue;
    add(all, dayOf(start), end - start);
    if (matches(app)) add(mine, dayOf(start), end - start);
  }
  for (const [dev, start, end] of DATA.gaps) {
    if (!devSet.has(dev)) continue;
    add(all, dayOf(start), end - start);
    if (matches(UNTRACKED)) add(mine, dayOf(start), end - start);
  }
  return { mine, all };
}

// The last 6 weeks, Monday to Sunday, this week last (today left out while
// it's going). Each week: its daily average over the days with data, its
// lightest and heaviest day, and its share of all your time.
function weeklyTrend(totals) {
  const devs = selectedDevices();
  const thisMonday = mondayOf(todayIdx);
  const first = thisMonday - (WEEKS_SHOWN - 1) * 7;
  const weeks = [];
  for (let w = 0; w < WEEKS_SHOWN; w++) {
    const from = first + w * 7;
    let days = daysWithData(from, Math.min(from + 6, todayIdx - 1), devs);
    // On a Monday no full day of this week has passed, so show today so far
    if (!days.length && from === thisMonday) days = daysWithData(todayIdx, todayIdx, devs);
    const vals = days.map((d) => totals.mine.get(d) ?? 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    const allSum = days.reduce((a, d) => a + (totals.all.get(d) ?? 0), 0);
    weeks.push({
      from, days, current: from === thisMonday,
      avg: days.length ? sum / days.length : null,
      lowDay: days.length ? days[vals.indexOf(Math.min(...vals))] : null,
      highDay: days.length ? days[vals.indexOf(Math.max(...vals))] : null,
      share: allSum ? (sum / allSum) * 100 : null,
    });
  }
  const allDays = weeks.flatMap((w) => w.days);
  const mineSum = allDays.reduce((a, d) => a + (totals.mine.get(d) ?? 0), 0);
  const allSum = allDays.reduce((a, d) => a + (totals.all.get(d) ?? 0), 0);
  return {
    weeks, first,
    average: allDays.length ? mineSum / allDays.length : null,
    averageShare: allSum ? (mineSum / allSum) * 100 : null,
  };
}

function weekCard(trend, totals) {
  const range = (w) => (w.current ? short(w.from) + " to today" : short(w.from) + " to " + short(w.from + 6));
  const dayText = (d) => fmtDate(d, { weekday: "short" }) + " " + fmt(totals.mine.get(d) ?? 0);
  const line = weekLineHtml(trend.weeks.map((w) => ({
    label: w.current ? "This week" : short(w.from), value: w.avg, current: w.current,
    low: w.lowDay === null ? null : totals.mine.get(w.lowDay) ?? 0,
    high: w.highDay === null ? null : totals.mine.get(w.highDay) ?? 0,
    tip: [range(w) + (w.current ? " (so far)" : "") + ": " + (w.avg === null ? "no data" : fmt(w.avg) + " a day")]
      .concat(w.avg === null ? [] : ["Lightest: " + dayText(w.lowDay), "Heaviest: " + dayText(w.highDay)]).join("\n"),
  })), { format: fmt, average: trend.average, floor: 60 });
  return '<section class="card"><div class="card-head"><h2>Week by week</h2><span class="hint"><span class="avg-key"></span>6-week average ' +
    (trend.average === null ? "–" : "<b>" + fmt(trend.average) + "</b>") + '</span></div>' + line +
    '<p class="hint">A day, on average. The gray bar runs from the week\'s lightest day to its heaviest.</p></section>';
}

// Its average for each weekday, over the days with data in the last 6 weeks
// (today left out while it's going); today's weekday is outlined
function weekdayCard(trend, totals, color, name) {
  const byWeekday = Array.from({ length: 7 }, () => []);
  for (const d of daysWithData(trend.first, todayIdx - 1, selectedDevices())) byWeekday[weekdayOf(d)].push(totals.mine.get(d) ?? 0);
  const days = byWeekday.map((vals) => {
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { total: avg, parts: [[color, avg, name]] };
  });
  return '<section class="card bars-card"><div class="card-head"><h2>By weekday</h2><span class="hint">A day, last 6 weeks</span></div>' +
    '<div class="weekdays">' + weekdayBarsHtml(days, { chosen: weekdayOf(todayIdx), hint: "last 6 weeks" }) + "</div></section>";
}

// Today so far, added up through the day, against the same weekday last week
// and the average for that weekday over the 6 weeks before
function runCard(matches) {
  const devs = selectedDevices();
  const devSet = new Set(devs);
  const wanted = [todayIdx];
  for (let k = 1; k <= 6; k++) wanted.push(todayIdx - 7 * k);
  const spans = new Map(wanted.map((d) => [d, []]));
  for (const [dev, app, start, end] of DATA.segs) {
    if (devSet.has(dev) && spans.has(dayOf(start)) && matches(app)) spans.get(dayOf(start)).push([start, end]);
  }
  if (matches(UNTRACKED)) {
    for (const [dev, start, end] of DATA.gaps) if (devSet.has(dev) && spans.has(dayOf(start))) spans.get(dayOf(start)).push([start, end]);
  }
  const line = (d) => runningTotal(stepTotals(spans.get(d), d));
  const hasData = (d) => daysWithData(d, d, devs).length > 0;
  const before = wanted.slice(1).filter(hasData).map(line);
  const avg = before.length ? before[0].map((_, i) => before.reduce((a, l) => a + l[i], 0) / before.length) : null;
  const w = weekdayOf(todayIdx);
  const nowStep = ((localNow() % DAY) / DAY) * STEPS;
  return '<section class="card"><div class="card-head"><h2>So far today</h2><span class="hint">By ' + esc(fmtClock(localNow())) + "</span></div>" +
    runningTotalHtml(
      { main: line(todayIdx), last: hasData(todayIdx - 7) ? line(todayIdx - 7) : null, avg },
      { main: "Today", last: "Last " + WEEKDAYS[w], avg: "Average " + WEEKDAYS[w] + " (" + before.length + (before.length === 1 ? " week" : " weeks") + ")" },
      nowStep) + "</section>";
}

// When during the week: the average time in each hour, over the 6 weeks
function hoursCard(trend, matches, color) {
  const devs = selectedDevices();
  const devSet = new Set(devs);
  const days = new Set(daysWithData(trend.first, todayIdx - 1, devs));
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = new Array(7).fill(0);
  for (const d of days) counts[weekdayOf(d)]++;
  for (const [dev, app, start, end] of DATA.segs) {
    if (devSet.has(dev) && days.has(dayOf(start)) && matches(app)) addToHours(sums, weekdayOf(dayOf(start)), start, end);
  }
  if (matches(UNTRACKED)) {
    for (const [dev, start, end] of DATA.gaps) {
      if (devSet.has(dev) && days.has(dayOf(start))) addToHours(sums, weekdayOf(dayOf(start)), start, end);
    }
  }
  return '<section class="card"><div class="card-head"><h2>When you use it</h2><span class="hint">Last 6 weeks</span></div>' +
    weekdayHourHtml(sums, counts, { color }) + "</section>";
}

function statCards(stats) {
  return '<div class="detail-stats">' + stats.map(([label, value, tip]) =>
    '<div class="stat"' + (tip ? ' data-tip="' + esc(tip) + '" tabindex="0"' : "") + "><span>" + esc(label) + "</span><b>" + esc(value) + "</b></div>").join("") +
    "</div>";
}

// The top of a view: Back, then a line about it, then its name. For an app,
// catKey makes its category a link to the category's view.
function detailHead({ color, text, title, catKey = null }) {
  const link = catKey === null ? "" :
    '<button class="cat-link" id="cat-link" data-cat="' + esc(String(catKey)) + '"><span class="swatch" style="background:' + color + '"></span>' +
    esc(catName(catKey)) + '<span class="open-mark" aria-hidden="true">›</span></button>';
  document.getElementById("head-title").innerHTML =
    '<button class="back-link" id="back">‹ Back</button>' +
    '<div class="detail-kicker">' + (link || '<span class="swatch" style="background:' + color + '"></span>') +
    (text ? "<span>" + esc(text) + "</span>" : "") + "</div>" +
    "<h1>" + esc(title) + "</h1>";
}

function renderAppView(c, app) {
  const key = catOf(app);
  const isGap = app === UNTRACKED;
  const r = c.rows.find((x) => x.app === app);
  const nDays = Math.max(1, c.days.length);
  const devices = r ? [...r.devs].sort((a, b) => a - b).map((d) => DATA.devices[d]).join(" and ") : "";
  // Its part of its category's time, in the range
  const catPerDay = c.rows.filter((x) => catOf(x.app) === key).reduce((a, x) => a + x.perDay, 0);
  const ofCategory = r && catPerDay && !isGap ? pctText((r.perDay / catPerDay) * 100) + " of the category" : "";
  detailHead({
    color: catColor(key), title: appName(app), catKey: isGap ? null : key,
    text: [isGap ? "Screen on, no app recorded" : "", devices, ofCategory].filter(Boolean).join(" · "),
  });
  const when = rangeLabel(c.start);
  const stats = [
    ["Per day", r ? fmt(r.perDay) : "–", "On average, " + when],
    [isGap ? "Times a day" : "Opens a day", r ? opensText(r.opens / nDays) : "–"],
    // The average adds up with the time per day (time ÷ opens); the median
    // and the longest show on hover
    [isGap ? "Average stretch" : "Average session", r && r.opens ? fmt(r.secs / r.opens) : "–",
      r && r.opens ? "Half are under " + fmt(median(r.lengths)) + "\nLongest: " + fmt(r.longest.secs) + ", " +
        fmtDate(r.longest.day, { weekday: "long", month: "short", day: "numeric" }) : ""],
    ["Of your day", r && c.totalPerDay ? pctText((r.perDay / c.totalPerDay) * 100) : "–", "Of all your screen time, " + when],
  ];
  const matches = (a) => a === app;
  const totals = dailyTotals(matches);
  const trend = weeklyTrend(totals);
  const color = solidColor(key);
  document.getElementById("detail-view").innerHTML = statCards(stats) +
    '<div class="detail-grid">' + weekCard(trend, totals) + weekdayCard(trend, totals, color, appName(app)) + "</div>" +
    '<div class="detail-grid">' + runCard(matches) + hoursCard(trend, matches, color) + "</div>" +
    (isGap ? "" : '<a class="detail-link" href="/organize#search=' + encodeURIComponent(appName(app)) + '">Rename it or change its category</a>');
}

function renderCategoryView(c, key) {
  const rows = c.rows.filter((r) => catOf(r.app) === key);
  const perDay = rows.reduce((a, r) => a + r.perDay, 0);
  const appRows = rows.filter((r) => r.app !== UNTRACKED);
  const used = c.days.filter((d) => rows.some((r) => (r.byDay.get(d) ?? 0) > 0)).length;
  detailHead({
    color: catColor(key), title: catName(key),
    text: key === UNTRACKED_KEY ? "Screen on, no app recorded" : "Category · " + plural(appRows.length, "app"),
  });
  const when = rangeLabel(c.start);
  const stats = [
    ["Per day", fmt(perDay), "On average, " + when],
    ["Apps used", String(appRows.length)],
    ["Days used", used + " of " + c.days.length, "Days with any time in " + catName(key) + ", " + when],
    ["Of your day", c.totalPerDay ? pctText((perDay / c.totalPerDay) * 100) : "–", "Of all your screen time, " + when],
  ];
  const matches = (a) => catOf(a) === key;
  const totals = dailyTotals(matches);
  const trend = weeklyTrend(totals);

  // Its apps: device, part of the category, a line through its own 6 weeks,
  // time per day and change from the period before
  const color = solidColor(key);
  const appList = appRows.length ? '<section class="card"><div class="card-head"><h2>Its apps</h2><span class="hint">' + esc(when) +
    '</span></div><div class="members">' +
    '<div class="member head"><span>App</span><span>Device</span><span>Share of the category</span><span>Last 6 weeks</span>' +
    '<span class="num">Per day</span><span class="num">Change</span></div>' +
    appRows.map((r) => {
      const own = weeklyTrend(dailyTotals((a) => a === r.app)).weeks.map((w) => w.avg ?? 0);
      const max = Math.max(...own) || 1;
      const pts = own.map((v, i) => ((i / (own.length - 1)) * 100).toFixed(1) + "," + (22 - (v / max) * 18).toFixed(1)).join(" ");
      const share = perDay ? (r.perDay / perDay) * 100 : 0;
      const devices = [...r.devs].sort((x, y) => x - y).map((d) => DATA.devices[d]).join(", ");
      return '<button class="member" data-app="' + esc(appKey(r.app)) + '">' +
        '<span class="member-name">' + esc(appName(r.app)) + "</span>" +
        '<span class="member-device">' + esc(devices) + "</span>" +
        '<span class="member-share"><span class="bar-track"><span class="bar-fill" style="width:' + Math.max(1.5, share).toFixed(1) +
        "%;background:" + color + '"></span></span><span class="member-pct">' + (share < 1 ? "<1%" : pctText(share)) + "</span></span>" +
        '<svg class="member-trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts +
        '" style="stroke:' + color + '"></polyline></svg>' +
        '<span class="num member-time">' + fmt(r.perDay) + "</span>" +
        '<span class="num">' + changeCell(r) + "</span></button>";
    }).join("") + "</div></section>" : "";

  document.getElementById("detail-view").innerHTML = statCards(stats) + appList +
    '<div class="detail-grid">' + weekCard(trend, totals) + weekdayCard(trend, totals, color, catName(key)) + "</div>" +
    '<div class="detail-grid">' + runCard(matches) + hoursCard(trend, matches, color) + "</div>" +
    (key === UNTRACKED_KEY ? "" : '<div class="detail-links"><a class="detail-link" href="/trends#focus=' + encodeURIComponent("cat:" + String(key)) +
      (state.device === "all" ? "" : "&device=" + state.device) + '">See its days and hours in Trends</a>' +
      '<a class="detail-link" href="/organize">Edit categories</a></div>');
}

// ---------- drawing and clicks ----------

function render() {
  const c = compute();
  if (state.cat !== "all" && !c.rows.some((r) => String(catOf(r.app)) === state.cat)) state.cat = "all";
  history.replaceState(history.state, "", addressText());
  renderFilters();
  const inDetail = Boolean(state.show);
  document.getElementById("list-view").hidden = inDetail;
  document.getElementById("detail-view").hidden = !inDetail;
  if (!inDetail) {
    renderChips(c);
    renderList(c);
  } else if (state.show.type === "app") {
    renderAppView(c, state.show.app);
  } else {
    renderCategoryView(c, state.show.key);
  }
}

// Opening a view adds a step to the browser's history, so Back returns to the list
function open(show) {
  listScroll = window.scrollY;
  state.show = show;
  hideTip();
  history.pushState({ detail: true }, "", addressText());
  render();
  window.scrollTo(0, 0);
}

function backToList() {
  hideTip();
  if (history.state?.detail) {
    history.back(); // the popstate handler below draws the list
  } else {
    state.show = null;
    render();
    window.scrollTo(0, listScroll);
  }
}

window.addEventListener("popstate", () => {
  const wasDetail = Boolean(state.show);
  readAddress();
  render();
  if (wasDetail && !state.show) window.scrollTo(0, listScroll);
});

document.getElementById("head-title").addEventListener("click", (e) => {
  if (e.target.closest("#back")) return backToList();
  const link = e.target.closest("#cat-link");
  if (link) open({ type: "cat", key: catKeyFromText(link.dataset.cat) });
});
document.getElementById("app-table").addEventListener("click", (e) => {
  if (e.target.closest("[data-more]")) {
    state.showAll = true;
    render();
    return;
  }
  const head = e.target.closest(".group-head[data-cat]");
  if (head) return open({ type: "cat", key: catKeyFromText(head.dataset.cat) });
  const line = e.target.closest(".app-line[data-app]");
  const app = line ? appFromKey(line.dataset.app) : null;
  if (app !== null) open({ type: "app", app });
});
document.getElementById("detail-view").addEventListener("click", (e) => {
  const member = e.target.closest(".member[data-app]");
  const app = member ? appFromKey(member.dataset.app) : null;
  if (app !== null) open({ type: "app", app });
});
document.getElementById("cat-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || b.dataset.v === state.cat) return;
  state.cat = b.dataset.v;
  state.showAll = false;
  render();
});
document.getElementById("show-all").addEventListener("click", (e) => {
  if (!e.target.closest("#show-all-button")) return;
  state.showAll = !state.showAll;
  render();
});

readAddress();
render();
