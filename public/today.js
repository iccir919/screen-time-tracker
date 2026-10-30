// public/today.js
//
// The Today page. Three cards at the top: the day, the 7-day average and
// the 30-day average. Pick one and the whole page follows it: the timeline
// (the day, or an average day by hour), the top apps or categories (that
// day, or per day on average), the bar chart (7 or 30 days, with the
// average drawn in), the 6-week calendar and the hours of the week.
// Everything also follows the device switch.
//
// Color means category everywhere (the colors you pick on Organize);
// amounts with no category, like the calendar, are in grays.
//
// Loads /api/usage from the local server (server.mjs); shared helpers are
// in common.js. The address keeps what you picked:
// #day=2026-10-26&period=7&device=0&view=categories (no day means today, no
// period means the day, no device means all, no view means apps).

import { setupRefresh, showLastArchived } from "./refresh.js";
import {
  DAY, WEEKDAYS, loadUsage, esc, fmt, dateOf, fmtDate, weekdayOf, isoDay, dayFromIso, fmtClock,
  todayIdx, hideTip, UNTRACKED_KEY, categoryKeys, categoryColor, categoryName,
} from "./common.js";

const SESSION_GAP = 60;          // uses of the same app less than this apart count as one open
const MAX_TOP_ROWS = 8;
const CALENDAR_WEEKS = 6;
const UNTRACKED = -1;            // stands in for an app index for untracked time
const PERIODS = ["day", "7", "30"];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0]; // weekday numbers in Monday-first order

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

// The calendar's first day: a Monday, 5 weeks before this week's Monday.
// You can go back to it or to your first day of data, whichever is earlier.
const calendarStart = todayIdx - (weekdayOf(todayIdx) + 6) % 7 - (CALENDAR_WEEKS - 1) * 7;
const lowestDay = Math.min(firstDay, calendarStart);
const clampDay = (d) => Math.max(lowestDay, Math.min(todayIdx, d));

// ---------- what you picked ----------

const state = { day: todayIdx, period: "day", device: "all", view: "apps" };
{
  const hash = decodeURIComponent(location.hash.slice(1));
  const params = new URLSearchParams(hash);
  const d = dayFromIso(hash) ?? dayFromIso(params.get("day") ?? "");
  if (d !== null) state.day = clampDay(d);
  if (PERIODS.includes(params.get("period"))) state.period = params.get("period");
  const device = params.get("device");
  if (device !== null && DATA.devices[Number(device)] !== undefined) state.device = device;
  if (params.get("view") === "categories") state.view = "categories";
}

let devs = []; // the chosen devices, as indexes
let heatStepsCache = null;

function setDevices() {
  devs = state.device === "all" ? DATA.devices.map((_, i) => i) : [Number(state.device)];
  heatStepsCache = null;
}

function writeAddress() {
  const params = new URLSearchParams();
  if (state.day !== todayIdx) params.set("day", isoDay(state.day));
  if (state.period !== "day") params.set("period", state.period);
  if (state.device !== "all") params.set("device", state.device);
  if (state.view !== "apps") params.set("view", state.view);
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

const hourName = (h) => (h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : h - 12 + " PM");

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
    const max = Math.max(...keys.map((k) => cats.get(k)));
    el.innerHTML = keys.map((key) => {
      const members = [...apps].filter(([app]) => catOf(app) === key).sort((a, b) => b[1].secs - a[1].secs).map(([app]) => appName(app));
      const second = key === UNTRACKED_KEY ? "Screen on, no app recorded"
        : members.slice(0, 3).join(", ") + (members.length > 3 ? " and " + (members.length - 3) + " more" : "");
      return row(catName(key), second, cats.get(key), max, catColor(key));
    }).join("") + '<a class="more-link" href="/organize">Edit categories</a>';
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
  const win = isDay ? { from: state.day - 6, to: state.day } : periodWindow(state.period);
  const days = [];
  for (let d = win.from; d <= win.to; d++) days.push(d);
  const avg = isDay ? null : average(periodDays(state.period), total);
  document.getElementById("bars-title").textContent = isDay
    ? (state.day === todayIdx ? "Last 7 days" : "7 days to " + fmtDate(state.day, { month: "short", day: "numeric" }))
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

// ---------- the 6-week calendar and the hours of the week (grays) ----------

// Shades come from your own values, so they show your lighter and heavier
// days (or hours) whatever your usual amount is: each shade is about a fifth
// of the values. With too few values, the fallback steps are used.
function quintileSteps(values, round, fallback) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 10) return fallback;
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  const steps = [0.2, 0.4, 0.6, 0.8].map((share) => Math.max(round, Math.round(at(share) / round) * round));
  for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1]) steps[i] = steps[i - 1] + round;
  return steps;
}

function heatLevel(secs, steps) {
  const step = steps.findIndex((limit) => secs < limit);
  return step === -1 ? 5 : step + 1;
}

function legendKeys(steps) {
  return [1, 2, 3, 4, 5].map((n, i) =>
    '<span class="cal-key" style="background:var(--heat-' + n + ')" data-tip="' +
    (i === 0 ? "Under " + fmt(steps[0]) : i === 4 ? fmt(steps[3]) + " or more" : fmt(steps[i - 1]) + " to " + fmt(steps[i])) +
    '"></span>').join("");
}

