// public/today.js
//
// The Today page. Three cards at the top: the day, the 7-day average and
// the 30-day average. Pick one and the whole page follows it: the timeline
// (the day, or an average day by hour), the top apps or categories (that
// day, or per day on average), the bar chart (7 or 30 days, with the
// average drawn in), the hours of the week, and the week-by-week chart,
// which stays the same and outlines the week you're looking at.
// Everything also follows the device switch.
//
// Color means category everywhere (the colors you pick on Organize);
// amounts with no category, like the hours of the week, are in grays.
//
// Loads /api/usage from the local server (server.mjs); shared helpers are
// in common.js. The address keeps what you picked:
// #day=2026-10-26&period=7&device=0&view=categories (no day means today, no
// period means the day, no device means all, no view means apps).

import { setupRefresh, showLastArchived } from "./refresh.js";
import {
  DAY, WEEKDAYS, loadUsage, esc, fmt, dateOf, fmtDate, weekdayOf, isoDay, dayFromIso, fmtClock,
  todayIdx, hideTip, UNTRACKED_KEY, categoryKeys, categoryColor, categoryName,
  hourName, weekLineHtml, weekdayHourHtml, addToHours, localNow, STEPS, stepTotals, runningTotal, runningTotalHtml,
  weekdayBarsHtml,
} from "./common.js";

const SESSION_GAP = 60;          // uses of the same app less than this apart count as one open
const MAX_TOP_ROWS = 8;
const WEEKS_SHOWN = 6;
const UNTRACKED = -1;            // stands in for an app index for untracked time
const PERIODS = ["day", "7", "30"];

setupRefresh(); // what you picked is in the address, so a reload keeps it

const DATA = await loadUsage();
if (!DATA) throw new Error("Data didn't load (the message is on the page).");
showLastArchived(DATA.lastArchived);

const nDev = DATA.devices.length;
const appName = (app) => (app === UNTRACKED ? "Untracked" : DATA.apps[app].name);
// The category key for an app index: its category, -1 for Other, or Untracked
const catOf = (app) => (app === UNTRACKED ? UNTRACKED_KEY : DATA.apps[app].cat);
const catColor = (key) => categoryColor(DATA, key);
const catName = (key) => categoryName(DATA, key);
const CAT_KEYS = categoryKeys(DATA);

// ---------- the data, by day (every device; filtered when drawn) ----------

const byDay = new Map();

function dayEntry(day) {
  if (!byDay.has(day)) {
    byDay.set(day, {
      app: new Array(nDev).fill(0),   // seconds in apps, per device
      gap: new Array(nDev).fill(0),   // untracked seconds, per device
      items: [],                      // [device, app or UNTRACKED, start, end]: everything counted
      sessions: [],                   // [device, app, start, end, activeSecs]
      gaps: [],                       // [device, start, end, hint]
    });
  }
  return byDay.get(day);
}

for (const [dev, app, start, end] of DATA.segs) {
  const e = dayEntry(Math.floor(start / DAY));
  e.app[dev] += end - start;
  e.items.push([dev, app, start, end]);
}

// Join back-to-back uses of the same app into one session, for the
// timeline. The server sends segs sorted by device, then start time.
{
  let cur = null;
  const finish = () => { if (cur) dayEntry(Math.floor(cur[2] / DAY)).sessions.push(cur); };
  for (const [dev, app, start, end] of DATA.segs) {
    const sameDay = cur && Math.floor(cur[2] / DAY) === Math.floor(start / DAY);
    if (cur && sameDay && cur[0] === dev && cur[1] === app && start - cur[3] <= SESSION_GAP) {
      cur[3] = Math.max(cur[3], end);
      cur[4] += end - start;
    } else {
      finish();
      cur = [dev, app, start, end, end - start];
    }
  }
  finish();
}

for (const [dev, start, end, hint] of DATA.gaps) {
  const e = dayEntry(Math.floor(start / DAY));
  e.gap[dev] += end - start;
  e.gaps.push([dev, start, end, hint]);
  e.items.push([dev, UNTRACKED, start, end]);
}

const firstDay = byDay.size ? Math.min(...byDay.keys()) : todayIdx;

// The week-by-week chart's first day: a Monday, 5 weeks before this week's
// Monday. You can go back to it or to your first day of data, whichever is earlier.
const mondayOf = (day) => day - (weekdayOf(day) + 6) % 7;
const weeksStart = mondayOf(todayIdx) - (WEEKS_SHOWN - 1) * 7;
const lowestDay = Math.min(firstDay, weeksStart);
const clampDay = (d) => Math.max(lowestDay, Math.min(todayIdx, d));

// ---------- what you picked ----------

