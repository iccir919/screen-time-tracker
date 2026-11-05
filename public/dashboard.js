// public/dashboard.js
//
// The Today and Trends pages. Both load this script; the page says which it
// is (<body data-page="today"> or "trends"), and each part below is drawn
// only if the page has a place for it.
//
// Today is about one day; the arrows move a day at a time and everything
// follows: the timeline by device, so far today (added up through the day,
// against last week's same weekday and its 6-week average), the last 8
// days, and where the time went by category (with its top apps), each with
// when it happened by hour. The 30-day card opens Trends.
//
// Trends is about the last 30 days, ending on a day you can move (the
// arrows move 30 days): day by day, an average day added up, and Patterns
// (by hour, by weekday, or the last 6 weeks). The category buttons at the
// top spotlight categories in every chart, cards included. Clicking a day
// opens it in Today.
//
// On Today you can follow one category or one app: pick it in "Where the
// time went" or the legend and every chart shows just that, with the rest
// in gray where it helps to see the whole day. The bar at the top says
// what's picked, opens it on the Apps page, and clears it.
//
// Color means category everywhere (the colors you pick on Organize).
//
// Loads /api/usage from the local server (server.mjs); shared helpers and
// charts are in common.js. The address keeps what you picked, for example
// /#day=2026-10-26&device=0&focus=cat:2 or /trends#pattern=weekdays&only=2,5

import { setupRefresh, showLastArchived } from "./refresh.js";
import {
  DAY, WEEKDAYS, loadUsage, esc, fmt, dateOf, fmtDate, weekdayOf, isoDay, dayFromIso, fmtClock,
  todayIdx, hideTip, UNTRACKED_KEY, categoryKeys, categoryColor, categoryName,
  hourName, localNow, STEPS, stepTotals, runningTotal, runningTotalHtml,
  heatShade,
} from "./common.js";

const PAGE = document.body.dataset.page === "trends" ? "trends" : "today";
const SESSION_GAP = 60;          // uses of the same app less than this apart count as one open
const MAX_TOP_ROWS = 8;
const WEEKS_SHOWN = 6;
const UNTRACKED = -1;            // stands in for an app index for untracked time
const PERIODS = ["7", "30"];     // the average cards on Today; Trends is always 30 days

setupRefresh(); // what you picked is in the address, so a reload keeps it

const DATA = await loadUsage();
if (!DATA) throw new Error("Data didn't load (the message is on the page).");
showLastArchived(DATA.lastArchived);

const nDev = DATA.devices.length;
const appName = (app) => (app === UNTRACKED ? "Untracked" : DATA.apps[app].name);
const appKey = (app) => (app === UNTRACKED ? "untracked" : DATA.apps[app].id);
// The category key for an app index: its category, -1 for Other, or Untracked
const catOf = (app) => (app === UNTRACKED ? UNTRACKED_KEY : DATA.apps[app].cat);
const catColor = (key) => categoryColor(DATA, key);
// Untracked's stripes can't be shaded, so its shades use Other's gray
const solidColor = (key) => (key === UNTRACKED_KEY ? "var(--cat-other)" : catColor(key));
const catName = (key) => categoryName(DATA, key);
const CAT_KEYS = categoryKeys(DATA);
const el = (id) => document.getElementById(id);
const shown = (id) => Boolean(el(id)); // whether this page has that part

// ---------- links between the pages ----------

const deviceParam = () => (state.device === "all" ? "" : "&device=" + state.device) +
  (state.focus ? "&focus=" + encodeURIComponent(focusText()) : "");
const todayLink = (day) => "/#day=" + isoDay(day) + deviceParam();
const trendsLink = (day = state.day) => {
  const text = ((day === todayIdx ? "" : "day=" + isoDay(day)) + deviceParam()).replace(/^&/, "");
  return "/trends" + (text ? "#" + text : "");
};
const appLink = (app) => "/apps#show=app:" + encodeURIComponent(appKey(app));
const categoryLink = (key) => "/apps#show=cat:" + encodeURIComponent(String(key));

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
const mondayOf = (day) => day - (weekdayOf(day) + 6) % 7;
// You can go back to your first day of data, or at least 6 weeks
const lowestDay = Math.min(firstDay, mondayOf(todayIdx) - (WEEKS_SHOWN - 1) * 7);
const clampDay = (d) => Math.max(lowestDay, Math.min(todayIdx, d));

// ---------- following one category or app ----------

// "cat:2" or "app:com.google.ios.youtube" in the address
function focusText() {
  const f = state.focus;
  return f.app === undefined ? "cat:" + String(f.cat) : "app:" + appKey(f.app);
}
function focusFromText(text) {
  if (text.startsWith("cat:")) {
    const key = CAT_KEYS.find((k) => String(k) === text.slice(4));
    return key === undefined ? null : { cat: key };
  }
  if (text.startsWith("app:")) {
    const id = text.slice(4);
    if (id === "untracked") return { cat: UNTRACKED_KEY };
    const app = DATA.apps.findIndex((a) => a.id === id);
    return app === -1 ? null : { cat: catOf(app), app };
  }
  return null;
}
// Whether an app (or UNTRACKED) is part of what's followed
const matches = (app) => !state.focus ||
  (state.focus.app !== undefined ? app === state.focus.app : catOf(app) === state.focus.cat);
