// public/common.js
//
// Small pieces shared by the Today and Apps pages: loading the data,
// formatting times and dates, and the hover details.
//
// Times in the data are seconds in your local time zone (shifted so that
// day = Math.floor(seconds / 86400)), so they're read with UTC methods.

export const DAY = 86400;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Loads /api/usage. If it can't, shows why in #content and returns null.
export async function loadUsage() {
  try {
    const res = await fetch("/api/usage");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "The server returned an error.");
    return body;
  } catch (err) {
    const msg = err instanceof TypeError ? "Can't reach the dashboard server. Is npm start still running?" : err.message;
    document.getElementById("content").innerHTML =
      '<div class="notice empty-state"><b>Nothing to show yet</b><span id="load-error"></span></div>';
    document.getElementById("load-error").textContent = msg;
    return null;
  }
}

// ---------- formatting ----------

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 2h 05m, 45m, <1m
export function fmt(secs) {
  const mins = Math.round(secs / 60);
  if (secs > 0 && mins < 1) return "<1m";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}

// "▲ 32m" or "▼ 7m", colored
export function changeHtml(diff, suffix = "") {
  return '<span class="' + (diff < 0 ? "less" : "more") + '">' + (diff < 0 ? "▼ " : "▲ ") + fmt(Math.abs(diff)) + "</span>" + suffix;
}

export const dateOf = (day) => new Date(day * DAY * 1000);
export const fmtDate = (day, options) => dateOf(day).toLocaleDateString("en-US", { timeZone: "UTC", ...options });
export const weekdayOf = (day) => (day + 4) % 7; // 0 = Sunday (day 0 was a Thursday)
export const isoDay = (day) => dateOf(day).toISOString().slice(0, 10);
export const dayFromIso = (text) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) ? Math.floor(Date.parse(text + "T00:00:00Z") / 1000 / DAY) : null;

export function fmtClock(secs) {
  const d = new Date(secs * 1000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? "am" : "pm");
}

export const localNow = () => Date.now() / 1000 - new Date().getTimezoneOffset() * 60;
export const todayIdx = Math.floor(localNow() / DAY);

// ---------- categories ----------
// The data lists your categories in order, each with the color slot you
// picked (0 to 7); an app's cat is an index into that list, or -1 for Other.
// Untracked time isn't an app, so it gets its own key and gray stripes.

export const UNTRACKED_KEY = "untracked";

// All the category keys in display order: yours, then Other, then Untracked
export const categoryKeys = (data) => data.categories.map((_, i) => i).concat([-1, UNTRACKED_KEY]);

export function categoryColor(data, key) {
  if (key === UNTRACKED_KEY) return "var(--untracked-stripes)";
  if (key === -1 || !data.categories[key]) return "var(--cat-other)";
  return "var(--cat-" + (data.categories[key].color + 1) + ")";
}

export function categoryName(data, key) {
  if (key === UNTRACKED_KEY) return "Untracked";
  if (key === -1 || !data.categories[key]) return "Other";
  return data.categories[key].name;
}

// ---------- shared charts ----------
// Used by the Today page and the app and category views on the Apps page.

export const hourName = (h) => (h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : h - 12 + " PM");
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0]; // weekday numbers in Monday-first order

// A line through weekly values, one point per week. weeks is a list of
//   { label, value, low, high, current, chosen, tip, attrs }
// value: the week's number (null for no data). low and high: optional, the
// ends of a gray band behind the point (like the lightest and heaviest day).
// current: this week, not over yet (hollow point, dotted line, "so far").
// chosen: outlined. attrs: extra attributes, which also make the week a button.
// Options: format(value) for the labels, average for a dashed line, and
// floor, the least the top of the chart can be.
export function weekLineHtml(weeks, { format, average = null, floor = 0 } = {}) {
  const n = weeks.length;
  const highs = weeks.filter((w) => w.value !== null).map((w) => w.high ?? w.value);
  const top = Math.max(floor, average ?? 0, ...highs, 0) * 1.08 || 1;
  const pct = (v) => (v / top) * 100;

  // Solid between finished weeks, dotted into this week, with a break
  // wherever a week has no data
  const x = (i) => ((i + 0.5) * 100).toFixed(1);
  const y = (w) => (100 - pct(w.value)).toFixed(2);
  let solid = "", soFar = "";
  weeks.forEach((w, i) => {
    if (w.value === null) return;
    const prev = weeks[i - 1];
    const joined = prev && prev.value !== null;
    if (w.current) { if (joined) soFar = "M" + x(i - 1) + " " + y(prev) + " L" + x(i) + " " + y(w); }
    else solid += (joined ? " L" : " M") + x(i) + " " + y(w);
  });

  const cols = weeks.map((w, i) => {
    const tag = w.attrs ? "button" : "div";
    const band = w.value !== null && w.low !== undefined && w.low !== null
      ? '<span class="week-band" style="bottom:' + pct(w.low).toFixed(2) + "%;height:" + (pct(w.high) - pct(w.low)).toFixed(2) + '%"></span>'
      : "";
    const dot = w.value === null ? "" :
      '<span class="week-dot' + (w.current ? " so-far" : "") + '" style="bottom:' + pct(w.value).toFixed(2) + '%"></span>';
    return "<" + tag + ' class="week-col' + (w.chosen ? " chosen" : "") + (w.attrs ? " clickable" : "") + '" style="left:' +
      (i * 100 / n).toFixed(3) + "%;width:" + (100 / n).toFixed(3) + '%"' + (w.attrs ? " " + w.attrs : ' tabindex="0"') +
      (w.tip ? ' data-tip="' + esc(w.tip) + '"' : "") + ">" + band + dot + "</" + tag + ">";
  });
  const labels = weeks.map((w) =>
    '<div><span class="label' + (w.chosen ? " on" : "") + '">' + esc(w.label) + "</span>" +
    '<span class="time">' + (w.value === null ? "–" : format(w.value)) + (w.current && w.value !== null ? "<small>so far</small>" : "") +
    "</span></div>");
  return '<div class="week-plot">' + cols.join("") +
    '<svg class="week-line" viewBox="0 0 ' + n * 100 + ' 100" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="' + solid.trim() + '"></path><path class="so-far" d="' + soFar + '"></path></svg>' +
    (average === null ? "" : '<div class="avg-line" style="bottom:' + pct(average).toFixed(1) + '%"></div>') +
    "</div>" +
    '<div class="bar-labels week-labels">' + labels.join("") + "</div>";
}