const state = { day: todayIdx, period: "day", device: "all", view: "apps", weeks: "total" };
{
  const hash = decodeURIComponent(location.hash.slice(1));
  const params = new URLSearchParams(hash);
  const d = dayFromIso(hash) ?? dayFromIso(params.get("day") ?? "");
  if (d !== null) state.day = clampDay(d);
  if (PERIODS.includes(params.get("period"))) state.period = params.get("period");
  const device = params.get("device");
  if (device !== null && DATA.devices[Number(device)] !== undefined) state.device = device;
  if (params.get("view") === "categories") state.view = "categories";
  if (params.get("weeks") === "categories") state.weeks = "categories";
}

let devs = []; // the chosen devices, as indexes

function setDevices() {
  devs = state.device === "all" ? DATA.devices.map((_, i) => i) : [Number(state.device)];
}

function writeAddress() {
  const params = new URLSearchParams();
  if (state.day !== todayIdx) params.set("day", isoDay(state.day));
  if (state.period !== "day") params.set("period", state.period);
  if (state.device !== "all") params.set("device", state.device);
  if (state.view !== "apps") params.set("view", state.view);
  if (state.weeks !== "total") params.set("weeks", state.weeks);
  const text = params.toString();
  history.replaceState(null, "", text ? "#" + text : location.pathname);
}

// ---------- totals for the chosen devices ----------

const hasData = (day, dev) => (byDay.get(day)?.app[dev] ?? 0) > 0;
const anyData = (day) => devs.some((dev) => hasData(day, dev));
const complete = (day) => devs.length > 0 && devs.every((dev) => hasData(day, dev));
const deviceTotal = (day, dev) => { const e = byDay.get(day); return e ? e.app[dev] + e.gap[dev] : 0; };
const total = (day) => devs.reduce((sum, dev) => sum + deviceTotal(day, dev), 0);
const items = (day) => (byDay.get(day)?.items ?? []).filter(([dev]) => devs.includes(dev));

// Seconds per category key over some days, divided by how many days (so
// one day gives that day's time, and a period gives a daily average)
function categoryTotals(days) {
  const out = new Map();
  for (const d of days) {
    for (const [, app, start, end] of items(d)) {
      const key = catOf(app);
      out.set(key, (out.get(key) ?? 0) + end - start);
    }
  }
  const n = Math.max(1, days.length);
  for (const [key, secs] of out) out.set(key, secs / n);
  return out;
}

// The days a period covers, ending on the chosen day. While today is still
// going, the averages leave it out and use the full days before it, so a
// morning doesn't pull them down.
function periodWindow(period, end = state.day) {
  if (period === "day") return { from: end, to: end };
  const n = Number(period);
  const to = end === todayIdx ? end - 1 : end;
  return { from: to - n + 1, to };
}

// The days in a period that have data (only those count toward an average)
function periodDays(period, end) {
  const { from, to } = periodWindow(period, end);
  const days = [];
  for (let d = from; d <= to; d++) if (anyData(d)) days.push(d);
  return days;
}

// The days the chosen card covers that have data
const chosenDays = () => (state.period === "day" ? (anyData(state.day) ? [state.day] : []) : periodDays(state.period));

const average = (days, fn) => (days.length ? days.reduce((sum, d) => sum + fn(d), 0) / days.length : null);

// "Oct 22 to 28", "Sep 30 to Oct 29"
function rangeText(from, to) {
  const a = fmtDate(from, { month: "short", day: "numeric" });
  const sameMonth = dateOf(from).getUTCMonth() === dateOf(to).getUTCMonth();
  return a + " to " + (sameMonth ? dateOf(to).getUTCDate() : fmtDate(to, { month: "short", day: "numeric" }));
}

function dayName(day, long) {
  const relative = day === todayIdx ? "Today" : day === todayIdx - 1 ? "Yesterday" : "";
  const sameYear = dateOf(day).getUTCFullYear() === dateOf(todayIdx).getUTCFullYear();
  const year = sameYear ? {} : { year: "numeric" };
  const date = fmtDate(day, long ? { weekday: "long", month: "long", day: "numeric", ...year } : { weekday: "short", month: "short", day: "numeric", ...year });
  return { relative, date };
}


// Pieces of a bar, one per category, in category order. "flex" for a
// horizontal share bar, "height" for a vertical stacked bar.
function stackedParts(totals, sum, mode) {
  return CAT_KEYS.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => {
    const share = (totals.get(key) / (sum || 1)) * 100;
    const size = mode === "flex" ? "flex:" + share.toFixed(3) + " 1 0" : "height:" + share.toFixed(3) + "%";
    return '<span style="' + size + ";background:" + catColor(key) + '"></span>';
  }).join("");
}