const focusName = () => (state.focus.app !== undefined ? appName(state.focus.app) : catName(state.focus.cat));
// Untracked's own gray is too close to the rest's, so it's drawn darker
const focusColor = () => (state.focus.cat === UNTRACKED_KEY ? "var(--heat-4)" : solidColor(state.focus.cat));
const REST = "#DCDCE0"; // the rest of the time, behind what's followed

// ---------- what you picked ----------

// period: "day" on Today; "7" or "30" on Trends. focus: what's being
// followed, null for everything, { cat } for a category, { cat, app } for an app.
const state = { day: todayIdx, period: PAGE === "today" ? "day" : "30", device: "all", pattern: "hours", focus: null, only: new Set() };
{
  const hash = decodeURIComponent(location.hash.slice(1));
  const params = new URLSearchParams(hash);
  const d = dayFromIso(hash) ?? dayFromIso(params.get("day") ?? "");
  if (d !== null) state.day = clampDay(d);
  const device = params.get("device");
  if (device !== null && DATA.devices[Number(device)] !== undefined) state.device = device;
  if (["weekdays", "weeks"].includes(params.get("pattern"))) state.pattern = params.get("pattern");
  // The spotlighted categories on Trends, like only=2,5 (none: everything)
  for (const text of (params.get("only") ?? "").split(",")) {
    const key = CAT_KEYS.find((k) => String(k) === text);
    if (key !== undefined) state.only.add(key);
  }
  state.focus = focusFromText(params.get("focus") ?? "");
  // Trends has no following; a category followed elsewhere (Today, the
  // Apps page) arrives spotlighted
  if (PAGE === "trends" && state.focus) {
    state.only = new Set([state.focus.cat]);
    state.focus = null;
  }
}

let devs = []; // the chosen devices, as indexes

function setDevices() {
  devs = state.device === "all" ? DATA.devices.map((_, i) => i) : [Number(state.device)];
}