function dayHeatSteps() {
  if (!heatStepsCache) {
    heatStepsCache = quintileSteps([...byDay.keys()].filter(anyData).map(total), 1800, [2, 4, 6, 8].map((h) => h * 3600));
  }
  return heatStepsCache;
}

function renderCalendar() {
  const steps = dayHeatSteps();
  const isDay = state.period === "day";
  const win = periodWindow(state.period);
  document.getElementById("calendar-hint").textContent = isDay ? "Click a day to see it" : "The period is in full color";
  const cols = [];
  const months = [];
  for (let w = 0; w < CALENDAR_WEEKS; w++) {
    const colStart = calendarStart + w * 7;
    const month = fmtDate(colStart, { month: "short" });
    months.push(w === 0 || month !== fmtDate(colStart - 7, { month: "short" }) ? month : "");
    let cells = "";
    for (let i = 0; i < 7; i++) {
      const d = colStart + i;
      if (d > todayIdx) {
        cells += '<span class="cal-day future" aria-hidden="true"></span>';
        continue;
      }
      const label = fmtDate(d, { weekday: "short", month: "short", day: "numeric" });
      const extra = (isDay && d === state.day ? " chosen" : "") + (!isDay && (d < win.from || d > win.to) ? " faded" : "");
      if (!anyData(d)) {
        cells += '<button class="cal-day empty' + extra + '" data-day="' + d + '" data-tip="' + esc(label + "\nNo data") +
          '" aria-label="' + esc(label + ": no data") + '"></button>';
      } else {
        const text = label + "\n" + fmt(total(d)) + (complete(d) ? "" : "\nMissing data from a device");
        cells += '<button class="cal-day' + extra + '" data-day="' + d + '" style="background:var(--heat-' + heatLevel(total(d), steps) +
          ')" data-tip="' + esc(text) + '" aria-label="' + esc(text.replace(/\n/g, ", ")) + '"></button>';
      }
    }
    cols.push('<div class="cal-week">' + cells + "</div>");
  }
  document.getElementById("calendar").innerHTML =
    '<div class="calendar">' +
    '<div class="cal-weekdays"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div>' +
    '<div class="cal-weeks">' + cols.join("") + "</div>" +
    "<span></span>" +
    '<div class="cal-months">' + months.map((m) => "<span>" + esc(m) + "</span>").join("") + "</div>" +
    "</div>" +
    '<div class="cal-legend"><span><span class="cal-key empty"></span>No data</span><span>less ' + legendKeys(steps) + " more</span></div>";
}

// Weekday by hour: the average time in each hour. For a day, over the last
// 6 weeks (today left out while it's going); for 7 or 30 days, over the period.
function renderHours() {
  const isDay = state.period === "day";
  const days = [];
  if (isDay) {
    for (let d = Math.max(calendarStart, firstDay); d < todayIdx; d++) if (anyData(d)) days.push(d);
  } else {
    days.push(...periodDays(state.period));
  }
  const win = periodWindow(state.period);
  document.getElementById("hours-hint").textContent = isDay ? "Last 6 weeks" : rangeText(win.from, win.to);
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts = new Array(7).fill(0);
  for (const d of days) {
    const w = weekdayOf(d);
    counts[w]++;
    for (const [, , start, end] of items(d)) {
      for (let t = start; t < end;) {
        const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
        sums[w][Math.floor((t % DAY) / 3600)] += upTo - t;
        t = upTo;
      }
    }
  }
  const avg = sums.map((row, w) => row.map((s) => (counts[w] ? s / counts[w] : 0)));
  const steps = quintileSteps(avg.flat(), 60, [5, 15, 30, 45].map((m) => m * 60));
  const chosen = isDay ? weekdayOf(state.day) : -1;
  const rows = MON_FIRST.map((w) => {
    const cells = avg[w].map((s, h) => {
      const text = WEEKDAYS[w] + "s, " + hourName(h) + ": " + (counts[w] ? fmt(s) + " on average" : "no data");
      const shade = !counts[w] ? "" : s < 30 ? "background:var(--lane)" : "background:var(--heat-" + heatLevel(s, steps) + ")";
      return '<span class="hour-cell' + (counts[w] ? " has" : "") + '" style="' + shade + '" data-tip="' + esc(text) + '"></span>';
    }).join("");
    return '<span class="hour-day' + (w === chosen ? " chosen" : "") + '">' + WEEKDAYS[w].slice(0, 3) + "</span>" +
      '<div class="hour-row">' + cells + "</div>";
  }).join("");
  document.getElementById("hours-heatmap").innerHTML =
    '<div class="hour-grid">' + rows +
    '<span></span><div class="hour-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>' +
    '<div class="cal-legend"><span>Average per hour</span><span>less ' + legendKeys(steps) + " more</span></div>";
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

document.getElementById("view-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) update({ view: b.dataset.view });
});

// Clicking a day in the bars or the calendar shows that day
for (const id of ["bars", "calendar"]) {
  document.getElementById(id).addEventListener("click", (e) => {
    const target = e.target.closest("[data-day]");
    if (target) update({ day: Number(target.dataset.day), period: "day" });
  });
}

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
  renderBars();
  renderCalendar();
  renderHours();
}

setDevices();
render();