// "Social 1h 10m" lines, largest first, for hover details
const categoryLines = (totals, min = 0) =>
  [...totals].sort((a, b) => b[1] - a[1]).filter(([, s]) => s >= min).map(([key, s]) => catName(key) + " " + fmt(s));

// ---------- the top: date or range, device switch, the three cards ----------

function renderRangeBar() {
  const label = document.getElementById("range-label");
  if (state.period === "day") {
    const long = dayName(state.day, true), short = dayName(state.day, false);
    const rel = long.relative ? '<span class="muted">' + long.relative + " · </span>" : "";
    label.innerHTML = rel + '<span class="date-long">' + esc(long.date) + '</span><span class="date-short">' + esc(short.date) + "</span>";
  } else {
    const { from, to } = periodWindow(state.period);
    label.textContent = rangeText(from, to);
  }
  const step = state.period === "day" ? 1 : Number(state.period);
  document.getElementById("prev").disabled = state.day - step < lowestDay;
  document.getElementById("next").disabled = state.day >= todayIdx;

  const el = document.getElementById("device-filter");
  el.hidden = nDev < 2;
  const options = [["all", "All devices"]].concat(DATA.devices.map((name, i) => [String(i), name]));
  el.innerHTML = options.map(([v, text]) =>
    '<button data-v="' + esc(v) + '" aria-pressed="' + (v === state.device) + '">' + esc(text) + "</button>").join("");
}

function renderCards() {
  const cards = PERIODS.map((p) => {
    let label, small = "", note = "", value, split, days;
    if (p === "day") {
      const n = dayName(state.day, false);
      label = n.relative || n.date;
      days = anyData(state.day) ? [state.day] : [];
      value = days.length ? fmt(total(state.day)) : null;
      split = devs.map((dev) => DATA.devices[dev] + " " + (hasData(state.day, dev) ? fmt(deviceTotal(state.day, dev)) : "no data"));
    } else {
      const { from, to } = periodWindow(p);
      days = periodDays(p);
      label = p + "-day average";
      small = rangeText(from, to);
      if (days.length && days.length < Number(p)) note = days.length + " of " + p + " days with data";
      const avg = average(days, total);
      value = avg === null ? null : fmt(avg);
      split = devs.map((dev) => {
        const a = average(days.filter((d) => hasData(d, dev)), (d) => deviceTotal(d, dev));
        return DATA.devices[dev] + " " + (a === null ? "no data" : fmt(a));
      });
    }
    // The category mix, as a thin bar under the number
    const cats = categoryTotals(days);
    const sum = [...cats.values()].reduce((a, b) => a + b, 0);
    // The device split only helps with more than one device; with one it
    // would repeat the big number. The bottom line is always there (empty if
    // need be) so the cards keep the same height.
    const bottom = (devs.length > 1 ? split : []).concat(note ? [note] : []).join("  ·  ");
    return '<button class="period-card" data-period="' + p + '" aria-pressed="' + (p === state.period) + '">' +
      '<span class="label"><span>' + esc(label) + "</span><small>" + esc(small) + "</small></span>" +
      '<span class="value' + (value === null ? " none" : "") + '">' + (value ?? "No data") + "</span>" +
      '<span class="share"' + (sum ? ' data-tip="' + esc(categoryLines(cats).join("\n")) + '"' : "") + ">" +
      (sum ? stackedParts(cats, sum, "flex") : "") + "</span>" +
      '<span class="split">' + esc(bottom) + "</span></button>";
  });
  document.getElementById("period-cards").innerHTML = cards.join("");
}

// The category colors used on the page, with their names (for a day, that
// includes the 6 days before it, which are in the bar chart)
function renderLegend() {
  const days = chosenDays();
  if (state.period === "day") for (let d = state.day - 6; d < state.day; d++) if (anyData(d)) days.push(d);
  const cats = categoryTotals(days);
  const keys = CAT_KEYS.filter((key) => (cats.get(key) ?? 0) > 0);
  document.getElementById("legend").innerHTML = keys.map((key) =>
    '<span><span class="swatch" style="background:' + catColor(key) + '"></span>' + esc(catName(key)) + "</span>").join("") +
    (keys.length ? '<a class="legend-link" href="/organize">Edit categories</a>' : "");
}

// ---------- timeline: the day, or an average day ----------