function writeAddress() {
  const params = new URLSearchParams();
  if (state.day !== todayIdx) params.set("day", isoDay(state.day));
  if (state.device !== "all") params.set("device", state.device);
  if (PAGE === "trends" && state.pattern !== "hours") params.set("pattern", state.pattern);
  if (state.only.size) params.set("only", [...state.only].join(","));
  if (state.focus) params.set("focus", focusText());
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
// A day's time in what's followed (everything, with nothing followed)
// Whether a category shows: it's spotlighted, or nothing is (Trends)
const shownCat = (key) => !state.only.size || state.only.has(key);
// Whether an app's time counts: it's part of what's followed (Today) and its
// category shows (Trends)
const counted = (app) => matches(app) && shownCat(catOf(app));
// Seconds per category, only the ones that show
const shownCats = (totals) => { for (const k of [...totals.keys()]) if (!shownCat(k)) totals.delete(k); return totals; };
const devicePick = (day, dev) => (state.only.size
  ? items(day).reduce((a, [d, app, s, e]) => a + (d === dev && counted(app) ? e - s : 0), 0) : deviceTotal(day, dev));
const pickTotal = (day) => (state.focus || state.only.size ? items(day).reduce((a, [, app, s, e]) => a + (counted(app) ? e - s : 0), 0) : total(day));

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

// The days this page is about, that have data
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
const shortDate = (d) => fmtDate(d, { weekday: "short", month: "short", day: "numeric" });

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

// A shade of a category's color for a cell that's this share (0 to 1) of
// the busiest cell: the same rule as every grid (heatShade in common.js)
const shade = (key, share) => (share < 0.01 ? "var(--track)" : heatShade(share, solidColor(key)));

// A bar's two pieces with something followed: it at the bottom, the rest in gray
function pickParts(pick, sum) {
  const pct = (v) => ((v / (sum || 1)) * 100).toFixed(3);
  return '<span style="height:' + pct(pick) + "%;background:" + focusColor() + '"></span>' +
    '<span style="height:' + pct(sum - pick) + "%;background:" + REST + '"></span>';
}

// ---------- the top: date or range, switches, the three cards ----------

function renderRangeBar() {
  const label = el("range-label");
  if (state.period === "day") {
    const long = dayName(state.day, true), short = dayName(state.day, false);
    const rel = long.relative ? '<span class="muted">' + long.relative + " · </span>" : "";
    label.innerHTML = rel + '<span class="date-long">' + esc(long.date) + '</span><span class="date-short">' + esc(short.date) + "</span>";
  } else {
    const { from, to } = periodWindow(state.period);
    label.textContent = rangeText(from, to);
  }
  const step = state.period === "day" ? 1 : Number(state.period);
  el("prev").disabled = state.day - step < lowestDay;
  el("next").disabled = state.day >= todayIdx;

  const dev = el("device-filter");
  dev.hidden = nDev < 2;
  const options = [["all", "All devices"]].concat(DATA.devices.map((name, i) => [String(i), name]));
  dev.innerHTML = options.map(([v, text]) =>
    '<button data-v="' + esc(v) + '" aria-pressed="' + (v === state.device) + '">' + esc(text) + "</button>").join("");
}

// One card: a label (and a small note on the right), a big value, a bar
// of its categories, and a bottom line
function card({ tag = "div", href = "", pressed = false, label, small = "", value, cats = null, bottom = "" }) {
  const sum = cats ? [...cats.values()].reduce((a, b) => a + b, 0) : 0;
  return "<" + tag + ' class="period-card' + (pressed ? " chosen" : "") + (href ? " link" : "") + '"' + (href ? ' href="' + href + '"' : "") + ">" +
    '<span class="label"><span>' + esc(label) + "</span><small>" + esc(small) + "</small></span>" +
    '<span class="value' + (value === null ? " none" : "") + '">' + (value ?? "No data") + "</span>" +
    '<span class="share"' + (sum ? ' data-tip="' + esc(categoryLines(cats).join("\n")) + '"' : "") + ">" +
    (sum ? stackedParts(cats, sum, "flex") : "") + "</span>" +
    '<span class="split">' + esc(bottom) + "</span></" + tag + ">";
}

// A period's average, its category mix and its devices
function periodSummary(p, end = state.day) {
  const days = periodDays(p, end);
  const avg = average(days, pickTotal);
  const split = devs.map((dev) => {
    const a = average(days.filter((d) => hasData(d, dev)), (d) => devicePick(d, dev));
    return DATA.devices[dev] + " " + (a === null ? "no data" : fmt(a));
  });
  return { days, avg, cats: shownCats(categoryTotals(days)), split };
}

function renderCards() {
  // The device split only helps with more than one device; with one it
  // would repeat the big number. The bottom line is always there (empty if
  // need be) so the cards keep the same height.
  const bottomOf = (split, note = "") => (devs.length > 1 ? split : []).concat(note ? [note] : []).join("  ·  ");
  const cards = [];
  if (PAGE === "today") {
    const n = dayName(state.day, false);
    const days = anyData(state.day) ? [state.day] : [];
    cards.push(card({
      pressed: true, label: n.relative || n.date, value: days.length ? fmt(total(state.day)) : null, cats: categoryTotals(days),
      bottom: bottomOf(devs.map((dev) => DATA.devices[dev] + " " + (hasData(state.day, dev) ? fmt(deviceTotal(state.day, dev)) : "no data"))),
    }));
    // The averages; the 30-day one opens Trends, which is about those 30 days
    for (const p of PERIODS) {
      const { from, to } = periodWindow(p);
      const s = periodSummary(p);
      const link = p === "30";
      cards.push(card({
        tag: link ? "a" : "div", href: link ? trendsLink() : "", label: p + "-day average", small: rangeText(from, to),
        value: s.avg === null ? null : fmt(s.avg), cats: s.cats, bottom: bottomOf(s.split, link ? "See in Trends ›" : ""),
      }));
    }
  } else {
    const p = state.period, n = Number(p);
    const { from, to } = periodWindow(p);
    const s = periodSummary(p);
    const note = s.days.length && s.days.length < n ? s.days.length + " of " + p + " days with data" : "";
    // With a spotlight the cards count only those categories, and say so
    const which = state.only.size ? [...state.only].map(catName).join(", ") + " only" : "";
    cards.push(card({ pressed: true, label: p + "-day average", small: rangeText(from, to), value: s.avg === null ? null : fmt(s.avg), cats: s.cats, bottom: which || bottomOf(s.split, note) }));
    // The busiest day opens it in Today
    const busiest = s.days.length ? s.days.reduce((a, d) => (pickTotal(d) > pickTotal(a) ? d : a)) : null;
    cards.push(card({
      tag: busiest === null ? "div" : "a", href: busiest === null ? "" : todayLink(busiest), label: "Busiest day",
      small: busiest === null ? "" : fmtDate(busiest, { weekday: "short", month: "short", day: "numeric" }),
      value: busiest === null ? null : fmt(pickTotal(busiest)), cats: busiest === null ? null : shownCats(categoryTotals([busiest])),
      bottom: busiest === null ? "" : "See it in Today ›",
    }));
    // Against the period before
    const prevFrom = from - n, prevTo = from - 1;
    const prevDays = []; for (let d = prevFrom; d <= prevTo; d++) if (anyData(d)) prevDays.push(d);
    const prevAvg = average(prevDays, pickTotal);
    const diff = s.avg !== null && prevAvg !== null ? s.avg - prevAvg : null;
    cards.push(card({
      label: "Against the " + p + " days before", small: rangeText(prevFrom, prevTo),
      value: diff === null ? null : (diff < 0 ? "−" : "+") + fmt(Math.abs(diff)), cats: shownCats(categoryTotals(prevDays)),
      bottom: prevAvg === null ? "" : "Then " + fmt(prevAvg) + " a day",
    }));
  }
  el("period-cards").innerHTML = cards.join("");
}

// The category colors used on the page, with their names (on Today, that
// includes the 7 days before, which are in the bar chart)
function renderLegend() {
  const days = chosenDays();
  if (PAGE === "today") for (let d = state.day - 7; d < state.day; d++) if (anyData(d)) days.push(d);
  const cats = categoryTotals(days);
  const keys = CAT_KEYS.filter((key) => (cats.get(key) ?? 0) > 0);
  if (PAGE === "trends") {
    el("legend").innerHTML = toggleButtons(keys) +
      (keys.length ? '<span class="legend-hint">' + (state.only.size ? "Click more to add them" : "Click a category to spotlight it") + "</span>" +
        '<a class="legend-link" href="/organize">Edit categories</a>' : "");
    return;
  }
  el("legend").innerHTML = keys.map((key) =>
    '<button class="legend-item' + (state.focus && state.focus.app === undefined && state.focus.cat === key ? " on" : "") +
    '" data-pick-cat="' + esc(String(key)) + '" data-tip="Follow ' + esc(catName(key)) + ' on this page">' +
    '<span class="swatch" style="background:' + catColor(key) + '"></span>' + esc(catName(key)) + "</button>").join("") +
    (keys.length ? (state.focus ? "" : '<span class="legend-hint">Click a category to follow it across the page</span>') +
      '<a class="legend-link" href="/organize">Edit categories</a>' : "");
}

// The bar saying what's followed, with a link to it on the Apps page
function renderFocusBar() {
  const bar = el("focus-bar");
  bar.hidden = !state.focus;
  if (!state.focus) return;
  const f = state.focus;
  const inCat = f.app !== undefined ? '<span class="muted"> in ' + esc(catName(f.cat)) + "</span>" : "";
  const open = f.cat === UNTRACKED_KEY ? "" :
    '<a href="' + (f.app !== undefined ? appLink(f.app) : categoryLink(f.cat)) + '">Open it in Apps ›</a>';
  bar.innerHTML = '<span class="swatch" style="background:' + catColor(f.cat) + '"></span>' +
    "<span>Showing <b>" + esc(focusName()) + "</b>" + inCat + "</span>" + open +
    '<button class="focus-clear" data-clear>✕ Show everything</button>';
}

// ---------- timeline: the day by device (Today), or an average day (Trends) ----------

function renderTimeline() {
  const title = el("timeline-title");
  const hint = el("timeline-hint");
  const box = el("timeline");
  const ticks = "<div><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>";
  const axis = '<div class="hours"><span></span>' + ticks + "</div>";

  if (state.period === "day") {
    title.textContent = "Through the day";
    hint.textContent = "Hover over a block for the app and time";
    const e = byDay.get(state.day);
    const start = state.day * DAY;
    const pos = (from, to) => "left:" + (((from - start) / DAY) * 100).toFixed(3) + "%;width:" + (((to - from) / DAY) * 100).toFixed(3) + "%";
    box.innerHTML = devs.map((dev) => {
      const name = DATA.devices[dev];
      const sessions = (e?.sessions ?? []).filter((s) => s[0] === dev);
      const gaps = (e?.gaps ?? []).filter((g) => g[0] === dev);
      if (!sessions.length && !gaps.length) {
        return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track no-data">No data</div></div>';
      }
      const blocks = sessions.map(([, app, from, to, active]) =>
        '<div class="block' + (matches(app) ? "" : " dim") + '" style="' + pos(from, to) + ";background:" + catColor(catOf(app)) + '" data-tip="' +
        esc(appName(app) + " · " + catName(catOf(app)) + "\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(active)) + '"></div>');
      const gapBlocks = gaps.map(([, from, to, last]) => {
        const before = last.length ? "\nLast opened: " + last.map(([app, at]) => appName(app) + " at " + fmtClock(at)).join(", ") : "";
        return '<div class="block gap' + (matches(UNTRACKED) ? "" : " dim") + '" style="' + pos(from, to) + '" data-tip="' +
          esc("Screen on, no app recorded\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(to - from) + before) + '"></div>';
      });
      return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track">' +
        blocks.join("") + gapBlocks.join("") + "</div></div>";
    }).join("") + axis;
    return;
  }

  // Patterns: when the time goes, by hour of the day, by weekday, or by week
  // (the last 6), each stacked by category. The category buttons at the top
  // spotlight categories here too, and the bars rescale to what's shown.
  const PATTERNS = [["hours", "Hours"], ["weekdays", "Weekdays"], ["weeks", "Weeks"]];
  title.textContent = "Patterns";
  el("pattern-switch").innerHTML = PATTERNS.map(([v, text]) =>
    '<button data-pattern="' + v + '" aria-pressed="' + (v === state.pattern) + '">' + text + "</button>").join("");
  const days = periodDays(state.period);
  if (state.pattern === "weekdays") {
    hint.textContent = "An average Monday, Tuesday and so on";
    const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
    box.innerHTML = days.length ? rowBars(MON_FIRST.map((w) => {
      const ds = days.filter((d) => weekdayOf(d) === w);
      const cats = shownCats(categoryTotals(ds)); // already a daily average
      const sum = [...cats.values()].reduce((x, y) => x + y, 0);
      return {
        label: WEEKDAYS[w].slice(0, 3), cats, total: ds.length ? sum : null,
      };
    })) : '<p class="hint">No data in this period.</p>';
    return;
  }
  if (state.pattern === "weeks") {
    hint.textContent = "A day, each of the 6 weeks to " + fmtDate(Math.min(state.day, todayIdx), { month: "short", day: "numeric" });
    const weeks = sixWeeks();
    const full = weeks.filter((w) => !w.current);
    const avg = average(full.flatMap((w) => w.days), pickTotal);
    box.innerHTML = rowBars(weeks.map((w) => {
      const cats = shownCats(categoryTotals(w.days));
      const sum = [...cats.values()].reduce((x, y) => x + y, 0);
      return {
        label: w.current ? "This week" : fmtDate(w.from, { month: "short", day: "numeric" }), cats, total: w.days.length ? sum : null,
        faded: w.current,
      };
    }), { avg, avgText: "6-week average" });
    return;
  }

  // By hour: minutes in each hour, averaged over the days with data
  hint.textContent = "Minutes per hour, an average day";
  const perHour = Array.from({ length: 24 }, () => new Map());
  for (const d of days) {
    for (const [, app, start, end] of items(d)) {
      const key = catOf(app);
      for (let t = start; t < end;) {
        const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
        const i = Math.floor((t % DAY) / 3600);
        perHour[i].set(key, (perHour[i].get(key) ?? 0) + upTo - t);
        t = upTo;
      }
    }
  }
  const n = Math.max(1, days.length);
  for (const h of perHour) {
    for (const [key, secs] of h) {
      if (!shownCat(key)) h.delete(key);
      else h.set(key, secs / n);
    }
  }
  const hourSum = (h) => [...h.values()].reduce((x, y) => x + y, 0);
  const max = Math.max(state.only.size ? 1 : 60, ...perHour.map(hourSum));
  const bars = perHour.map((h, i) => {
    const sum = hourSum(h);
    const tip = [hourName(i) + ": " + fmt(sum)].concat(categoryLines(h, 30)).join("\n");
    return '<div class="hour-bar" data-tip="' + esc(tip) + '"><div class="stack" style="height:' + ((sum / max) * 100).toFixed(2) + '%">' +
      stackedLinks(h, sum, "height", hourName(i)) + "</div></div>";
  });
  box.innerHTML = days.length
    ? '<div class="hour-bars tall">' + bars.join("") + '</div><div class="hours bare">' + ticks + "</div>"
    : '<p class="hint">No data in this period.</p>';
}

// Pieces of a bar, one per category, each opening that category on the Apps
// page (Untracked has no page, so it's a plain piece). label goes in front
// of the hover text, like "Mon" or "9a".
function stackedLinks(totals, sum, mode, label) {
  return CAT_KEYS.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => {
    const share = (totals.get(key) / (sum || 1)) * 100;
    const size = mode === "flex" ? "flex:" + share.toFixed(3) + " 1 0" : "height:" + share.toFixed(3) + "%";
    const tip = label + " · " + catName(key) + ": " + fmt(totals.get(key)) + (key === UNTRACKED_KEY ? "" : "\nClick to open it on the Apps page");
    return key === UNTRACKED_KEY
      ? '<span style="' + size + ";background:" + catColor(key) + '" data-tip="' + esc(tip) + '"></span>'
      : '<a href="' + categoryLink(key) + '" style="' + size + ";background:" + catColor(key) + '" data-tip="' + esc(tip) + '"></a>';
  }).join("");
}

// Rows for Patterns (weekdays, weeks): a name, a bar split by category, and
// the time. rows: { label, cats, total (null for no data), faded }; avg draws
// a dashed line down the rows with its label above.
function rowBars(rows, { avg = null, avgText = "" } = {}) {
  const top = Math.max(60, ...rows.map((r) => r.total ?? 0), avg ?? 0);
  const pct = (v) => ((v / top) * 100).toFixed(2) + "%";
  return (avg === null ? "" : '<p class="hint pattern-key"><span class="avg-key"></span>' + avgText + " <b>" + fmt(avg) + "</b></p>") +
    '<div class="prows">' + rows.map((r) =>
      '<div class="prow"><span class="prow-name">' + esc(r.label) + "</span>" +
      '<span class="prow-track">' +
      (r.total ? '<span class="prow-bar' + (r.faded ? " faded" : "") + '" style="width:' + pct(r.total) + '">' + stackedLinks(r.cats, r.total, "flex", r.label) + "</span>" : "") +
      (avg === null ? "" : '<span class="prow-avg" style="left:' + pct(avg) + '"></span>') + "</span>" +
      '<span class="prow-time">' + (r.total === null ? "–" : fmt(r.total)) + (r.faded ? "<small>so far</small>" : "") + "</span></div>").join("") + "</div>";
}

// ---------- where the time went: apps or categories ----------

function renderTopList() {
  const box = el("top-apps");
  const days = chosenDays();
  const isDay = state.period === "day";
  el("apps-title").textContent = isDay ? "Where the time went" : "Where the time went, a day";
  el("apps-hint").textContent = state.focus ? "Click again to go back" : "Click a category to follow it";
  if (!days.length) {
    box.innerHTML = '<p class="hint">Nothing recorded ' + (isDay ? "on this day." : "in this period.") + "</p>";
    return;
  }

  // Per app and per category: seconds (per day on average), the devices,
  // seconds in each hour, and seconds on each weekday
  const counts = new Array(7).fill(0);
  for (const d of days) counts[weekdayOf(d)]++;
  const blank = () => ({ secs: 0, devs: new Set(), hours: new Array(24).fill(0), week: new Array(7).fill(0) });
  const apps = new Map(), cats = new Map();
  for (const d of days) {
    const w = weekdayOf(d);
    for (const [dev, app, start, end] of items(d)) {
      for (const [map, id] of [[apps, app], [cats, catOf(app)]]) {
        if (!map.has(id)) map.set(id, blank());
        const a = map.get(id);
        a.secs += end - start;
        a.week[w] += end - start;
        a.devs.add(dev);
        for (let t = start; t < end;) {
          const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
          a.hours[Math.floor((t % DAY) / 3600)] += upTo - t;
          t = upTo;
        }
      }
    }
  }
  for (const a of [...apps.values(), ...cats.values()]) {
    a.secs /= days.length;
    a.hours = a.hours.map((s) => s / days.length);
    a.week = a.week.map((s, w) => (counts[w] ? s / counts[w] : null));
  }

  // One row: the name, its time, then when it happens. Clicking it follows
  // it on this page (clicking again goes back: an app to its category, a
  // category to everything).
  const f = state.focus;
  const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
  const cells = (name, key, vals, label, cls) => {
    const max = Math.max(...vals.filter((v) => v !== null), 1);
    return '<span class="' + cls + '">' + vals.map((v, i) => {
      const bg = v === null ? "transparent" : v < 30 ? "var(--track)" : key === UNTRACKED_KEY ? heatShade(v / max) : shade(key, v / max);
      return '<span style="background:' + bg + '" data-tip="' + esc(name + " · " + label(i) + "\n" + (v === null ? "No data" : v < 30 ? "Under a minute" : fmt(v)) + (isDay ? "" : " on average")) + '"></span>';
    }).join("") + "</span>";
  };
  const row = (pick, look, name, second, a, key) =>
    '<button class="tw-row' + look + '" ' + pick + ">" +
    '<span class="tw-name"><span class="swatch" style="background:' + catColor(key) + '"></span><span class="app-name"><b>' + esc(name) + "</b><span>" + esc(second) + "</span></span></span>" +
    '<span class="tw-time">' + fmt(a.secs) + "</span>" +
    cells(name, key, a.hours, (h) => hourName(h), "tw-hours") +
    (isDay ? "" : cells(name, key, MON_FIRST.map((w) => a.week[w]), (i) => WEEKDAYS[MON_FIRST[i]] + "s", "tw-days")) +
    "</button>";
  const head = '<div class="tw-row head"><span></span><span class="tw-time">' + (isDay ? "" : "a day") + "</span>" +
    '<span class="tw-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></span>' +
    (isDay ? "" : '<span class="tw-days">' + MON_FIRST.map((w) => "<span>" + WEEKDAYS[w][0] + "</span>").join("") + "</span>") + "</div>";
  const appOrder = [...apps.keys()].filter((app) => app !== UNTRACKED || apps.get(app).secs >= 60)
    .sort((a, b) => apps.get(b).secs - apps.get(a).secs);
  // Each category's second line names its apps with their times (an app
  // on two devices counts once); clicking a category follows it across the
  // page (the Apps page has each app). Untracked goes last; a minute or
  // less of it isn't worth a row.
  const keys = [...cats.keys()].filter((k) => k !== UNTRACKED_KEY || cats.get(k).secs >= 60)
    .sort((a, b) => (a === UNTRACKED_KEY) - (b === UNTRACKED_KEY) || cats.get(b).secs - cats.get(a).secs);
  const shownKeys = keys; // every category, none hidden
  const html = shownKeys.map((key) => {
    const members = appOrder.filter((app) => catOf(app) === key);
    const byName = new Map();
    for (const app of members) byName.set(appName(app), (byName.get(appName(app)) ?? 0) + apps.get(app).secs);
    const named = [...byName].sort((x, y) => y[1] - x[1]);
    const second = key === UNTRACKED_KEY ? "Screen on, no app recorded"
      : named.slice(0, 4).map(([name, secs]) => name + " " + fmt(secs)).join(" · ") + (named.length > 4 ? " · " + (named.length - 4) + " more" : "");
    const picked = f && f.cat === key;
    return row('data-pick-cat="' + esc(String(key)) + '"', picked && f.app === undefined ? " on" : "", catName(key), second, cats.get(key), key);
  }).join("");
  const params = new URLSearchParams({ range: isDay ? "7" : state.period, device: state.device });
  const n = keys.length - shownKeys.length;
  const more = '<a class="more-link" href="/apps#' + params + '">' +
    (n > 0 ? "and " + n + " more " + (n === 1 ? "category" : "categories") + " · " : "") + "All apps ›</a>";
  box.innerHTML = '<div class="tw' + (isDay ? "" : " with-days") + '">' + head + html + "</div>" + more;
}

// ---------- bars: the last 8 days (Today), or day by day (Trends) ----------

function renderBars() {
  const isDay = state.period === "day";
  const n = isDay ? 8 : Number(state.period);
  // On Today: the day and the 7 before it, so the same weekday a week
  // earlier is in view to compare with
  const win = isDay ? { from: state.day - 7, to: state.day } : periodWindow(state.period);
  const days = [];
  for (let d = win.from; d <= win.to; d++) days.push(d);
  const avg = isDay ? null : average(periodDays(state.period), pickTotal);
  el("bars-title").textContent = isDay
    ? (state.day === todayIdx ? "Last 8 days" : "8 days to " + fmtDate(state.day, { month: "short", day: "numeric" }))
    : "Day by day";
  el("bars-hint").innerHTML = isDay
    ? 'Click a day to see it · <a href="' + trendsLink() + '">See more in Trends ›</a>'
    : '<span class="avg-key"></span>' + n + "-day average" + (state.focus ? " of " + esc(focusName()) : "") + " " + (avg === null ? "–" : "<b>" + fmt(avg) + "</b>");

  const top = Math.max(state.only.size ? 60 : 3600, ...days.map(state.focus ? total : pickTotal), avg ?? 0) * 1.08;
  const many = n > 10;
  let anyPartial = false;
  const cols = days.map((d) => {
    const has = anyData(d);
    const partial = has && !complete(d);
    if (partial) anyPartial = true;
    const t = state.focus ? total(d) : pickTotal(d);
    const cats = categoryTotals([d]);
    shownCats(cats);
    const label = shortDate(d);
    const pick = state.focus ? pickTotal(d) : t;
    const tip = [label + ": " + (has ? fmt(t) : "no data")]
      .concat(state.focus && has ? [focusName() + " " + fmt(pick)] : [])
      .concat(partial ? ["Missing data from a device"] : [], state.focus ? [] : categoryLines(cats, 60).slice(0, 5), [isDay ? "Click to see this day" : "Click to see it in Today"]).join("\n");
    // On Today, the other days are faded; on Trends, all are in full color
    const cls = "stack" + (isDay && d !== state.day ? " faded" : "") + (partial ? " partial" : "");
    return '<button class="bar-col" data-day="' + d + '" data-tip="' + esc(tip) + '" aria-label="' + esc(label + ": " + (has ? fmt(t) : "no data")) + '">' +
      (has ? '<span class="' + cls + '" style="height:' + ((t / top) * 100).toFixed(1) + '%">' +
        (state.focus ? pickParts(pick, t) : stackedParts(cats, t, "height")) + "</span>"
        : '<span class="stack none"></span>') + "</button>";
  });
  const labels = days.map((d, i) => {
    const on = isDay && d === state.day;
    let text = d === todayIdx ? "Today" : fmtDate(d, { weekday: "short" });
    if (isDay && d === state.day - 7) text = "Last " + text;
    if (many) text = (days.length - 1 - i) % 7 === 0 ? fmtDate(d, { month: "short", day: "numeric" }) : "";
    return '<div><span class="label' + (on ? " on" : "") + '">' + esc(text) + "</span>" +
      (many ? "" : '<span class="time">' + (anyData(d) ? fmt(pickTotal(d)) : "–") + "</span>") + "</div>";
  });
  el("bars").innerHTML =
    '<div class="bar-plot' + (many ? " many" : "") + '">' +
    (avg === null ? "" : '<div class="avg-line" style="bottom:' + ((avg / top) * 100).toFixed(1) + '%"></div>') +
    cols.join("") + "</div>" +
    '<div class="bar-labels' + (many ? " many" : "") + '">' + labels.join("") + "</div>" +
    (anyPartial ? '<p class="hint">Dashed outline: missing data from a device.</p>' : "");
}

// ---------- the 6 weeks for Patterns ----------

// The 6 weeks, Monday to Sunday, up to the chosen day: their days with data.
// This week leaves today out while it's going, except on a Monday, when
// today so far is all there is.
function sixWeeks() {
  const thisMonday = mondayOf(todayIdx);
  const lastMonday = mondayOf(Math.min(state.day, todayIdx));
  const weeks = [];
  for (let w = 0; w < WEEKS_SHOWN; w++) {
    const from = lastMonday - (WEEKS_SHOWN - 1 - w) * 7;
    const to = Math.min(from + 6, todayIdx - 1);
    const days = [];
    for (let d = from; d <= to; d++) if (anyData(d)) days.push(d);
    if (!days.length && from === thisMonday && anyData(todayIdx)) days.push(todayIdx);
    weeks.push({ from, days, current: from === thisMonday });
  }
  return weeks;
}

// The category buttons at the top of Trends: the first click spotlights a
// category in every chart, more clicks add others, Show all ends it
function toggleButtons(keys) {
  const spot = state.only.size > 0;
  return keys.map((k) =>
    '<button class="legend-item toggle' + (spot ? (state.only.has(k) ? " on" : " dim") : "") + '" data-toggle="' + esc(String(k)) +
    '" aria-pressed="' + state.only.has(k) + '">' +
    '<span class="swatch" style="background:' + catColor(k) + '"></span>' + esc(catName(k)) + "</button>").join("") +
    (spot ? '<button class="legend-item all" data-toggle="all">Show all</button>' : "");
}

// ---------- running total: the day added up, or an average day added up ----------

// On Today: the day added up through the day, next to the same weekday a
// week before and the average for that weekday over the 6 weeks before.
// On Trends: the period's average day added up, next to the period before's.
function renderRunning() {
  const spans = (d) => items(d).filter(([, app]) => counted(app)).map(([, , s, e]) => [s, e]);
  const of = state.focus ? ": " + focusName() : "";
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
    el("run-title").textContent = "An average day, added up" + of;
    el("run-hint").textContent = "Against the " + n + " days before";
    const main = averageLine(days);
    el("run").innerHTML = main
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
  el("run-title").textContent = (isToday ? "So far today" : "Through the day, added up") + of;
  el("run-hint").textContent = isToday ? "By " + fmtClock(localNow()) : "The whole day";
  el("run").innerHTML = runningTotalHtml(
    { main: line(state.day), last: anyData(lastDay) ? line(lastDay) : null, avg },
    {
      main: isToday ? "Today" : shortDate(state.day),
      last: isToday ? "Last " + WEEKDAYS[w] : shortDate(lastDay),
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

const step = () => (state.period === "day" ? 1 : Number(state.period));
el("prev").addEventListener("click", () => update({ day: state.day - step() }));
el("next").addEventListener("click", () => update({ day: state.day + step() }));

const on = (id, type, fn) => { if (shown(id)) el(id).addEventListener(type, fn); };

// A category button at the top of Trends: spotlight it in every chart
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-toggle]");
  if (!b) return;
  if (b.dataset.toggle === "all") state.only.clear();
  else {
    // The first click spotlights a category; more clicks add or remove
    // others; removing the last one shows everything again
    const key = CAT_KEYS.find((k) => String(k) === b.dataset.toggle);
    if (state.only.has(key)) state.only.delete(key); else state.only.add(key);
  }
  update({});
});
// Following a category or app: picking it again goes back (an app to its
// category, a category to everything)
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick-cat], [data-pick-app], [data-clear]");
  if (!b) return;
  const f = state.focus;
  if (b.dataset.clear !== undefined) return update({ focus: null });
  if (b.dataset.pickCat !== undefined) {
    const key = CAT_KEYS.find((k) => String(k) === b.dataset.pickCat);
    if (key === undefined) return;
    return update({ focus: f && f.cat === key && f.app === undefined ? null : { cat: key } });
  }
  const app = DATA.apps.findIndex((a) => a.id === b.dataset.pickApp);
  if (app === -1) return;
  update({ focus: f && f.app === app ? { cat: catOf(app) } : { cat: catOf(app), app } });
});
// A day in the bars: on Today it shows that day here; on Trends it opens Today
on("bars", "click", (e) => {
  const target = e.target.closest("[data-day]");
  if (!target) return;
  if (PAGE === "today") update({ day: Number(target.dataset.day) });
  else location.href = todayLink(Number(target.dataset.day));
});
on("pattern-switch", "click", (e) => {
  const b = e.target.closest("[data-pattern]");
  if (b) update({ pattern: b.dataset.pattern });
});
el("device-filter").addEventListener("click", (e) => {
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
  renderFocusBar();
  if (shown("timeline")) renderTimeline();
  if (shown("top-apps")) renderTopList();
  if (shown("run")) renderRunning();
  if (shown("bars")) renderBars();
}

setDevices();
render();