// One shading rule for every grid of hours or days: a cell's share of the
// busiest cell (0 to 1), on a square-root curve so lighter amounts still
// show. color: a category color, or gray without one.
export const heatShade = (share, color = null) =>
  "color-mix(in srgb, " + (color ?? "var(--heat-5)") + " " + Math.round(18 + Math.sqrt(Math.max(0, Math.min(1, share))) * 82) + "%, var(--surface))";

// Weekday by hour: sums[weekday][hour] is the time in that hour over the
// days counted, counts[weekday] how many of each weekday were counted. Shows
// the average per hour. color: a category color, or grays without one.
// chosen: a weekday number to bold.
export function weekdayHourHtml(sums, counts, { color = null, chosen = -1 } = {}) {
  const avg = sums.map((row, w) => row.map((s) => (counts[w] ? s / counts[w] : 0)));
  const max = Math.max(60, ...avg.flat());
  const rows = MON_FIRST.map((w) => {
    const cells = avg[w].map((s, h) => {
      const text = WEEKDAYS[w] + "s, " + hourName(h) + ": " + (counts[w] ? fmt(s) + " on average" : "no data");
      const bg = !counts[w] ? "" : s < 30 ? "background:var(--lane)" : "background:" + heatShade(s / max, color);
      return '<span class="hour-cell' + (counts[w] ? " has" : "") + '" style="' + bg + '" data-tip="' + esc(text) + '"></span>';
    }).join("");
    return '<span class="hour-day' + (w === chosen ? " chosen" : "") + '">' + WEEKDAYS[w].slice(0, 3) + "</span>" +
      '<div class="hour-row">' + cells + "</div>";
  }).join("");
  // The key: about a twentieth, a fifth, two fifths, three fifths, all of the busiest hour
  const keys = [0.05, 0.2, 0.4, 0.6, 1].map((share) =>
    '<span class="cal-key" style="background:' + heatShade(share, color) + '" data-tip="About ' + fmt(share * max) + '"></span>').join("");
  return '<div class="hour-grid">' + rows +
    '<span></span><div class="hour-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>' +
    '<div class="cal-legend"><span>Average per hour, against the busiest (' + fmt(max) + ')</span><span>less ' + keys + " more</span></div>";
}

// ---------- running total through a day ----------
// A day in 15-minute steps; a running total is STEPS + 1 values, from
// midnight (0) to the end of the day.

export const STEPS = 96;
const STEP_SECS = DAY / STEPS;

// Seconds in each 15-minute step of one day. spans: [start, end] pairs in
// local seconds (any that fall outside the day are clipped).
export function stepTotals(spans, day) {
  const bins = new Array(STEPS).fill(0);
  const dayStart = day * DAY, dayEnd = dayStart + DAY;
  for (const [s, e] of spans) {
    for (let t = Math.max(s, dayStart), end = Math.min(e, dayEnd); t < end;) {
      const i = Math.floor((t - dayStart) / STEP_SECS);
      const upTo = Math.min(end, dayStart + (i + 1) * STEP_SECS);
      bins[i] += upTo - t;
      t = upTo;
    }
  }
  return bins;
}

export function runningTotal(bins) {
  const out = [0];
  for (const b of bins) out.push(out[out.length - 1] + b);
  return out;
}