function renderTimeline() {
  const title = document.getElementById("timeline-title");
  const hint = document.getElementById("timeline-hint");
  const el = document.getElementById("timeline");
  const axis = '<div class="hours"><span></span><div><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>';

  if (state.period === "day") {
    title.textContent = "Through the day";
    hint.textContent = "Hover over a block for the app and time";
    const e = byDay.get(state.day);
    const start = state.day * DAY;
    const pos = (from, to) => "left:" + (((from - start) / DAY) * 100).toFixed(3) + "%;width:" + (((to - from) / DAY) * 100).toFixed(3) + "%";
    el.innerHTML = devs.map((dev) => {
      const name = DATA.devices[dev];
      const sessions = (e?.sessions ?? []).filter((s) => s[0] === dev);
      const gaps = (e?.gaps ?? []).filter((g) => g[0] === dev);
      if (!sessions.length && !gaps.length) {
        return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track no-data">No data</div></div>';
      }
      const blocks = sessions.map(([, app, from, to, active]) =>
        '<div class="block" style="' + pos(from, to) + ";background:" + catColor(catOf(app)) + '" data-tip="' +
        esc(appName(app) + " · " + catName(catOf(app)) + "\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(active)) + '"></div>');
      const gapBlocks = gaps.map(([, from, to, last]) => {
        const before = last.length ? "\nLast opened: " + last.map(([app, at]) => appName(app) + " at " + fmtClock(at)).join(", ") : "";
        return '<div class="block gap" style="' + pos(from, to) + '" data-tip="' +
          esc("Screen on, no app recorded\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(to - from) + before) + '"></div>';
      });
      return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track">' +
        blocks.join("") + gapBlocks.join("") + "</div></div>";
    }).join("") + axis;
    return;
  }

  // An average day: minutes in each hour, averaged over the days with data,
  // stacked by category
  const days = periodDays(state.period);
  const { from, to } = periodWindow(state.period);
  title.textContent = "An average day, " + rangeText(from, to);
  hint.textContent = "Minutes per hour, by category";
  const perHour = Array.from({ length: 24 }, () => new Map());
  for (const d of days) {
    for (const [, app, start, end] of items(d)) {
      const key = catOf(app);
      for (let t = start; t < end;) {
        const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
        const h = perHour[Math.floor((t % DAY) / 3600)];
        h.set(key, (h.get(key) ?? 0) + upTo - t);
        t = upTo;
      }
    }
  }
  const n = Math.max(1, days.length);
  for (const h of perHour) for (const [key, secs] of h) h.set(key, secs / n);
  const hourSum = (h) => [...h.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(60, ...perHour.map(hourSum));
  const bars = perHour.map((h, i) => {
    const sum = hourSum(h);
    const tip = [hourName(i) + ": " + fmt(sum)].concat(categoryLines(h, 30)).join("\n");
    return '<div class="hour-bar" data-tip="' + esc(tip) + '"><div class="stack" style="height:' + ((sum / max) * 100).toFixed(2) + '%">' +
      stackedParts(h, sum, "height") + "</div></div>";
  });
  el.innerHTML = days.length
    ? '<div class="avg-day"><span></span><div class="hour-bars">' + bars.join("") + "</div></div>" + axis
    : '<p class="hint">No data in this period.</p>';
}

// ---------- top apps or categories: the day, or per day on average ----------

function renderTopList() {
  const el = document.getElementById("top-apps");
  const days = chosenDays();
  const title = document.getElementById("apps-title");
  if (state.period === "day") title.textContent = "Where the time went";
  else { const { from, to } = periodWindow(state.period); title.textContent = "Per day, " + rangeText(from, to); }
  document.getElementById("view-switch").innerHTML = [["apps", "Apps"], ["categories", "Categories"]].map(([v, text]) =>
    '<button data-view="' + v + '" aria-pressed="' + (v === state.view) + '">' + text + "</button>").join("");
  if (!days.length) {
    el.innerHTML = '<p class="hint">Nothing recorded ' + (state.period === "day" ? "on this day." : "in this period.") + "</p>";
    return;
  }

  // Seconds per app (per day on average), and which devices it was on
  const apps = new Map();
  for (const d of days) {
    for (const [dev, app, start, end] of items(d)) {
      if (!apps.has(app)) apps.set(app, { secs: 0, devs: new Set() });
      const a = apps.get(app);
      a.secs += end - start;
      a.devs.add(dev);
    }
  }
  for (const a of apps.values()) a.secs /= days.length;
  const row = (name, second, secs, max, color) =>
    '<div class="app-row"><div class="app-name"><b>' + esc(name) + "</b><span>" + esc(second) + "</span></div>" +
    '<div class="bar-track"><div class="bar-fill" style="width:' + ((secs / max) * 100).toFixed(1) + "%;background:" + color + '"></div></div>' +
    '<span class="app-time">' + fmt(secs) + "</span></div>";

  if (state.view === "categories") {
    const cats = categoryTotals(days);
    // Untracked goes last; a minute or less of it isn't worth a row
    const keys = [...cats.keys()].filter((k) => k !== UNTRACKED_KEY || cats.get(k) >= 60)
      .sort((a, b) => (a === UNTRACKED_KEY) - (b === UNTRACKED_KEY) || cats.get(b) - cats.get(a));
    const shownKeys = keys.slice(0, MAX_TOP_ROWS);
    const max = Math.max(...shownKeys.map((k) => cats.get(k)));
    const moreCats = keys.length - shownKeys.length;
    el.innerHTML = shownKeys.map((key) => {
      const members = [...apps].filter(([app]) => catOf(app) === key).sort((a, b) => b[1].secs - a[1].secs).map(([app]) => appName(app));
      const second = key === UNTRACKED_KEY ? "Screen on, no app recorded"
        : members.slice(0, 3).join(", ") + (members.length > 3 ? " and " + (members.length - 3) + " more" : "");
      return row(catName(key), second, cats.get(key), max, catColor(key));
    }).join("") + '<a class="more-link" href="/apps">' +
      (moreCats > 0 ? "and " + moreCats + " more " + (moreCats === 1 ? "category" : "categories") : "All categories") + "</a>";
    return;
  }

  const rows = [...apps]
    .map(([app, a]) => ({ app, secs: a.secs, devs: a.devs }))
    .filter((r) => r.app !== UNTRACKED || r.secs >= 60)
    .sort((a, b) => b.secs - a.secs);
  const shown = rows.slice(0, MAX_TOP_ROWS);
  const max = shown[0].secs;
  el.innerHTML = shown.map((r) => {
    const where = r.app === UNTRACKED ? "Screen on, no app recorded" : [...r.devs].sort((x, y) => x - y).map((dev) => DATA.devices[dev]).join(" and ");
    return row(appName(r.app), where, r.secs, max, catColor(catOf(r.app)));
  }).join("");
  const params = new URLSearchParams({ range: state.period === "day" ? "7" : state.period, device: state.device });
  const more = rows.length - shown.length;
  el.innerHTML += '<a class="more-link" href="/apps#' + params + '">' +
    (more > 0 ? "and " + more + " more " + (more === 1 ? "app" : "apps") : "All apps") + "</a>";
}

// ---------- bars: the 7 days around the day, or the period, by category ----------

function renderBars() {
  const isDay = state.period === "day";
  const n = state.period === "30" ? 30 : 7;
  // For a day: that day and the 7 before it, so the same weekday a week
  // earlier is in view (outlined) to compare with
  const win = isDay ? { from: state.day - 7, to: state.day } : periodWindow(state.period);
  const days = [];
  for (let d = win.from; d <= win.to; d++) days.push(d);
  const avg = isDay ? null : average(periodDays(state.period), total);
  document.getElementById("bars-title").textContent = isDay
    ? (state.day === todayIdx ? "Last 8 days" : "8 days to " + fmtDate(state.day, { month: "short", day: "numeric" }))
    : (n === 30 ? "Last 30 days" : "Last 7 days") + (state.day === todayIdx ? ", not counting today" : "");
  document.getElementById("bars-hint").innerHTML = isDay ? "Click a day to see it"
    : '<span class="avg-key"></span>' + n + "-day average " + (avg === null ? "–" : "<b>" + fmt(avg) + "</b>");

  const top = Math.max(3600, ...days.map(total), avg ?? 0) * 1.08;
  const many = n === 30;
  let anyPartial = false;
  const cols = days.map((d) => {
    const has = anyData(d);
    const partial = has && !complete(d);
    if (partial) anyPartial = true;
    const t = total(d);
    const cats = categoryTotals([d]);
    const label = fmtDate(d, { weekday: "short", month: "short", day: "numeric" });
    const tip = [label + ": " + (has ? fmt(t) : "no data")]
      .concat(partial ? ["Missing data from a device"] : [], categoryLines(cats, 60).slice(0, 5), ["Click to see this day"]).join("\n");
    // For a day, the other days are faded; for a period, all are in full color
    const cls = "stack" + (isDay && d !== state.day ? " faded" : "") + (partial ? " partial" : "");
    return '<button class="bar-col" data-day="' + d + '" data-tip="' + esc(tip) + '" aria-label="' + esc(label + ": " + (has ? fmt(t) : "no data")) + '">' +
      (has ? '<span class="' + cls + '" style="height:' + ((t / top) * 100).toFixed(1) + '%">' + stackedParts(cats, t, "height") + "</span>"
        : '<span class="stack none"></span>') + "</button>";
  });
  const labels = days.map((d, i) => {
    const on = isDay && d === state.day;
    let text = d === todayIdx ? "Today" : fmtDate(d, { weekday: "short" });
    if (isDay && d === state.day - 7) text = "Last " + text;
    if (many) text = (days.length - 1 - i) % 7 === 0 ? fmtDate(d, { month: "short", day: "numeric" }) : "";
    return '<div><span class="label' + (on ? " on" : "") + '">' + esc(text) + "</span>" +
      (many ? "" : '<span class="time">' + (anyData(d) ? fmt(total(d)) : "–") + "</span>") + "</div>";
  });
  document.getElementById("bars").innerHTML =
    '<div class="bar-plot' + (many ? " many" : "") + '">' +
    (avg === null ? "" : '<div class="avg-line" style="bottom:' + ((avg / top) * 100).toFixed(1) + '%"></div>') +
    cols.join("") + "</div>" +
    '<div class="bar-labels' + (many ? " many" : "") + '">' + labels.join("") + "</div>" +
    (anyPartial ? '<p class="hint">Dashed outline: missing data from a device.</p>' : "");
}

// ---------- week by week: a line through each week's daily average ----------

// One dot per week, Monday to Sunday, this week last: the week's daily
// average over the days with data. The gray band behind each dot runs from
// the week's lightest day to its heaviest, so you can see how steady it was.
// This week's dot is hollow and leaves today out while it's going. The
// dashed line is the average over all six weeks. The chart never changes
// with the cards; the week holding the day you're looking at is outlined.
function renderWeeks() {
  const thisMonday = mondayOf(todayIdx);
  const weeks = [];
  for (let w = 0; w < WEEKS_SHOWN; w++) {
    const from = weeksStart + w * 7;
    const to = Math.min(from + 6, todayIdx - 1);
    const days = [];
    for (let d = from; d <= to; d++) if (anyData(d)) days.push(d);
    // On a Monday no full day of this week has passed, so show today so far
    if (!days.length && from === thisMonday && anyData(todayIdx)) days.push(todayIdx);
    const totals = days.map(total);
    weeks.push({
      from, days, current: from === thisMonday, avg: average(days, total),
      low: days.length ? days[totals.indexOf(Math.min(...totals))] : null,
      high: days.length ? days[totals.indexOf(Math.max(...totals))] : null,
      cats: categoryTotals(days),
    });
  }
  const overall = average(weeks.flatMap((w) => w.days), total);
  const chosen = mondayOf(state.day);
  document.getElementById("weeks-switch").innerHTML = [["total", "Total"], ["categories", "Categories"]].map(([v, text]) =>
    '<button data-weeks="' + v + '" aria-pressed="' + (v === state.weeks) + '">' + text + "</button>").join("");
  document.getElementById("weeks-avg").innerHTML = state.weeks === "total" && overall !== null
    ? '<span class="avg-key"></span>6-week average <b>' + fmt(overall) + "</b>" : "";
  if (state.weeks === "categories") return renderWeekCategories(weeks);

  const short = (d) => fmtDate(d, { month: "short", day: "numeric" });
  const dayText = (d) => fmtDate(d, { weekday: "short" }) + " " + fmt(total(d));
  document.getElementById("weeks").innerHTML = weekLineHtml(weeks.map((w) => {
    const range = w.current ? short(w.from) + " to today" : rangeText(w.from, w.from + 6);
    // Clicking shows the week as a 7-day period: it ends on the Sunday, or
    // for this week on today (which shows the 7 full days before it)
    const end = w.current ? todayIdx : w.from + 6;
    return {
      label: w.current ? "This week" : short(w.from),
      value: w.avg,
      low: w.low === null ? null : total(w.low),
      high: w.high === null ? null : total(w.high),
      current: w.current,
      chosen: w.from === chosen,
      attrs: 'data-week-end="' + end + '" aria-label="' + esc(range + ": " + (w.avg === null ? "no data" : fmt(w.avg) + " a day")) + '"',
      tip: [range + (w.current ? " (so far)" : "") + ": " + (w.avg === null ? "no data" : fmt(w.avg) + " a day")]
        .concat(w.avg === null ? [] : ["Lightest: " + dayText(w.low), "Heaviest: " + dayText(w.high)])
        .concat(categoryLines(w.cats, 60).slice(0, 3))
        .concat([w.current ? "Click to see the last 7 days" : "Click to see this week"]).join("\n"),
    };
  }), { format: fmt, average: overall, floor: 3600 });
}

// Week by week, by category: each category's last 6 weeks as a small line,
// its daily average this week, and this week against its 6-week average.
// Every category with time in the 6 weeks, biggest first; Untracked isn't a
// category, so it's left out.
function renderWeekCategories(weeks) {
  const current = weeks[weeks.length - 1];
  // On a Monday "this week" is only today so far, which isn't a full day to
  // compare with an average, so until this week has a full day the columns
  // show last week instead
  const useLast = !current.days.length || current.days[0] === todayIdx;
  const compared = useLast ? weeks[weeks.length - 2] : current;
  const full = useLast ? weeks.slice(0, -1) : weeks; // the average leaves out a partial Monday
  const all = categoryTotals(full.flatMap((w) => w.days));
  const now = categoryTotals(compared.days);
  const keys = CAT_KEYS.filter((k) => k !== UNTRACKED_KEY && (all.get(k) ?? 0) > 0).sort((a, b) => all.get(b) - all.get(a));
  const shown = keys;
  const perWeek = weeks.map((w) => categoryTotals(w.days));
  const rows = shown.map((key) => {
    const vals = perWeek.map((m, i) => (weeks[i].days.length ? m.get(key) ?? 0 : null));
    const max = Math.max(...vals.filter((v) => v !== null), 1);
    const x = (i) => ((i / (vals.length - 1)) * 100).toFixed(1);
    const y = (v) => (22 - (v / max) * 18).toFixed(1);
    const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null);
    const done = pts.filter(([i]) => !weeks[i].current);
    const last = pts.find(([i]) => weeks[i].current);
    const prev = done[done.length - 1];
    const color = catColor(key);
    const svg = '<svg class="cat-trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + done.map(([i, v]) => x(i) + "," + y(v)).join(" ") + '" style="stroke:' + color + '"></polyline>' +
      (last && prev ? '<polyline class="so-far" points="' + x(prev[0]) + "," + y(prev[1]) + " " + x(last[0]) + "," + y(last[1]) + '" style="stroke:' + color + '"></polyline>' : "") +
      "</svg>";
    const avg = all.get(key) ?? 0, thisWeek = compared.days.length ? now.get(key) ?? 0 : null;
    let vs = "–";
    if (thisWeek !== null && avg >= 60) {
      const pct = Math.round(((thisWeek - avg) / avg) * 100);
      vs = pct === 0 ? "0%" : (pct > 0 ? "+" : "−") + Math.abs(pct) + "%";
    }
    const tip = catName(key) + "\n" + (useLast ? "Last week" : "This week") + ": " + (thisWeek === null ? "no data" : fmt(thisWeek) + " a day") +
      "\n6-week average: " + fmt(avg) + " a day" + (useLast ? "\nThis week is compared once it has a full day" : "") + "\nClick to open it";
    return '<a class="cat-week" href="/apps#show=cat:' + encodeURIComponent(String(key)) + '" data-tip="' + esc(tip) + '">' +
      '<span class="cat-week-name"><span class="swatch" style="background:' + color + '"></span>' + esc(catName(key)) + "</span>" +
      svg + '<span class="num">' + (thisWeek === null ? "–" : fmt(thisWeek)) + '</span><span class="num vs">' + vs + "</span></a>";
  });
  document.getElementById("weeks").innerHTML = '<div class="cat-weeks">' +
    '<div class="cat-week head"><span>Category</span><span>Last 6 weeks</span><span class="num">' + (useLast ? "Last week" : "This week") +
    '</span><span class="num">vs avg</span></div>' +
    rows.join("") + "</div>";
}


// ---------- the hours of the week (grays) ----------

// Weekday by hour: the average time in each hour. For a day, over the last
// 6 weeks (today left out while it's going); for 7 or 30 days, over the period.
// The days the hours of the week and your weekdays are averaged over: for
// a day, the last 6 weeks (today left out while it's going); for 7 or 30
// days, the period
function weekdayDays() {
  const days = [];
  if (state.period === "day") {
    for (let d = Math.max(weeksStart, firstDay); d < todayIdx; d++) if (anyData(d)) days.push(d);
  } else {
    days.push(...periodDays(state.period));
  }
  const win = periodWindow(state.period);
  return { days, label: state.period === "day" ? "Last 6 weeks" : rangeText(win.from, win.to) };
}

function renderHours() {
  const isDay = state.period === "day";
  const { days, label } = weekdayDays();
  document.getElementById("hours-hint").textContent = label;
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = new Array(7).fill(0);
  for (const d of days) {
    const w = weekdayOf(d);
    counts[w]++;
    for (const [, , start, end] of items(d)) addToHours(sums, w, start, end);
  }
  document.getElementById("hours-heatmap").innerHTML =
    weekdayHourHtml(sums, counts, { chosen: isDay ? weekdayOf(state.day) : -1 });
}

// ---------- your weekdays: the average day for each weekday ----------

function renderWeekdays() {
  const { days, label } = weekdayDays();
  document.getElementById("weekdays-hint").textContent = label;
  const byWeekday = Array.from({ length: 7 }, () => []);
  for (const d of days) byWeekday[weekdayOf(d)].push(d);
  const avgDays = byWeekday.map((ds) => {
    if (!ds.length) return null;
    const cats = categoryTotals(ds); // already divided by the number of days
    const parts = CAT_KEYS.filter((k) => (cats.get(k) ?? 0) > 0).map((k) => [catColor(k), cats.get(k), catName(k)]);
    return { total: parts.reduce((a, p) => a + p[1], 0), parts };
  });
  document.getElementById("weekdays").innerHTML =
    weekdayBarsHtml(avgDays, { chosen: state.period === "day" ? weekdayOf(state.day) : -1, hint: label.toLowerCase() });
}

// ---------- running total: the day added up, against the same weekday ----------

// For a day: its time added up through the day, next to the same weekday a
// week before and the average for that weekday over the 6 weeks before.
// For 7 or 30 days: the period's average day added up, next to the period
// before's. The card is always there, so the page keeps one layout.
function renderRunning() {
  const spans = (d) => items(d).map(([, , s, e]) => [s, e]);
  const line = (d) => runningTotal(stepTotals(spans(d), d));
  const averageLine = (days) => {
    if (!days.length) return null;
    const lines = days.map(line);
    return lines[0].map((_, i) => lines.reduce((a, l) => a + l[i], 0) / lines.length);
  };
  if (state.period !== "day") {
    const win = periodWindow(state.period);
    const n = Number(state.period);
    const days = periodDays(state.period);
    const before = [];
    for (let d = win.from - n; d < win.from; d++) if (anyData(d)) before.push(d);
    document.getElementById("run-title").textContent = "An average day, added up";
    document.getElementById("run-hint").textContent = "Against the " + n + " days before";
    const main = averageLine(days);
    document.getElementById("run").innerHTML = main
      ? runningTotalHtml({ main, last: averageLine(before), avg: null },
        { main: rangeText(win.from, win.to), last: rangeText(win.from - n, win.from - 1), avg: "" })
      : '<p class="hint">No data in this period.</p>';
    return;
  }
  const w = weekdayOf(state.day);
  const isToday = state.day === todayIdx;
  const lastDay = state.day - 7;
  const before = [];
  for (let k = 1; k <= 6; k++) if (anyData(state.day - 7 * k)) before.push(line(state.day - 7 * k));
  const avg = before.length ? before[0].map((_, i) => before.reduce((a, l) => a + l[i], 0) / before.length) : null;
  const nowStep = isToday ? ((localNow() % DAY) / DAY) * STEPS : null;
  document.getElementById("run-title").textContent = isToday ? "So far today" : "Through the day, added up";
  document.getElementById("run-hint").textContent = isToday ? "By " + fmtClock(localNow()) : "The whole day";
  document.getElementById("run").innerHTML = runningTotalHtml(
    { main: line(state.day), last: anyData(lastDay) ? line(lastDay) : null, avg },
    {
      main: isToday ? "Today" : fmtDate(state.day, { weekday: "short", month: "short", day: "numeric" }),
      last: isToday ? "Last " + WEEKDAYS[w] : fmtDate(lastDay, { weekday: "short", month: "short", day: "numeric" }),
      avg: "Average " + WEEKDAYS[w] + " (" + before.length + (before.length === 1 ? " week" : " weeks") + ")",
    },
    nowStep);
}

// ---------- clicks ----------

function update(changes) {
  Object.assign(state, changes);
  state.day = clampDay(state.day);
  hideTip();
  render();
}

document.getElementById("prev").addEventListener("click", () =>
  update({ day: state.day - (state.period === "day" ? 1 : Number(state.period)) }));
document.getElementById("next").addEventListener("click", () =>
  update({ day: state.day + (state.period === "day" ? 1 : Number(state.period)) }));

document.getElementById("period-cards").addEventListener("click", (e) => {
  const card = e.target.closest("[data-period]");
  if (card) update({ period: card.dataset.period });
});

document.getElementById("weeks-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-weeks]");
  if (b) update({ weeks: b.dataset.weeks });
});

document.getElementById("view-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) update({ view: b.dataset.view });
});

// Clicking a day in the bars shows that day
document.getElementById("bars").addEventListener("click", (e) => {
  const target = e.target.closest("[data-day]");
  if (target) update({ day: Number(target.dataset.day), period: "day" });
});

// Clicking a week shows it as a 7-day period
document.getElementById("weeks").addEventListener("click", (e) => {
  const target = e.target.closest("[data-week-end]");
  if (target) update({ day: Number(target.dataset.weekEnd), period: "7" });
});

document.getElementById("device-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || b.dataset.v === state.device) return;
  state.device = b.dataset.v;
  setDevices();
  update({});
});

function render() {
  writeAddress();
  renderRangeBar();
  renderCards();
  renderLegend();
  renderTimeline();
  renderTopList();
  renderRunning();
  renderBars();
  renderWeeks();
  renderHours();
  renderWeekdays();
}

setDevices();
render();
