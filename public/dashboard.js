// public/dashboard.js
//
// The Today and Trends pages. Both load this script; the page says which it
// is (<body data-page="today"> or "trends"), and each part below is drawn
// only if the page has a place for it.
//
// Today has a Day and a Week view. Day: the timeline by device, so far
// today (added up through the day, against last week's same weekday and its
// 6-week average), the last 8 days, and the most used apps or categories.
// Week: the 7 days before as bars, with the most used apps (or categories)
// as daily averages. The day card opens Day, the 7-day card opens Week, and the
// 30-day card opens Trends. Clicking an app or category highlights it on
// the page (the rest fades back), and so does clicking a block on the
// timeline (its app, or its category when the side list shows categories).
// Clear it in the bar above the cards, with Esc, or by clicking it again.
//
// Trends is about the last 30 days, ending on a day you can move (the
// arrows move 30 days): day by day, the last day against an average day
// added up, Patterns (by hour with the last day as a line, by weekday, or
// the last 6 weeks), and the top apps. The category buttons at the top
// spotlight categories in every chart, cards included. Clicking a day
// opens it in Today.
//
// Color means category everywhere (the colors you pick on Organize).
//
// Loads /api/usage from the local server (server.mjs); shared helpers and
// charts are in common.js. The address keeps what you picked, for example
// /#day=2026-10-26&device=0&view=week&focus=cat:2 or /trends#pattern=weekdays&only=2,5

import { setupRefresh, showLastArchived } from "./refresh.js";
import {
  DAY, WEEKDAYS, loadUsage, esc, fmt, dateOf, fmtDate, weekdayOf, isoDay, dayFromIso, fmtClock,
  todayIdx, hideTip, UNTRACKED_KEY, categoryKeys, categoryColor, categoryName,
  hourName, localNow, STEPS, stepTotals, runningTotal, runningTotalHtml,
} from "./common.js";

const PAGE = document.body.dataset.page === "trends" ? "trends" : "today";
const SESSION_GAP = 60;          // uses of the same app less than this apart count as one open
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

// ---------- what you picked ----------