// Lines through the day: the day you're looking at (solid, stopping at
// nowStep if it's still going), the same weekday a week before (gray) and
// the average for that weekday (dashed). lines: { main, last, avg } running
// totals (last and avg may be null); names: their labels for the key.
// nowStep: where "now" is, in steps (with a fraction), or null for a whole day.
// While the day is going, the main line runs to now with everything so far,
// and the others are read at that same moment.
export function runningTotalHtml(lines, names, nowStep = null) {
  const at = (arr) => {
    if (nowStep === null || arr === lines.main) return arr[STEPS];
    const f = Math.min(STEPS - 1, Math.floor(nowStep));
    return arr[f] + (arr[f + 1] - arr[f]) * (nowStep - f);
  };
  const top = Math.max(60, ...[lines.main, lines.last, lines.avg].filter(Boolean).map((a) => a[STEPS]), lines.main[STEPS]) * 1.08;
  const x = (i) => ((i / STEPS) * 1000).toFixed(1);
  const y = (v) => (300 - (v / top) * 300).toFixed(1);
  const path = (arr, upTo = STEPS) => arr.slice(0, Math.floor(upTo) + 1).map((v, i) => (i ? "L" : "M") + x(i) + " " + y(v)).join(" ") +
    (upTo % 1 ? " L" + x(upTo) + " " + y(arr[STEPS]) : "");
  const pct = (v) => ((v / top) * 100).toFixed(2);
  const key = (cls, label, value) => '<span class="run-key ' + cls + '"><span class="run-swatch"></span>' + esc(label) + " <b>" + fmt(value) + "</b></span>";
  return '<div class="run-plot">' +
    '<svg class="run-lines" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">' +
    (lines.avg ? '<path class="avg" d="' + path(lines.avg) + '"></path>' : "") +
    (lines.last ? '<path class="last" d="' + path(lines.last) + '"></path>' : "") +
    '<path class="main" d="' + path(lines.main, nowStep ?? STEPS) + '"></path></svg>' +
    (nowStep === null ? "" : '<span class="run-now" style="left:' + ((nowStep / STEPS) * 100).toFixed(2) + '%"></span>' +
      '<span class="run-dot" style="left:' + ((nowStep / STEPS) * 100).toFixed(2) + "%;bottom:" + pct(lines.main[STEPS]) + '%"></span>') +
    "</div>" +
    '<div class="run-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>' +
    '<div class="run-keys">' + key("main", names.main, at(lines.main)) +
    (lines.last ? key("last", names.last, at(lines.last)) : "") +
    (lines.avg ? key("avg", names.avg, at(lines.avg)) : "") + "</div>";
}

// ---------- the average day for each weekday ----------
// days: [{ total, parts: [[color, secs, name], ...] }] indexed by weekday
// (0 = Sunday), each the average for that weekday, or null with no data.
// label, if given, is the time shown under the bar instead of the total.
// Drawn Monday to Sunday; chosen (a weekday number) is outlined.
export function weekdayBarsHtml(days, { chosen = -1, hint = "" } = {}) {
  const top = Math.max(60, ...days.filter(Boolean).map((d) => d.total)) * 1.08;
  const cols = MON_FIRST.map((w) => {
    const d = days[w];
    const tip = WEEKDAYS[w] + "s" + (hint ? ", " + hint : "") + ": " + (d ? fmt(d.total) + " a day" : "no data") +
      (d ? d.parts.filter((p) => p[1] >= 60).sort((a, b) => b[1] - a[1]).slice(0, 5).map((p) => "\n" + p[2] + " " + fmt(p[1])).join("") : "");
    const stack = d && d.total > 0
      ? '<span class="stack" style="height:' + ((d.total / top) * 100).toFixed(1) + '%">' +
        d.parts.filter((p) => p[1] > 0).map((p) => '<span style="height:' + ((p[1] / d.total) * 100).toFixed(2) + "%;background:" + p[0] + '"></span>').join("") +
        "</span>"
      : '<span class="stack none"></span>';
    return '<div class="bar-col static' + (w === chosen ? " chosen" : "") + '" tabindex="0" data-tip="' + esc(tip) + '">' + stack + "</div>";
  });
  const labels = MON_FIRST.map((w) =>
    '<div><span class="label' + (w === chosen ? " on" : "") + '">' + WEEKDAYS[w].slice(0, 3) + "</span>" +
    '<span class="time">' + (days[w] ? fmt(days[w].label ?? days[w].total) : "–") + "</span></div>");
  return '<div class="bar-plot weekday-plot">' + cols.join("") + "</div>" + '<div class="bar-labels">' + labels.join("") + "</div>";
}

// Adds a stretch of time to sums[weekday][hour], split across the hours it covers
export function addToHours(sums, weekday, start, end) {
  for (let t = start; t < end;) {
    const upTo = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
    sums[weekday][Math.floor((t % DAY) / 3600)] += upTo - t;
    t = upTo;
  }
}

// ---------- hover details ----------
// Anything with data-tip shows it right away on hover, or on keyboard focus.
// The page needs <div class="tip" id="tip" role="tooltip" hidden></div>.

const tip = document.getElementById("tip");

function showTip(el, x, y) {
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = y - h - pad;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
}

export function hideTip() {
  if (tip) tip.hidden = true;
}

if (tip) {
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) showTip(el, e.clientX, e.clientY);
    else hideTip();
  });
  document.addEventListener("mouseleave", hideTip);
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) return hideTip();
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.bottom);
  });
  document.addEventListener("focusout", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });
}
