// public/today.js
//
// The Today page: one day at a time (today unless you pick another), with
// its total, each device, a timeline, the top apps, the week around it and
// a 12-week calendar, each compared with your usual for that weekday.
// Loads /api/usage from the local server (server.mjs).
//
// Times in the data are seconds in your local time zone (shifted so that
// day = Math.floor(seconds / 86400)), so they're read with UTC methods.

import { setupRefresh, showLastArchived } from "./refresh.js";

const DAY = 86400;
const SESSION_GAP = 60;          // uses of the same app less than this apart count as one open
const MAX_TOP_APPS = 8;
const USUAL_MIN_DAYS = 3;        // compare with "your usual" only with at least this many days
const USUAL_MAX_DAYS = 8;        // ...and at most this many (about two months)
const ABOUT_THE_SAME_SECS = 5 * 60;
const MOSTLY_SHARE = 0.6;        // "mostly iPhone" when one device made up this much of the change
const SHOW_CHANGE_SECS = 60;     // app changes smaller than this aren't shown
const DOWN_FROM_USUAL_SECS = 10 * 60;
const UNTRACKED = -1;            // stands in for an app index for untracked time
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

setupRefresh(); // the chosen day is in the address (#2026-10-26), so a reload keeps it

const DATA = await loadData();
if (!DATA) throw new Error("Data didn't load (the message is on the page).");
showLastArchived(DATA.lastArchived);

async function loadData() {
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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmt(secs) {
  const mins = Math.round(secs / 60);
  if (secs > 0 && mins < 1) return "<1m";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}

// "▲ 32m" or "▼ 7m", with a class for its color
function changeHtml(diff, suffix = "") {
  return '<span class="' + (diff < 0 ? "less" : "more") + '">' + (diff < 0 ? "▼ " : "▲ ") + fmt(Math.abs(diff)) + "</span>" + suffix;
}

const dateOf = (day) => new Date(day * DAY * 1000);
const fmtDate = (day, options) => dateOf(day).toLocaleDateString("en-US", { timeZone: "UTC", ...options });
const weekdayOf = (day) => (day + 4) % 7; // 0 = Sunday (day 0 was a Thursday)
const isoDay = (day) => dateOf(day).toISOString().slice(0, 10);
const dayFromIso = (text) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) ? Math.floor(Date.parse(text + "T00:00:00Z") / 1000 / DAY) : null;

function fmtClock(secs) {
  const d = new Date(secs * 1000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? "am" : "pm");
}

const devColor = (dev) => "var(--dev-" + ((dev % 3) + 1) + ")";
const appName = (app) => (app === UNTRACKED ? "Untracked" : DATA.apps[app].name);

// ---------- the data, by day ----------

const localNow = () => Date.now() / 1000 - new Date().getTimezoneOffset() * 60;
const todayIdx = Math.floor(localNow() / DAY);

// How far today's data goes: the last archive run (or now, if unknown)
const dataUntil = (() => {
  if (!DATA.lastArchived) return localNow();
  const t = new Date(DATA.lastArchived);
  return Math.min(localNow(), t.getTime() / 1000 - t.getTimezoneOffset() * 60);
})();

const nDev = DATA.devices.length;
const byDay = new Map();