// period: "day" or "7" on Today (the Day and Week views), "30" on Trends.
// focus: what's highlighted on Today, null for everything, { cat } for a
// category, { cat, app } for an app. list: Today's side list (Used today) shows "apps" or
// "cats".
const state = { day: todayIdx, period: PAGE === "today" ? "day" : "30", device: "all", pattern: "hours", list: "apps", focus: null, only: new Set() };
{
  const hash = decodeURIComponent(location.hash.slice(1));
  const params = new URLSearchParams(hash);
  const d = dayFromIso(hash) ?? dayFromIso(params.get("day") ?? "");
  if (d !== null) state.day = clampDay(d);
  const device = params.get("device");
  if (device !== null && DATA.devices[Number(device)] !== undefined) state.device = device;
  if (["weekdays", "weeks"].includes(params.get("pattern"))) state.pattern = params.get("pattern");
  if (PAGE === "today" && params.get("view") === "week") state.period = "7";
  if (PAGE === "today" && params.get("list") === "cats") state.list = "cats";
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
  if (PAGE === "today" && state.period === "7") params.set("view", "week");
  if (PAGE === "today" && state.list === "cats") params.set("list", "cats");
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
const devicePick = (day, dev) => (state.only.size || state.focus
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

// Each app's daily average over some days (only spotlighted categories on
// Trends), biggest first: [{ app, secs, devs }]. Untracked isn't an app.
function appAverages(days) {
  const out = new Map();
  for (const d of days) {
    for (const [dev, app, start, end] of items(d)) {
      if (app === UNTRACKED || !counted(app)) continue;
      if (!out.has(app)) out.set(app, { app, secs: 0, devs: new Set() });
      const a = out.get(app);
      a.secs += end - start;
      a.devs.add(dev);
    }
  }
  const n = Math.max(1, days.length);
  return [...out.values()].map((a) => ({ ...a, secs: a.secs / n })).sort((a, b) => b.secs - a.secs);
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
// horizontal share bar, "height" for a vertical stacked bar. With a title,
// hovering a piece shows the bar's categories (title and line on top) with
// that piece's category marked, and fades the other categories in the chart.
// pick: clicking a piece highlights its category.
function stackedParts(totals, sum, mode, title = "", line = "", pick = false) {
  return CAT_KEYS.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => {
    const share = (totals.get(key) / (sum || 1)) * 100;
    const size = mode === "flex" ? "flex:" + share.toFixed(3) + " 1 0" : "height:" + share.toFixed(3) + "%";
    const tip = title ? ' data-tip="' + esc(title + "\n" + line) + '" data-tip-rows="' + categoryRows(totals, key) + '"' : "";
    const act = pick ? ' data-pick-cat="' + esc(String(key)) + '"' : "";
    return '<span data-cat="' + esc(String(key)) + '"' + act + ' style="' + size + ";background:" + catColor(key) + '"' + tip + "></span>";
  }).join("");
}


// Hover rows for categories (see showTip in common.js): largest first, up to
// 8 and then "N more", with current (a category key) marked. Ready to put in
// a data-tip-rows attribute.
function categoryRows(totals, current = null) {
  const ranked = [...totals].filter(([, secs]) => secs > 0).sort((a, b) => b[1] - a[1]);
  const rows = ranked.slice(0, 8).map(([key, secs]) => [catColor(key), catName(key), fmt(secs), key === current ? 1 : 0]);
  const rest = ranked.slice(8);
  if (rest.length) rows.push(["", rest.length + " more", fmt(rest.reduce((x, [, secs]) => x + secs, 0)), rest.some(([key]) => key === current) ? 1 : 0]);
  return esc(JSON.stringify(rows));
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
function card({ tag = "div", href = "", attrs = "", pressed = false, label, small = "", value, text = false, cats = null, bottom = "" }) {
  const sum = cats ? [...cats.values()].reduce((a, b) => a + b, 0) : 0;
  return "<" + tag + ' class="period-card' + (pressed ? " chosen" : "") + (href ? " link" : "") + '"' + (href ? ' href="' + href + '"' : "") +
    (tag === "button" ? ' type="button"' : "") + (attrs ? " " + attrs : "") + ">" +
    '<span class="label"><span>' + esc(label) + "</span><small>" + esc(small) + "</small></span>" +
    '<span class="value' + (value === null ? " none" : text ? " text" : "") + '">' + (value === null ? "No data" : text ? esc(value) : value) + "</span>" +
    '<span class="share"' + (sum ? ' data-tip="' + esc(label + "\n" + fmt(sum) + " in all") + '" data-tip-rows="' + categoryRows(cats) + '"' : "") + ">" +
    (sum ? stackedParts(cats, sum, "flex", label, fmt(sum) + " in all") : "") + "</span>" +
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
  return { days, avg, cats: cardCats(days, avg), split };
}

// A card's color bar: the categories that show, or just the highlighted one
const cardCats = (days, value) => (state.focus ? new Map(value ? [[state.focus.cat, value]] : []) : shownCats(categoryTotals(days)));

function renderCards() {
  // The device split only helps with more than one device; with one it
  // would repeat the big number. The bottom line is always there (empty if
  // need be) so the cards keep the same height.
  const bottomOf = (split, note = "") => (devs.length > 1 ? split : []).concat(note ? [note] : []).join("  ·  ");
  const cards = [];
  if (PAGE === "today") {
    // The day card shows the Day view and the 7-day card the Week view, in
    // place; the 30-day card opens Trends
    const n = dayName(state.day, false);
    const days = anyData(state.day) ? [state.day] : [];
    cards.push(card({
      tag: "button", attrs: 'data-view="day"', pressed: state.period === "day", label: n.relative || n.date,
      value: days.length ? fmt(pickTotal(state.day)) : null, cats: cardCats(days, days.length ? pickTotal(state.day) : 0),
      bottom: bottomOf(devs.map((dev) => DATA.devices[dev] + " " + (hasData(state.day, dev) ? fmt(devicePick(state.day, dev)) : "no data"))),
    }));
    const week = periodWindow("7");
    const s7 = periodSummary("7");
    const before = periodSummary("7", week.to - 7).avg;
    const change = s7.avg !== null && before !== null ? (s7.avg >= before ? "+" : "−") + fmt(Math.abs(s7.avg - before)) + " vs the week before" : "";
    cards.push(card({
      tag: "button", attrs: 'data-view="7"', pressed: state.period === "7", label: "7-day average", small: rangeText(week.from, week.to),
      value: s7.avg === null ? null : fmt(s7.avg), cats: s7.cats, bottom: change,
    }));
    const month = periodWindow("30");
    const s30 = periodSummary("30");
    cards.push(card({
      tag: "a", href: trendsLink(), label: "30-day average", small: rangeText(month.from, month.to),
      value: s30.avg === null ? null : fmt(s30.avg), cats: s30.cats, bottom: bottomOf(s30.split, "See in Trends ›"),
    }));
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
    // The most used app (of the spotlighted categories), which opens it on the Apps page
    const top = appAverages(s.days)[0];
    cards.push(card({
      tag: top ? "a" : "div", href: top ? appLink(top.app) : "", label: "Most used app", small: top ? catName(catOf(top.app)) : "",
      value: top ? appName(top.app) : null, text: true, cats: top ? new Map([[catOf(top.app), top.secs]]) : null,
      bottom: top ? fmt(top.secs) + " daily average  ·  See it in Apps ›" : "",
    }));
  }
  el("period-cards").innerHTML = cards.join("");
}

// Trends' category buttons: the categories in the period
function renderLegend() {
  const cats = categoryTotals(chosenDays());
  const keys = CAT_KEYS.filter((key) => (cats.get(key) ?? 0) > 0);
  el("legend").innerHTML = toggleButtons(keys) +
    (keys.length ? '<span class="legend-hint">' + (state.only.size ? "Click more to add them" : "Click a category to highlight it") + "</span>" +
      '<a class="legend-link" href="/organize">Edit categories</a>' : "");
}

// Above Today's cards while something is highlighted: what it is (every
// number on the page is only that), and the one place to clear it
function renderFocusBar() {
  const bar = el("focus-bar");
  const f = state.focus;
  bar.hidden = !f;
  if (!f) return;
  const what = esc(focusName()) + (f.app !== undefined ? ' <span class="muted">· ' + esc(catName(f.cat)) + "</span>" : "");
  bar.innerHTML = '<span class="swatch" style="background:' + catColor(f.cat) + '"></span>' +
    "<span>Highlighting <b>" + what + "</b></span>" +
    '<button class="focus-clear" data-clear>Clear</button>';
}

// ---------- timeline: the day by device (Today), or an average day (Trends) ----------

function renderTimeline() {
  const title = el("timeline-title");
  const hint = el("timeline-hint");
  const box = el("timeline");
  const ticks = "<div><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>";
  const axis = '<div class="hours bare">' + ticks + "</div>";

  if (PAGE === "today") {
    hint.textContent = "";
    // A lane of blocks: sessions (and untracked time) on one day, from
    // the given devices; dev names the device in the hover text
    const lane = (name, day, laneDevs, cls = "", nameAttrs = "") => {
      const e = byDay.get(day);
      const start = day * DAY;
      const pos = (from, to) => "left:" + (((from - start) / DAY) * 100).toFixed(3) + "%;width:" + (((to - from) / DAY) * 100).toFixed(3) + "%";
      const sessions = (e?.sessions ?? []).filter((x) => laneDevs.includes(x[0]));
      const gaps = (e?.gaps ?? []).filter((g) => laneDevs.includes(g[0]));
      const label = '<span class="lane-name"' + nameAttrs + ">" + esc(name) + "</span>";
      if (!sessions.length && !gaps.length) return '<div class="lane' + cls + '"><div class="lane-track no-data">No data</div>' + label + "</div>";
      const where = (dev) => (laneDevs.length > 1 ? " · " + DATA.devices[dev] : "");
      const pickAttr = (app) => (app === UNTRACKED ? 'data-pick-cat="' + esc(String(UNTRACKED_KEY)) + '"'
        : state.list === "cats" ? 'data-pick-cat="' + esc(String(catOf(app))) + '"' : 'data-pick-app="' + esc(appKey(app)) + '"');
      const blocks = sessions.map(([dev, app, from, to, active]) =>
        '<div class="block' + (state.focus ? (matches(app) ? " on" : " dim") : "") + '" ' + pickAttr(app) +
        ' style="' + pos(from, to) + ";background:" + catColor(catOf(app)) + '" data-tip-color="' + esc(catColor(catOf(app))) + '" data-tip="' +
        esc(appName(app) + "\n" + catName(catOf(app)) + where(dev) + "\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(active)) + '"></div>');
      const gapBlocks = gaps.map(([dev, from, to, last]) => {
        const before = last.length ? "\nLast opened: " + last.map(([app, at]) => appName(app) + " at " + fmtClock(at)).join(", ") : "";
        return '<div class="block gap' + (state.focus ? (matches(UNTRACKED) ? " on" : " dim") : "") + '" data-pick-cat="' + esc(String(UNTRACKED_KEY)) + '" style="' + pos(from, to) + '" data-tip="' +
          esc("Screen on, no app recorded\n" + (where(dev) ? DATA.devices[dev] + "\n" : "") + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(to - from) + before) + '"></div>';
      });
      return '<div class="lane' + cls + '"><div class="lane-track">' + blocks.join("") + gapBlocks.join("") + "</div>" + label + "</div>";
    };
    if (state.period === "day") {
      title.textContent = "Through the day";
      box.innerHTML = todayHours([state.day]) + axis + devs.map((dev) => lane(DATA.devices[dev], state.day, [dev])).join("");
      return;
    }
    // The Week view: one row per day (the devices together); a day's name opens it
    title.textContent = "Through the week";
    hint.textContent = "One row per day · click a day's name to see it";
    const { from, to } = periodWindow(state.period);
    const rows = [];
    for (let d = from; d <= to; d++) {
      rows.push(lane(fmtDate(d, { weekday: "short" }), d, devs, " week", ' role="button" tabindex="0" data-open-day="' + d + '" data-tip="' + esc(shortDate(d) + "\nClick to see this day") + '"'));
    }
    box.innerHTML = todayHours(periodDays(state.period)) + axis + rows.join("");
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
    hint.textContent = "Daily average for each weekday";
    const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
    box.innerHTML = days.length ? rowBars(MON_FIRST.map((w) => {
      const ds = days.filter((d) => weekdayOf(d) === w);
      const cats = shownCats(categoryTotals(ds)); // already a daily average
      const sum = [...cats.values()].reduce((x, y) => x + y, 0);
      return {
        label: WEEKDAYS[w].slice(0, 3), title: WEEKDAYS[w] + "s", cats, total: ds.length ? sum : null,
      };
    })) : '<p class="hint">No data in this period.</p>';
    return;
  }
  if (state.pattern === "weeks") {
    hint.textContent = "Daily average, each of the 6 weeks to " + fmtDate(Math.min(state.day, todayIdx), { month: "short", day: "numeric" });
    const weeks = sixWeeks();
    const full = weeks.filter((w) => !w.current);
    const avg = average(full.flatMap((w) => w.days), pickTotal);
    box.innerHTML = rowBars(weeks.map((w) => {
      const cats = shownCats(categoryTotals(w.days));
      const sum = [...cats.values()].reduce((x, y) => x + y, 0);
      return {
        label: w.current ? "This week" : fmtDate(w.from, { month: "short", day: "numeric" }),
        title: w.current ? "This week" : "Week of " + fmtDate(w.from, { month: "short", day: "numeric" }), cats, total: w.days.length ? sum : null,
        faded: w.current,
      };
    }), { avg, avgText: "6-week average" });
    return;
  }

  // By hour: minutes in each hour, averaged over the days with data
  const win = periodWindow(state.period);
  hint.textContent = "Minutes per hour, an average day " + rangeText(win.from, win.to);
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
  const max = Math.max(state.only.size ? 1 : 60, ...perHour.map(hourSum)) * 1.04;
  const bars = perHour.map((h, i) => {
    const sum = hourSum(h);
    const title = hourName(i) + " to " + hourName((i + 1) % 24) + ", an average day";
    return '<div class="hour-bar" data-tip="' + esc(title + "\n" + fmt(sum) + " in all") + '"' + (sum ? ' data-tip-rows="' + categoryRows(h) + '"' : "") + '>' +
      '<div class="stack" style="height:' + ((sum / max) * 100).toFixed(2) + '%">' + stackedLinks(h, sum, "height", title, fmt(sum) + " in all") + "</div></div>";
  });
  box.innerHTML = days.length
    ? '<div class="hour-bars tall">' + bars.join("") + '</div><div class="hours bare">' + ticks + "</div>"
    : '<p class="hint">No data in this period.</p>';
}

// Today: minutes in each hour above the timeline, lined up with its lanes.
// The day's own hours in the Day view, an average day in the Week view.
// Each bar is split by app (or by category when the side list shows
// categories), the same way the timeline's blocks are, so hovering a piece
// lights up the same thing in both, and clicking it highlights it. With
// something highlighted, a bar shows just its part of the hour, with the
// rest of the hour faded behind it.
function todayHours(days) {
  const byCat = state.list === "cats";
  // What a piece of time belongs to: an app, a category, or Untracked
  const keyOf = (app) => (app === UNTRACKED ? "u" : byCat ? "c" + catOf(app) : "a" + app);
  const perHour = Array.from({ length: 24 }, () => new Map());
  const picked = new Array(24).fill(0);
  const sample = new Map(); // a key's app, to get its name, color and category
  for (const d of days) {
    for (const [, app, start, end] of items(d)) {
      const key = keyOf(app);
      if (!sample.has(key)) sample.set(key, app);
      const hit = state.focus && matches(app);
      for (let t = start; t < end;) {
        const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
        const i = Math.floor((t % DAY) / 3600);
        perHour[i].set(key, (perHour[i].get(key) ?? 0) + upTo - t);
        if (hit) picked[i] += upTo - t;
        t = upTo;
      }
    }
  }
  const n = Math.max(1, days.length);
  for (const h of perHour) for (const [key, secs] of h) h.set(key, secs / n);
  const hourSum = (h) => [...h.values()].reduce((x, y) => x + y, 0);
  const max = Math.max(600, ...perHour.map(hourSum)) * 1.04;
  const catKey = (key) => (key === "u" ? UNTRACKED_KEY : catOf(sample.get(key)));
  const label = (key) => (key === "u" ? catName(UNTRACKED_KEY) : byCat ? catName(catKey(key)) : appName(sample.get(key)));
  const pick = (key) => (key === "u" ? 'data-pick-cat="' + esc(String(UNTRACKED_KEY)) + '"'
    : byCat ? 'data-pick-cat="' + esc(String(catKey(key))) + '"' : 'data-pick-app="' + esc(appKey(sample.get(key))) + '"');
  const avg = days.length > 1 ? ", an average day" : "";
  // Pieces in category order, so an app sits next to the others in its category
  const order = (h) => [...h.keys()].sort((a, b) => CAT_KEYS.indexOf(catKey(a)) - CAT_KEYS.indexOf(catKey(b)) || h.get(b) - h.get(a));
  const bars = perHour.map((h, i) => {
    const sum = hourSum(h);
    const title = hourName(i) + " to " + hourName((i + 1) % 24) + avg;
    // The hover rows: the biggest first, with the hovered one marked
    const ranked = [...h.keys()].sort((a, b) => h.get(b) - h.get(a));
    const tipRows = (current) => {
      const rows = ranked.slice(0, 8).map((key) => [catColor(catKey(key)), label(key), fmt(h.get(key)), key === current ? 1 : 0]);
      const rest = ranked.slice(8);
      if (rest.length) rows.push(["", rest.length + " more", fmt(rest.reduce((x, key) => x + h.get(key), 0)), rest.includes(current) ? 1 : 0]);
      return esc(JSON.stringify(rows));
    };
    let pieces;
    let barTip;
    if (state.focus) {
      const mine = picked[i] / n;
      barTip = title + "\n" + fmt(mine) + " of " + focusName() + (sum ? "\n" + fmt(sum) + " in all" : "");
      pieces = (mine ? '<span class="mine" style="height:' + ((mine / (sum || 1)) * 100).toFixed(3) + "%;background:" + focusColor() + '"></span>' : "") +
        (sum - mine > 0 ? '<span class="rest" style="height:' + (((sum - mine) / (sum || 1)) * 100).toFixed(3) + '%"></span>' : "");
    } else {
      barTip = title + "\n" + fmt(sum) + " in all";
      pieces = order(h).map((key) =>
        "<span " + pick(key) + ' style="height:' + ((h.get(key) / (sum || 1)) * 100).toFixed(3) + "%;background:" + catColor(catKey(key)) +
        '" data-tip="' + esc(barTip) + '" data-tip-rows="' + tipRows(key) + '"></span>').join("");
    }
    return '<div class="hour-bar" data-tip="' + esc(barTip) + '"' + (state.focus || !sum ? "" : ' data-tip-rows="' + tipRows(null) + '"') + '>' +
      '<div class="stack" style="height:' + ((sum / max) * 100).toFixed(2) + '%">' + pieces + "</div></div>";
  });
  return '<div class="lane-hours"><div class="hour-bars">' + bars.join("") + "</div></div>";
}

// Patterns: pieces of a bar, one per category. Hovering a piece shows the
// whole bar's categories (title and line on top, like "Mon" and "3h in
// all") with that piece's category marked, and clicking it highlights that
// category on Trends.
function stackedLinks(totals, sum, mode, title, line) {
  return CAT_KEYS.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => {
    const share = (totals.get(key) / (sum || 1)) * 100;
    const size = mode === "flex" ? "flex:" + share.toFixed(3) + " 1 0" : "height:" + share.toFixed(3) + "%";
    const on = state.only.has(key);
    const tip = ' data-tip="' + esc(title + "\n" + line + "\nClick to " + (on ? "stop highlighting " : "highlight ") + catName(key)) + '" data-tip-rows="' + categoryRows(totals, key) + '"';
    return '<span data-cat="' + esc(String(key)) + '" data-toggle="' + esc(String(key)) + '" style="' + size + ";background:" + catColor(key) + '"' + tip + "></span>";
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
      (r.total ? '<span class="prow-bar' + (r.faded ? " faded" : "") + '" style="width:' + pct(r.total) + '">' + stackedLinks(r.cats, r.total, "flex", r.title ?? r.label, fmt(r.total) + " daily average" + (r.faded ? " so far" : "")) + "</span>" : "") +
      (avg === null ? "" : '<span class="prow-avg" style="left:' + pct(avg) + '"></span>') + "</span>" +
      '<span class="prow-time">' + (r.total === null ? "–" : fmt(r.total)) + (r.faded ? "<small>so far</small>" : "") + "</span></div>").join("") + "</div>";
}

// ---------- most used: apps or categories (Today) ----------

// One list with an Apps / Categories switch, under a thin bar of the day's
// (or the week's) categories. Times are daily averages in the Week view.
// Clicking a row highlights it on the page; clicking it again clears it.
function renderLists() {
  const days = chosenDays();
  const isDay = state.period === "day";
  el("list-switch").innerHTML = [["apps", "Apps"], ["cats", "Categories"]].map(([v, text]) =>
    '<button data-list="' + v + '" aria-pressed="' + (v === state.list) + '">' + text + "</button>").join("");
  // The heading says which time it's about: "Used today", "Used on Monday", "Used this week"
  el("list-title").textContent = !isDay ? "Used this week" : state.day === todayIdx ? "Used today" : "Used on " + fmtDate(state.day, { weekday: "long" });
  el("apps-hint").textContent = isDay ? "" : "Daily average, " + rangeText(periodWindow("7").from, periodWindow("7").to);
  el("apps-hint").hidden = isDay;
  if (!days.length) {
    el("top-apps").innerHTML = '<p class="hint">Nothing recorded ' + (isDay ? "on this day." : "in these days.") + "</p>";
    return;
  }
  const apps = new Map(), cats = new Map(), devsOf = new Map();
  for (const d of days) {
    for (const [dev, app, start, end] of items(d)) {
      apps.set(app, (apps.get(app) ?? 0) + end - start);
      cats.set(catOf(app), (cats.get(catOf(app)) ?? 0) + end - start);
      if (!devsOf.has(app)) devsOf.set(app, new Set());
      devsOf.get(app).add(dev);
    }
  }
  for (const m of [apps, cats]) for (const [k, v] of m) m.set(k, v / days.length);
  const catSum = [...cats.values()].reduce((x, y) => x + y, 0);
  const shareTitle = el("list-title").textContent, shareLine = fmt(catSum) + (isDay ? " in all" : " daily average");
  const share = '<span class="share list-share" data-tip="' + esc(shareTitle + "\n" + shareLine) + '" data-tip-rows="' + categoryRows(cats) + '">' + stackedParts(cats, catSum, "flex", shareTitle, shareLine + "\nClick a color to highlight it", true) + "</span>";
  const f = state.focus;
  const row = (attr, on, name, sub, secs, key) =>
    '<button class="list-row' + (on ? " on" : "") + '" ' + attr + (on ? ' style="--tint:' + solidColor(key) + '"' : "") + ">" +
    '<span class="list-name"><span class="swatch" style="background:' + catColor(key) + '"></span><b>' + esc(name) + "</b>" +
    (sub ? "<small>" + esc(sub) + "</small>" : "") + "</span>" +
    '<span class="list-time">' + fmt(secs) + "</span></button>";

  if (state.list === "cats") {
    // Categories, biggest first; Untracked last, if it's at least a minute
    const keys = [...cats.keys()].filter((k) => k !== UNTRACKED_KEY || cats.get(k) >= 60)
      .sort((a, b) => (a === UNTRACKED_KEY) - (b === UNTRACKED_KEY) || cats.get(b) - cats.get(a));
    el("top-apps").innerHTML = share + keys.map((k) =>
      row('data-pick-cat="' + esc(String(k)) + '"', f && f.cat === k, catName(k),
        Math.round((cats.get(k) / (catSum || 1)) * 100) + "%", cats.get(k), k)).join("") +
      '<p class="list-more"><a class="more-link" href="/organize">Edit categories ›</a></p>';
    return;
  }
  // Apps, biggest first; the same name on two devices gets its device named
  const order = [...apps.keys()].filter((a) => a !== UNTRACKED).sort((a, b) => apps.get(b) - apps.get(a));
  const nameCount = new Map();
  for (const a of order) nameCount.set(appName(a), (nameCount.get(appName(a)) ?? 0) + 1);
  el("top-apps").innerHTML = share + order.map((a) => {
    const sub = nameCount.get(appName(a)) > 1 ? [...devsOf.get(a)].map((dev) => DATA.devices[dev]).join(" and ") : "";
    return row('data-pick-app="' + esc(appKey(a)) + '"', f && (f.app === undefined ? f.cat === catOf(a) : f.app === a), appName(a), sub, apps.get(a), catOf(a));
  }).join("") + '<p class="list-more">' +
    '<a class="more-link" href="/apps#' + new URLSearchParams({ range: "7", device: state.device }) + '">Details on the Apps page ›</a></p>';
}

// ---------- top apps (Trends) ----------

// The most used apps over the period (of the spotlighted categories): each
// one's daily average, its share of the time shown (all of it, or the
// spotlighted categories'), and a small chart of its average day by hour
// (each app on its own scale). The app's name opens it on the Apps page;
// its category opens the category.
function renderTopApps() {
  const days = periodDays(state.period);
  const list = appAverages(days).slice(0, 10);
  el("top-apps-hint").textContent = state.only.size ? [...state.only].map(catName).join(", ") + " only" : "";
  if (!list.length) {
    el("trend-apps").innerHTML = '<p class="hint">No apps in this period.</p>';
    return;
  }
  const nameCount = new Map();
  for (const a of list) nameCount.set(appName(a.app), (nameCount.get(appName(a.app)) ?? 0) + 1);
  // What a share is out of: the daily average of everything shown
  const whole = average(days, pickTotal) || 1;
  const wholeName = state.only.size ? [...state.only].map(catName).join(" and ") : "all your time";
  // Seconds per hour of the day for each listed app, over the whole period
  const hours = new Map(list.map((a) => [a.app, new Array(24).fill(0)]));
  for (const d of days) {
    for (const [, app, start, end] of items(d)) {
      const sums = hours.get(app);
      if (!sums) continue;
      for (let t = start; t < end;) {
        const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
        sums[Math.floor((t % DAY) / 3600)] += upTo - t;
        t = upTo;
      }
    }
  }
  const head = '<div class="trend-app head"><span>App</span><span class="list-time">Daily average</span>' +
    '<span class="list-time" data-tip="' + esc("Share of " + wholeName) + '">Share</span>' +
    '<span class="day-ticks"><span></span><span>6 AM</span><span>12 PM</span><span>6 PM</span></span></div>';
  const rows = list.map((a) => {
    const cat = catOf(a.app);
    const color = catColor(cat);
    const device = nameCount.get(appName(a.app)) > 1 ? [...a.devs].map((dev) => DATA.devices[dev]).join(" and ") + " · " : "";
    const share = Math.round((a.secs / whole) * 100);
    const perHour = hours.get(a.app).map((secs) => secs / Math.max(1, days.length));
    const hourTop = Math.max(1, ...perHour);
    const dayBars = perHour.map((v, h) => '<span data-tip-color="' + esc(color) + '" data-tip="' + esc(appName(a.app) + "\n" + hourName(h) + " to " + hourName((h + 1) % 24) + "\n" + fmt(v) + " on an average day") + '">' +
      (v ? '<span style="height:' + Math.max(6, (v / hourTop) * 100).toFixed(1) + "%;background:" + color + '"></span>' : "") + "</span>").join("");
    const catPart = cat === UNTRACKED_KEY
      ? esc(catName(cat))
      : '<a class="cat-name" href="' + categoryLink(cat) + '" data-tip="' + esc(catName(cat) + "\nClick to open it on the Apps page") + '">' + esc(catName(cat)) + "</a>";
    return '<div class="trend-app" data-href="' + appLink(a.app) + '">' +
      '<span class="list-name"><span class="swatch" style="background:' + color + '"></span>' +
      '<a class="app-name" href="' + appLink(a.app) + '" data-tip="' + esc(appName(a.app) + "\n" + fmt(a.secs) + " daily average\nClick to open it on the Apps page") + '">' + esc(appName(a.app)) + "</a>" +
      "<small>" + esc(device) + catPart + "</small></span>" +
      '<span class="list-time">' + fmt(a.secs) + "</span>" +
      '<span class="list-time share-pct" data-tip="' + esc(appName(a.app) + ": " + (share < 1 ? "under 1" : share) + "% of " + wholeName) + '">' + (share < 1 ? "<1" : share) + "%</span>" +
      '<span class="day-bars">' + dayBars + "</span></div>";
  }).join("");
  el("trend-apps").innerHTML = head + rows +
    '<a class="more-link" href="/apps#' + new URLSearchParams({ range: "30", device: state.device }) + '">All apps on the Apps page ›</a>';
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
    : PAGE === "today" ? (win.to === todayIdx - 1 ? "Last 7 days" : "7 days to " + fmtDate(win.to, { month: "short", day: "numeric" })) : "Day by day";
  el("bars-hint").innerHTML = isDay
    ? "Click a day to see it"
    :
      '<span class="avg-key"></span>' + n + "-day average" + (state.focus ? " of " + esc(focusName()) : "") + " " + (avg === null ? "–" : "<b>" + fmt(avg) + "</b>");

  // With something highlighted (Today) or spotlighted (Trends), the bars show
  // only that, scaled to its own busiest day, so even a little-used app fills
  // the chart
  const top = Math.max(state.focus || state.only.size ? 60 : 3600, ...days.map(pickTotal), avg ?? 0) * 1.08;
  const many = n > 10;
  let anyPartial = false;
  const cols = days.map((d) => {
    const has = anyData(d);
    const partial = has && !complete(d);
    if (partial) anyPartial = true;
    const t = pickTotal(d);
    const cats = categoryTotals([d]);
    shownCats(cats);
    const label = shortDate(d);
    const tip = [fmtDate(d, { weekday: "long", month: "short", day: "numeric" }), has ? fmt(t) + (state.focus ? " of " + focusName() : " in all") : "No data"]
      .concat(state.focus && has ? [fmt(total(d)) + " in all"] : [])
      .concat(partial ? ["Missing data from a device"] : [], [PAGE === "today" ? "Click to see this day" : "Click to see it in Today"]).join("\n");
    const rows = has && !state.focus ? ' data-tip-rows="' + categoryRows(cats) + '"' : "";
    // On Today, the other days are faded; on Trends, all are in full color
    const cls = "stack" + (isDay && d !== state.day ? " faded" : "") + (partial ? " partial" : "");
    // A day's bar opens the day; hovering a piece marks its category in the tooltip
    const [tipTitle, ...tipLines] = tip.split("\n");
    const pieces = state.focus
      ? '<span style="height:100%;background:' + focusColor() + '"></span>'
      : stackedParts(cats, t, "height", tipTitle, tipLines.join("\n"));
    return '<button class="bar-col" data-day="' + d + '" data-tip="' + esc(tip) + '"' + rows + ' aria-label="' + esc(label + ": " + (has ? fmt(t) : "no data")) + '">' +
      (has && t > 0 ? '<span class="' + cls + '" style="height:' + ((t / top) * 100).toFixed(1) + '%">' + pieces + "</span>"
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
    '" aria-pressed="' + state.only.has(k) + '"' + (state.only.has(k) ? ' style="--tint:' + solidColor(k) + '"' : "") + ">" +
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
  if (PAGE === "today" && state.period !== "day") {
    // The Week view: the week's average day added up, against the week before
    const win = periodWindow(state.period);
    const days = periodDays(state.period);
    const before = periodDays(state.period, win.to - 7);
    el("run-title").textContent = "An average day, added up" + of;
    el("run-hint").textContent = "Against the week before";
    const main = averageLine(days);
    el("run").innerHTML = main
      ? runningTotalHtml({ main, last: averageLine(before), avg: null },
        { main: rangeText(win.from, win.to), last: rangeText(win.from - 7, win.to - 7), avg: "" })
      : '<p class="hint">No data in these days.</p>';
    return;
  }
  if (state.period !== "day") {
    // Trends: the last day (today so far, while it's going) against the
    // period's average day, added up through the day
    const win = periodWindow(state.period);
    const days = periodDays(state.period);
    const isToday = state.day === todayIdx;
    const name = isToday ? "Today" : shortDate(state.day);
    el("run-title").textContent = name + " against an average day";
    el("run-hint").textContent = "Average of " + rangeText(win.from, win.to);
    const avg = averageLine(days);
    el("run").innerHTML = avg
      ? runningTotalHtml({ main: anyData(state.day) ? line(state.day) : avg.map(() => 0), last: null, avg },
        { main: name + (isToday ? " so far" : ""), last: "", avg: "Average day" }, isToday ? ((localNow() % DAY) / DAY) * STEPS : null)
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
  hot = "";
  state.day = clampDay(state.day);
  hideTip();
  render();
}

const step = () => (state.period === "day" ? 1 : Number(state.period));
el("prev").addEventListener("click", () => update({ day: state.day - step() }));
el("next").addEventListener("click", () => update({ day: state.day + step() }));

const on = (id, type, fn) => { if (shown(id)) el(id).addEventListener(type, fn); };

// A category button at the top of Trends, or a piece of a Patterns bar:
// highlight that category in every chart
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-toggle]");
  if (!b) return;
  if (b.dataset.toggle === "all") state.only.clear();
  else {
    // The first click highlights a category; more clicks add or remove
    // others; removing the last one shows everything again
    const key = CAT_KEYS.find((k) => String(k) === b.dataset.toggle);
    if (state.only.has(key)) state.only.delete(key); else state.only.add(key);
  }
  update({});
});
// Highlighting a category or app on Today: picking it again clears it
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
  update({ focus: f && f.app === app ? null : { cat: catOf(app), app } });
});
// Clearing the highlight on Today: Esc, or a click anywhere that isn't
// something to pick or a control (an empty part of a chart, a card's
// background, a heading)
const KEEPS_FOCUS = "[data-pick-cat], [data-pick-app], [data-clear], [data-list], [data-view], [data-open-day], [data-day], button, a, input, select, label";
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.focus) update({ focus: null });
});
document.addEventListener("click", (e) => {
  if (PAGE === "today" && state.focus && !e.target.closest(KEEPS_FOCUS)) update({ focus: null });
});
// Hovering an app or category on Today (a timeline block, a piece of an
// hour, a row in the side list) lights up every place it appears, showing
// what a click would highlight
let hot = "";
function setHot(attr) {
  if (attr === hot) return;
  hot = attr;
  const layout = document.querySelector(".side-layout");
  if (!layout) return;
  for (const x of layout.querySelectorAll(".hot")) x.classList.remove("hot");
  layout.classList.toggle("previewing", Boolean(attr));
  if (attr) for (const x of layout.querySelectorAll("[" + attr + "]")) x.classList.add("hot");
}
document.addEventListener("mouseover", (e) => {
  if (PAGE !== "today") return;
  const t = e.target.closest(".side-layout [data-pick-app], .side-layout [data-pick-cat]");
  if (!t) return setHot("");
  setHot(t.dataset.pickApp !== undefined ? 'data-pick-app="' + CSS.escape(t.dataset.pickApp) + '"' : 'data-pick-cat="' + CSS.escape(t.dataset.pickCat) + '"');
});
document.addEventListener("mouseleave", () => setHot(""));
// Hovering a category's piece where a click highlights it (Used today's bar,
// Trends' Patterns) fades the other categories in that chart, showing what
// the click would do
const CAT_CHARTS = "#top-apps, .pattern-box";
let catHover = null; // [chart, key]
document.addEventListener("mouseover", (e) => {
  const piece = e.target.closest?.("[data-cat]");
  const chart = piece?.closest(CAT_CHARTS);
  const next = chart ? [chart, piece.dataset.cat] : null;
  if (catHover && next && catHover[0] === next[0] && catHover[1] === next[1]) return;
  if (catHover) {
    catHover[0].classList.remove("cat-previewing");
    for (const x of catHover[0].querySelectorAll("[data-cat].hot")) x.classList.remove("hot");
  }
  catHover = next;
  if (!next) return;
  chart.classList.add("cat-previewing");
  for (const x of chart.querySelectorAll('[data-cat="' + CSS.escape(next[1]) + '"]')) x.classList.add("hot");
});
// A day's name in Today's Week view shows that day
document.addEventListener("click", (e) => {
  const d = e.target.closest("[data-open-day]");
  if (d) update({ day: Number(d.dataset.openDay), period: "day" });
});
// The Day and Week cards on Today; the side list: Apps or Categories
document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-view]");
  if (v && PAGE === "today") return update({ period: v.dataset.view });
  const l = e.target.closest("[data-list]");
  if (l) update({ list: l.dataset.list });
});
// A day in the bars: on Today it shows that day here; on Trends it opens Today
on("bars", "click", (e) => {
  const target = e.target.closest("[data-day]");
  if (!target) return;
  if (PAGE === "today") update({ day: Number(target.dataset.day), period: "day" });
  else location.href = todayLink(Number(target.dataset.day));
});
// A row in Trends' Top apps opens its app, unless the click was on a link in it
on("trend-apps", "click", (e) => {
  if (e.target.closest("a")) return;
  const row = e.target.closest("[data-href]");
  if (row) location.href = row.dataset.href;
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
  if (shown("legend")) renderLegend();
  if (shown("focus-bar")) renderFocusBar();
  if (shown("timeline")) renderTimeline();
  if (shown("top-apps")) renderLists();
  if (shown("run")) renderRunning();
  if (shown("bars")) renderBars();
  if (shown("trend-apps")) renderTopApps();
}

setDevices();
render();