function dayEntry(day) {
  if (!byDay.has(day)) {
    byDay.set(day, {
      app: new Array(nDev).fill(0),   // seconds in apps, per device
      gap: new Array(nDev).fill(0),   // untracked seconds, per device
      opens: new Array(nDev).fill(0),
      apps: new Map(),                // app index -> { secs, devs }
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
  if (!e.apps.has(app)) e.apps.set(app, { secs: 0, devs: new Set() });
  const a = e.apps.get(app);
  a.secs += end - start;
  a.devs.add(dev);
  e.items.push([dev, app, start, end]);
}

// Join back-to-back uses of the same app into one session (one "open").
// The server sends segs sorted by device, then start time.
{
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const e = dayEntry(Math.floor(cur[2] / DAY));
    e.sessions.push(cur);
    e.opens[cur[0]]++;
  };
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

const hasData = (day, dev) => (byDay.get(day)?.app[dev] ?? 0) > 0;
const anyData = (day) => DATA.devices.some((_, dev) => hasData(day, dev));
const complete = (day) => nDev > 0 && DATA.devices.every((_, dev) => hasData(day, dev));
const deviceTotal = (day, dev) => { const e = byDay.get(day); return e ? e.app[dev] + e.gap[dev] : 0; };
const total = (day) => DATA.devices.reduce((sum, _, dev) => sum + deviceTotal(day, dev), 0);
const firstDay = byDay.size ? Math.min(...byDay.keys()) : todayIdx;

// ---------- "your usual" ----------
//
// The same weekday in earlier weeks, using only days with data from every
// device (a day missing the iPhone would make "usual" look too low). For
// today, each of those days counts only up to the same time of day.
// Everything that says "usual" (the headline, each device, each app, the
// week chart) uses this one set of days, so they always agree.

const usualCache = new Map();

function usualFor(day) {
  if (usualCache.has(day)) return usualCache.get(day);
  const cutoffInDay = day === todayIdx ? dataUntil - day * DAY : DAY;
  const days = [];
  for (let d = day - 7; d >= firstDay && days.length < USUAL_MAX_DAYS; d -= 7) if (complete(d)) days.push(d);
  let result = null;
  if (days.length >= USUAL_MIN_DAYS) {
    let sum = 0;
    const perDevice = new Array(nDev).fill(0), perApp = new Map();
    for (const d of days) {
      const cutoff = d * DAY + cutoffInDay;
      for (const [dev, app, start, end] of byDay.get(d).items) {
        const secs = Math.max(0, Math.min(end, cutoff) - start);
        sum += secs;
        perDevice[dev] += secs;
        perApp.set(app, (perApp.get(app) ?? 0) + secs);
      }
    }
    const n = days.length;
    result = {
      days: n,
      total: sum / n,
      device: perDevice.map((s) => s / n),
      app: new Map([...perApp].map(([app, s]) => [app, s / n])),
    };
  }
  usualCache.set(day, result);
  return result;
}

// Seconds per app on a day (UNTRACKED included)
function appTotals(day) {
  const out = new Map();
  for (const [, app, start, end] of byDay.get(day)?.items ?? []) out.set(app, (out.get(app) ?? 0) + end - start);
  return out;
}

// ---------- the chosen day ----------

// The calendar's first day (a Monday, 11 weeks before this week's Monday).
// You can go back to it or to your first day of data, whichever is earlier.
const calendarStart = todayIdx - (weekdayOf(todayIdx) + 6) % 7 - 11 * 7;
const lowestDay = Math.min(firstDay, calendarStart);
const clampDay = (d) => Math.max(lowestDay, Math.min(todayIdx, d));
let day = clampDay(dayFromIso(decodeURIComponent(location.hash.slice(1))) ?? todayIdx);

function selectDay(d) {
  day = clampDay(d);
  history.replaceState(null, "", day === todayIdx ? location.pathname : "#" + isoDay(day));
  hideTip();
  render();
}

document.getElementById("prev-day").addEventListener("click", () => selectDay(day - 1));
document.getElementById("next-day").addEventListener("click", () => selectDay(day + 1));

// ---------- sections ----------

function renderHero() {
  const relative = day === todayIdx ? "Today" : day === todayIdx - 1 ? "Yesterday" : "";
  const sameYear = dateOf(day).getUTCFullYear() === dateOf(todayIdx).getUTCFullYear();
  const year = sameYear ? {} : { year: "numeric" };
  const long = fmtDate(day, { weekday: "long", month: "long", day: "numeric", ...year });
  const short = fmtDate(day, { weekday: "short", month: "short", day: "numeric", ...year });
  // The short date is for narrow screens (see today.css)
  document.getElementById("day-label").innerHTML = (relative ? '<span class="relative">' + relative + " · </span>" : "") +
    '<span class="date-long">' + esc(long) + '</span><span class="date-short">' + esc(short) + "</span>";
  document.getElementById("prev-day").disabled = day <= lowestDay;
  document.getElementById("next-day").disabled = day >= todayIdx;

  const totalEl = document.getElementById("day-total");
  totalEl.textContent = anyData(day) ? fmt(total(day)) : "No data";
  totalEl.classList.toggle("none", !anyData(day));

  const compare = document.getElementById("day-compare");
  compare.removeAttribute("data-tip");
  const weekday = WEEKDAYS[weekdayOf(day)];
  if (!anyData(day)) {
    compare.textContent = day < firstDay
      ? "This is before the tracker started saving data."
      : day === todayIdx ? "Nothing archived yet today. Click Refresh to save the latest." : "Nothing was archived for this day.";
    return;
  }
  if (!complete(day)) {
    const missing = DATA.devices.filter((_, dev) => !hasData(day, dev));
    const present = DATA.devices.filter((_, dev) => hasData(day, dev));
    compare.textContent = "No " + missing.join(" or ") + " data " + (day === todayIdx ? "yet today" : "for this day") +
      ", so this is " + present.join(" and ") + " only.";
    return;
  }
  const u = usualFor(day);
  if (!u) {
    compare.textContent = "Not enough history yet to compare with your usual " + weekday + ".";
    return;
  }
  const diff = total(day) - u.total;
  const when = day === todayIdx ? " by this time of day" : "";
  compare.dataset.tip = "Your usual " + weekday + ": " + fmt(u.total) + when + ".\nThe average of the last " + u.days + " " +
    weekday + "s with data from all your devices.";
  if (Math.abs(diff) < ABOUT_THE_SAME_SECS) {
    compare.textContent = "About the same as your usual " + weekday + when + ".";
    return;
  }
  // Which device made the difference
  let why = "";
  if (nDev > 1) {
    const diffs = DATA.devices.map((_, dev) => deviceTotal(day, dev) - u.device[dev]);
    const top = diffs.reduce((best, d, dev) => (d * Math.sign(diff) > diffs[best] * Math.sign(diff) ? dev : best), 0);
    why = diffs[top] / diff >= MOSTLY_SHARE ? ", mostly on " + esc(DATA.devices[top]) : ", spread across your devices";
  }
  compare.innerHTML = '<span class="' + (diff < 0 ? "less" : "more") + '">' + fmt(Math.abs(diff)) + " " +
    (diff < 0 ? "less" : "more") + "</span> than your usual " + weekday + when + why + ".";
}

function renderDevices() {
  const e = byDay.get(day);
  const u = complete(day) ? usualFor(day) : null;
  document.getElementById("device-cards").innerHTML = DATA.devices.map((name, dev) => {
    const has = hasData(day, dev);
    const opens = e?.opens[dev] ?? 0;
    const gap = e?.gap[dev] ?? 0;
    let change = "&nbsp;";
    if (has && u) {
      const diff = deviceTotal(day, dev) - u.device[dev];
      change = Math.abs(diff) < ABOUT_THE_SAME_SECS ? "About usual" : changeHtml(diff, " vs usual");
    } else if (has) {
      change = '<span class="muted">No usual yet</span>';
    }
    // The same four lines every day, so the card stays the same size
    return '<div class="device-card">' +
      '<div class="name"><span class="dot" style="background:' + devColor(dev) + '"></span>' + esc(name) + "</div>" +
      (has ? '<div class="value">' + fmt(deviceTotal(day, dev)) + "</div>" : '<div class="value none">No data</div>') +
      '<div class="change">' + change + "</div>" +
      '<div class="sub">' + (has ? opens + (opens === 1 ? " open" : " opens") + (gap >= 60 ? " · " + fmt(gap) + " untracked" : "") : "&nbsp;") + "</div>" +
      "</div>";
  }).join("");
}

function renderTimeline() {
  const e = byDay.get(day);
  const start = day * DAY;
  const pos = (from, to) => "left:" + (((from - start) / DAY) * 100).toFixed(3) + "%;width:" + (((to - from) / DAY) * 100).toFixed(3) + "%";
  const lanes = DATA.devices.map((name, dev) => {
    const sessions = (e?.sessions ?? []).filter((s) => s[0] === dev);
    const gaps = (e?.gaps ?? []).filter((g) => g[0] === dev);
    if (!sessions.length && !gaps.length) {
      return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track no-data">No data</div></div>';
    }
    const blocks = sessions.map(([, app, from, to, active]) =>
      '<div class="block" style="' + pos(from, to) + ";background:" + devColor(dev) + '" data-tip="' +
      esc(appName(app) + "\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(active)) + '"></div>');
    const gapBlocks = gaps.map(([, from, to, hint]) => {
      const before = hint.length ? "\nLast opened: " + hint.map(([app, at]) => appName(app) + " at " + fmtClock(at)).join(", ") : "";
      return '<div class="block gap" style="' + pos(from, to) + '" data-tip="' +
        esc("Screen on, no app recorded\n" + fmtClock(from) + " to " + fmtClock(to) + " · " + fmt(to - from) + before) + '"></div>';
    });
    return '<div class="lane"><span class="lane-name">' + esc(name) + '</span><div class="lane-track">' +
      blocks.join("") + gapBlocks.join("") + "</div></div>";
  });
  document.getElementById("timeline").innerHTML = lanes.join("") +
    '<div class="hours"><span></span><div><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>';
}

function renderTopApps() {
  const e = byDay.get(day);
  const el = document.getElementById("top-apps");
  const hint = document.getElementById("apps-hint");
  const u = complete(day) ? usualFor(day) : null;
  hint.textContent = u ? "▲▼ vs your usual " + WEEKDAYS[weekdayOf(day)] : "";
  if (!e || !anyData(day)) {
    el.innerHTML = '<p class="hint">No apps recorded on this day.</p>';
    return;
  }
  const totals = appTotals(day);
  const rows = [...totals].filter(([app, secs]) => app !== UNTRACKED || secs >= 60).map(([app, secs]) => ({
    app,
    secs,
    where: app === UNTRACKED
      ? "Screen on, no app recorded"
      : [...e.apps.get(app).devs].sort((x, y) => x - y).map((dev) => DATA.devices[dev]).join(" and "),
  }));
  rows.sort((a, b) => b.secs - a.secs);
  const shown = rows.slice(0, MAX_TOP_APPS);
  const max = shown[0].secs;
  el.innerHTML = shown.map((r) => {
    const diff = u ? r.secs - (u.app.get(r.app) ?? 0) : 0;
    return '<div class="app-row"><div class="app-name"><b>' + esc(appName(r.app)) + "</b><span>" + esc(r.where) + "</span></div>" +
      '<div class="bar-track"><div class="bar-fill' + (r.app === UNTRACKED ? " gap" : "") + '" style="width:' + ((r.secs / max) * 100).toFixed(1) + '%"></div></div>' +
      '<div class="app-time"><span>' + fmt(r.secs) + "</span>" +
      (Math.abs(diff) >= SHOW_CHANGE_SECS ? '<span class="app-change">' + changeHtml(diff) + "</span>" : '<span class="app-change">&nbsp;</span>') +
      "</div></div>";
  }).join("");

  // Apps you usually use a lot that barely showed up, so a "less than
  // usual" day has its explanation too
  let down = "";
  if (u) {
    const shownApps = new Set(shown.map((r) => r.app));
    const drops = [...u.app]
      .filter(([app]) => !shownApps.has(app))
      .map(([app, usual]) => ({ app, diff: (totals.get(app) ?? 0) - usual }))
      .filter((d) => d.diff <= -DOWN_FROM_USUAL_SECS)
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 3);
    if (drops.length) {
      down = '<div class="down"><p class="down-title">Less than usual</p>' +
        drops.map((d) => '<div class="down-row"><span>' + esc(appName(d.app)) + "</span>" + changeHtml(d.diff) + "</div>").join("") +
        "</div>";
    }
  }
  el.innerHTML += (rows.length > shown.length ? '<p class="hint">and ' + (rows.length - shown.length) + " more</p>" : "") + down;
}

function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => day - 6 + i);
  // Average of complete days in the 30 days up to the chosen one (today is
  // left out while it's still going)
  const pool = Array.from({ length: 30 }, (_, i) => day - i).filter((d) => d !== todayIdx && complete(d));
  const avg = pool.length ? pool.reduce((sum, d) => sum + total(d), 0) / pool.length : null;
  document.getElementById("week-average").textContent = avg === null ? "" : "30-day average " + fmt(avg);

  const usuals = days.map((d) => (anyData(d) ? usualFor(d) : null));
  const top = Math.max(3600, ...days.map(total), ...usuals.map((u) => u?.total ?? 0)) * 1.05;
  let anyPartial = false, anyUsual = false;
  document.getElementById("week").innerHTML = days.map((d, i) => {
    const has = anyData(d);
    const partial = has && !complete(d);
    if (partial) anyPartial = true;
    const t = total(d);
    const u = usuals[i];
    if (u) anyUsual = true;
    const label = d === todayIdx ? "Today" : fmtDate(d, { weekday: "short" });
    const long = fmtDate(d, { weekday: "long", month: "short", day: "numeric" });
    const tip = long + ": " + (has ? fmt(t) : "no data") +
      (partial ? "\nMissing data from a device" : "") +
      (u ? "\nYour usual " + WEEKDAYS[weekdayOf(d)] + ": " + fmt(u.total) + (d === todayIdx ? " by this time" : "") : "");
    return '<button class="week-day" data-day="' + d + '" aria-pressed="' + (d === day) + '" aria-label="' + esc(tip.replace(/\n/g, ". ")) +
      '" data-tip="' + esc(tip) + '">' +
      // The usual is a light column behind the day's (narrower) bar
      '<div class="bar-area">' +
      (u ? '<div class="usual-col" style="height:' + ((u.total / top) * 100).toFixed(1) + '%"></div>' : "") +
      (has ? '<div class="bar' + (partial ? " partial" : "") + '" style="height:' + ((t / top) * 100).toFixed(1) + '%"></div>' : '<div class="bar none"></div>') +
      "</div>" +
      '<span class="label">' + esc(label) + "</span>" +
      '<span class="time">' + (has ? fmt(t) : "–") + "</span></button>";
  }).join("");
  const notes = [];
  if (anyUsual) notes.push('<span class="usual-key"></span>your usual for that weekday');
  if (anyPartial) notes.push("striped bars are missing data from a device");
  document.getElementById("week-note").innerHTML = notes.length ? notes.join(" · ") : "";
}

// Calendar shades come from your own days, so they show your lighter and
// heavier days whatever your usual amount is: each shade is about a fifth of
// your days, with the limits rounded to the half hour. Until there are a
// few days, fixed steps (2h, 4h, 6h, 8h) are used.
const HEAT_STEPS = (() => {
  const values = [...byDay.keys()].filter(anyData).map(total).sort((a, b) => a - b);
  if (values.length < 10) return [2, 4, 6, 8].map((h) => h * 3600);
  const at = (share) => values[Math.min(values.length - 1, Math.floor(share * values.length))];
  const steps = [0.2, 0.4, 0.6, 0.8].map((share) => Math.max(1800, Math.round(at(share) / 1800) * 1800));
  for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1]) steps[i] = steps[i - 1] + 1800;
  return steps;
})();

function heatLevel(secs) {
  const step = HEAT_STEPS.findIndex((limit) => secs < limit);
  return step === -1 ? 5 : step + 1;
}

function renderCalendar() {
  const start = calendarStart;
  const cols = [];
  const months = [];
  for (let w = 0; w < 12; w++) {
    const colStart = start + w * 7;
    const month = fmtDate(colStart, { month: "short" });
    months.push(w === 0 || month !== fmtDate(colStart - 7, { month: "short" }) ? month : "");
    let cells = "";
    for (let i = 0; i < 7; i++) {
      const d = colStart + i;
      const label = fmtDate(d, { weekday: "short", month: "short", day: "numeric" });
      if (d > todayIdx) {
        cells += '<span class="cal-day future" aria-hidden="true"></span>';
      } else if (!anyData(d)) {
        cells += '<button class="cal-day empty" data-day="' + d + '" aria-pressed="' + (d === day) + '" data-tip="' +
          esc(label + "\nNo data") + '" aria-label="' + esc(label + ": no data") + '"></button>';
      } else {
        const text = label + "\n" + fmt(total(d)) + (complete(d) ? "" : "\nMissing data from a device");
        cells += '<button class="cal-day" data-day="' + d + '" aria-pressed="' + (d === day) + '" style="background:var(--heat-' +
          heatLevel(total(d)) + ')" data-tip="' + esc(text) + '" aria-label="' + esc(text.replace(/\n/g, ", ")) + '"></button>';
      }
    }
    cols.push('<div class="cal-week">' + cells + "</div>");
  }
  const keys = [1, 2, 3, 4, 5].map((n, i) =>
    '<span class="cal-key" style="background:var(--heat-' + n + ')" data-tip="' +
    (i === 0 ? "Under " + fmt(HEAT_STEPS[0]) : i === 4 ? fmt(HEAT_STEPS[3]) + " or more" : fmt(HEAT_STEPS[i - 1]) + " to " + fmt(HEAT_STEPS[i])) +
    '"></span>').join("");
  document.getElementById("calendar").innerHTML =
    '<div class="calendar">' +
    '<div class="cal-weekdays"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div>' +
    '<div class="cal-weeks">' + cols.join("") + "</div>" +
    "<span></span>" +
    '<div class="cal-months">' + months.map((m) => "<span>" + esc(m) + "</span>").join("") + "</div>" +
    "</div>" +
    '<div class="cal-legend" style="margin-top:12px">' +
    '<span><span class="cal-key empty"></span>No data archived (before the tracker started, or a missed day)</span>' +
    "<span>less " + keys + " more</span></div>";
}

// Clicking a day in the week or the calendar shows it
for (const id of ["week", "calendar"]) {
  document.getElementById(id).addEventListener("click", (e) => {
    const target = e.target.closest("[data-day]");
    if (target) selectDay(Number(target.dataset.day));
  });
}

// ---------- hover details ----------
// Anything with data-tip shows it right away on hover, or on keyboard focus.

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

function hideTip() {
  tip.hidden = true;
}

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

function render() {
  renderHero();
  renderDevices();
  renderTimeline();
  renderTopApps();
  renderWeek();
  renderCalendar();
}

render();
