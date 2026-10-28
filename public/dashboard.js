// public/dashboard.js
//
// The dashboard page. Loads your usage from the local server (server.mjs)
// and draws everything in the browser. Chart.js is loaded by index.html.

const DATA = await loadData();
if (!DATA) throw new Error("Dashboard data didn't load (the message is on the page).");

async function loadData() {
  try {
    const res = await fetch("/api/usage");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "The server returned an error.");
    return body;
  } catch (err) {
    const msg = err instanceof TypeError ? "Can't reach the dashboard server. Is npm start still running?" : err.message;
    document.querySelector("main").innerHTML =
      "<nav class=\"nav\"><a href=\"/\" aria-current=\"page\">Dashboard</a><a href=\"/apps\">Apps</a></nav>" +
      "<h1>Screen Time</h1><p class=\"card error\"></p>";
    document.querySelector(".error").textContent = msg;
    return null;
  }
}

const DAY = 86400;
const SESSION_GAP = 60; // seconds between uses of the same app that still count as one open
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RANGES = [["7", "7 days"], ["14", "14 days"], ["30", "30 days"], ["all", "All time"]];
const OTHER = -1;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const deviceColor = (i) => css("--dev-" + (i + 1)) || css("--dev-1");
// Categories come in your order, each with the color you picked (0 to 7)
const catColor = (c) => (c === OTHER ? css("--cat-other") : css("--cat-" + (DATA.categories[c].color + 1)));
const catName = (c) => (c === OTHER ? "Other" : DATA.categories[c].name);
const CAT_ORDER = DATA.categories.map((_, i) => i).concat([OTHER]);

const state = { range: "30", device: "all", colorBy: "category", detail: null, sort: "time", showAllApps: false };
let charts = [];

// ---------- formatting ----------
function fmt(secs) {
  if (secs === null || secs === undefined) return "no data";
  const mins = Math.round(secs / 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h && !m && secs > 0) return "<1m";
  return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}
function dayDate(dayIdx) { return new Date(dayIdx * DAY * 1000); }
function fmtDay(dayIdx, long) {
  return dayDate(dayIdx).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", ...(long ? { weekday: "short" } : {}),
  });
}
function fmtClock(secs) {
  const d = new Date(secs * 1000);
  let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h < 12 ? "am" : "pm"; h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + ap;
}
function fmtHourLabel(h) { return h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p"; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function sw(color) { return '<span class="swatch" style="background:' + color + '"></span>'; }

// ---------- precomputed data ----------
const todayIdx = (() => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return Math.floor(local.getTime() / 1000 / DAY);
})();
const firstDataIdx = DATA.segs.length ? Math.min(...DATA.segs.map((s) => Math.floor(s[2] / DAY))) : todayIdx;

// Days each device has any data for
const deviceDays = DATA.devices.map(() => new Set());
const dayTotals = DATA.devices.map(() => new Map()); // seconds per day, per device
for (const s of DATA.segs) {
  const d = Math.floor(s[2] / DAY);
  deviceDays[s[0]].add(d);
  dayTotals[s[0]].set(d, (dayTotals[s[0]].get(d) ?? 0) + s[3] - s[2]);
}

// Untracked seconds per day, per device
const gapTotals = DATA.devices.map(() => new Map());
for (const g of DATA.gaps) {
  const d = Math.floor(g[1] / DAY);
  gapTotals[g[0]].set(d, (gapTotals[g[0]].get(d) ?? 0) + g[2] - g[1]);
}
const untrackedOn = (day) => selectedDevices().reduce((a, dev) => a + (gapTotals[dev].get(day) ?? 0), 0);

// Diagonal stripes for "Untracked" bars, matching the timeline blocks
function hatchPattern() {
  const c = document.createElement("canvas");
  c.width = c.height = 6;
  const ctx = c.getContext("2d");
  ctx.strokeStyle = css("--untracked");
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 6); ctx.lineTo(6, 0);
  ctx.moveTo(-1, 1); ctx.lineTo(1, -1);
  ctx.moveTo(5, 7); ctx.lineTo(7, 5);
  ctx.stroke();
  return ctx.createPattern(c, "repeat");
}

// Sessions: join back-to-back uses of the same app on the same device.
// [dev, app, start, end, activeSecs]
const SESSIONS = (() => {
  const out = [];
  let cur = null;
  for (const s of DATA.segs) {
    if (cur && cur[0] === s[0] && cur[1] === s[1] && s[2] - cur[3] <= SESSION_GAP) {
      cur[3] = Math.max(cur[3], s[3]); cur[4] += s[3] - s[2];
    } else {
      if (cur) out.push(cur);
      cur = [s[0], s[1], s[2], s[3], s[3] - s[2]];
    }
  }
  if (cur) out.push(cur);
  return out;
})();

// ---------- filters ----------
function selectedDevices() {
  return state.device === "all" ? DATA.devices.map((_, i) => i) : [Number(state.device)];
}
function rangeDays() {
  const start = state.range === "all" ? Math.min(firstDataIdx, todayIdx) : todayIdx - Number(state.range) + 1;
  const days = [];
  for (let d = start; d <= todayIdx; d++) days.push(d);
  return days;
}
function inRange(list, days, startIdx) {
  const devs = new Set(selectedDevices());
  const lo = days[0], hi = days[days.length - 1];
  return list.filter((s) => {
    const d = Math.floor(s[startIdx] / DAY);
    return devs.has(s[0]) && d >= lo && d <= hi;
  });
}
function showDeviceNames() { return selectedDevices().length > 1; }
function appLabel(appIdx, devIdx) {
  const name = DATA.apps[appIdx].name;
  return showDeviceNames() ? name + " (" + DATA.devices[devIdx] + ")" : name;
}

function segButtons(el, options, current, onPick) {
  el.innerHTML = options.map(([v, label]) =>
    '<button data-v="' + v + '" aria-pressed="' + (current === v) + '">' + esc(label) + "</button>").join("");
  el.onclick = (e) => { const v = e.target.dataset.v; if (v) onPick(v); };
}
function renderFilters() {
  segButtons(document.getElementById("range-filter"), RANGES, state.range,
    (v) => { state.range = v; state.detail = null; render(); });
  segButtons(document.getElementById("device-filter"),
    [["all", "All devices"]].concat(DATA.devices.map((d, i) => [String(i), d])), state.device,
    (v) => { state.device = v; state.detail = null; render(); });
  segButtons(document.getElementById("color-filter"), [["category", "By category"], ["device", "By device"]],
    state.colorBy, (v) => { state.colorBy = v; render(); });
}

// ---------- tooltip for non-chart elements ----------
const tip = document.getElementById("tip");
function showTip(e, html) {
  tip.innerHTML = html; tip.style.display = "block";
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 12 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 8 : e.clientY + 12;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { tip.style.display = "none"; }

// ---------- chart styling ----------
function baseOptions() {
  return {
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--surface"), titleColor: css("--ink"), bodyColor: css("--ink-2"),
        footerColor: css("--muted"), borderColor: css("--grid"), borderWidth: 1, padding: 10, boxPadding: 4,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: css("--axis") },
           ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } },
      y: { grid: { color: css("--grid") }, border: { display: false }, beginAtZero: true,
           ticks: { callback: (v) => v + "h" } },
    },
  };
}
const toHours = (secs) => (secs === null ? null : Math.round((secs / 3600) * 100) / 100);
function openDetail(detail) {
  state.detail = detail;
  render();
  document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- main render ----------
function render() {
  charts.forEach((c) => c.destroy()); charts = [];
  hideTip();
  renderFilters();

  const days = rangeDays();
  const segs = inRange(DATA.segs, days, 2);
  const sessions = inRange(SESSIONS, days, 2);

  document.getElementById("range-text").textContent = fmtDay(days[0]) + " to " + fmtDay(days[days.length - 1]);

  const daily = selectedDevices().map((dev) => {
    const byDay = new Map();
    for (const s of segs) if (s[0] === dev) {
      const d = Math.floor(s[2] / DAY);
      byDay.set(d, (byDay.get(d) ?? 0) + (s[3] - s[2]));
    }
    return { dev, values: days.map((d) => (deviceDays[dev].has(d) ? byDay.get(d) ?? 0 : null)) };
  });

  renderCoverage(days);
  renderTiles(daily, days);
  renderDaily(days, segs, daily);
  renderAppsTable(segs, sessions, days);
  renderHeatmap(segs);
  renderTable(days, daily);
  renderDetail(days);
}

// ---------- coverage ----------
function missingRanges(dev, days) {
  const ranges = [];
  let start = null;
  for (const d of days) {
    if (!deviceDays[dev].has(d)) { if (start === null) start = d; }
    else if (start !== null) { ranges.push([start, d - 1]); start = null; }
  }
  if (start !== null) ranges.push([start, days[days.length - 1]]);
  return ranges;
}
function renderCoverage(days) {
  const el = document.getElementById("coverage");
  const cols = "repeat(" + days.length + ", minmax(0, 1fr))";
  let html = "";
  for (const dev of selectedDevices()) {
    html += '<div class="cov-row"><div class="cov-name">' + sw(deviceColor(dev)) + esc(DATA.devices[dev]) +
      '</div><div class="cov-days" style="grid-template-columns:' + cols + '">';
    for (const d of days) {
      const has = deviceDays[dev].has(d);
      html += '<div class="cov-day' + (has ? "" : " none") + '" data-dev="' + dev + '" data-day="' + d + '"' +
        (has ? ' style="background:' + deviceColor(dev) + '"' : "") + "></div>";
    }
    html += "</div></div>";
  }
  // Date labels: about 6 across
  const step = Math.max(1, Math.ceil(days.length / 6));
  html += '<div class="cov-axis" style="grid-template-columns:' + cols + '">' +
    days.map((d, i) => "<span>" + (i % step === 0 ? fmtDay(d) : "") + "</span>").join("") + "</div>";

  html += '<div class="cov-legend"><span><i style="background:var(--ink-2)"></i>Has data</span>' +
    '<span><i style="border:1.5px dashed var(--axis)"></i>No data</span></div>';

  html += '<div class="cov-summary">' + selectedDevices().map((dev) => {
    const have = days.filter((d) => deviceDays[dev].has(d)).length;
    const gaps = missingRanges(dev, days);
    const gapText = gaps.length
      ? "Missing " + gaps.map(([a, b]) => (a === b ? fmtDay(a) : fmtDay(a) + " to " + fmtDay(b))).join(", ")
      : "No gaps";
    return "<div><b>" + esc(DATA.devices[dev]) + ":</b> " + have + " of " + days.length + " days. " + gapText + "</div>";
  }).join("") + "</div>";

  el.innerHTML = html;
  el.onclick = (e) => {
    const c = e.target.closest(".cov-day"); if (!c) return;
    openDetail({ type: "day", day: Number(c.dataset.day) });
  };
  el.onmousemove = (e) => {
    const c = e.target.closest(".cov-day"); if (!c) return hideTip();
    const dev = Number(c.dataset.dev), d = Number(c.dataset.day);
    showTip(e, "<b>" + fmtDay(d, true) + "</b><br>" + esc(DATA.devices[dev]) + ": " +
      (deviceDays[dev].has(d) ? fmt(dayTotals[dev].get(d)) : "no data"));
  };
  el.onmouseleave = hideTip;
}

// ---------- tiles ----------
function renderTiles(daily, days) {
  document.getElementById("tiles").innerHTML = daily.map(({ dev, values }) => {
    const tracked = values.filter((v) => v !== null);
    const avg = tracked.length ? tracked.reduce((a, b) => a + b, 0) / tracked.length : null;
    const gapSecs = days.reduce((a, d) => a + (gapTotals[dev].get(d) ?? 0), 0);
    const gapNote = gapSecs >= 60 ? ", plus " + fmt(gapSecs / Math.max(1, tracked.length)) + " a day untracked" : "";
    return '<div class="tile"><div class="k">' + sw(deviceColor(dev)) + esc(DATA.devices[dev]) +
      ' daily average</div><div class="v">' + (avg === null ? "none" : fmt(avg)) +
      '</div><div class="n">across ' + tracked.length + (tracked.length === 1 ? " day" : " days") + " with data" + gapNote + "</div></div>";
  }).join("");
}

// ---------- daily chart ----------
function renderDaily(days, segs, daily) {
  const dayPos = new Map(days.map((d, i) => [d, i]));
  let datasets;

  if (state.colorBy === "device") {
    datasets = daily.map(({ dev, values }) => ({
      label: DATA.devices[dev], data: values.map(toHours), backgroundColor: deviceColor(dev),
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start",
      borderColor: css("--surface"), borderWidth: { left: 1, right: 1 },
      maxBarThickness: 18, categoryPercentage: 0.8, barPercentage: 0.9,
    }));
  } else {
    // One stacked bar per day, segments by category, devices added together
    const byCat = new Map(CAT_ORDER.map((c) => [c, new Array(days.length).fill(0)]));
    for (const s of segs) {
      const c = DATA.apps[s[1]].cat;
      byCat.get(c)[dayPos.get(Math.floor(s[2] / DAY))] += s[3] - s[2];
    }
    const anyData = days.map((d) => selectedDevices().some((dev) => deviceDays[dev].has(d)));
    datasets = CAT_ORDER.filter((c) => byCat.get(c).some((v) => v > 0)).map((c) => ({
      label: catName(c),
      data: byCat.get(c).map((v, i) => (anyData[i] ? toHours(v) : null)),
      backgroundColor: catColor(c), stack: "all",
      borderColor: css("--surface"), borderWidth: { top: 1, left: 0, right: 0, bottom: 0 }, borderSkipped: "bottom",
      maxBarThickness: 22, categoryPercentage: 0.85,
    }));
    // Untracked time on top, hatched, so it reads as "not an app"
    const gapRow = days.map((d, i) => (anyData[i] ? untrackedOn(d) : 0));
    if (gapRow.some((v) => v > 0)) {
      datasets.push({
        label: "Untracked", data: gapRow.map((v, i) => (anyData[i] ? toHours(v) : null)),
        backgroundColor: hatchPattern(), stack: "all",
        borderColor: css("--untracked"), borderWidth: 1, borderSkipped: "bottom",
        maxBarThickness: 22, categoryPercentage: 0.85,
      });
    }
    // Round only the top segment of each stack
    const topIdx = days.map((_, i) => { let t = -1; datasets.forEach((ds, j) => { if (ds.data[i]) t = j; }); return t; });
    datasets.forEach((ds, j) => {
      ds.borderRadius = (ctx) => (topIdx[ctx.dataIndex] === j ? { topLeft: 4, topRight: 4 } : 0);
    });
  }

  const options = baseOptions();
  options.interaction = { mode: "index", intersect: false };
  options.plugins.legend = {
    display: datasets.length > 1, position: "top", align: "start",
    labels: { color: css("--ink-2"), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
  };
  options.plugins.tooltip.filter = (item) => item.raw !== null && item.raw > 0;
  options.plugins.tooltip.itemSort = (a, b) => b.raw - a.raw;
  options.plugins.tooltip.callbacks = {
    title: (items) => fmtDay(days[items[0].dataIndex], true),
    label: (item) => " " + item.dataset.label + ": " + fmt(item.raw * 3600),
    footer: (items) => {
      const i = items.length ? items[0].dataIndex : 0;
      const missing = selectedDevices().filter((dev) => !deviceDays[dev].has(days[i])).map((dev) => DATA.devices[dev]);
      const lines = [];
      if (state.colorBy === "category") {
        const total = daily.reduce((a, { values }) => a + (values[i] ?? 0), 0);
        lines.push("Total in apps: " + fmt(total));
      }
      const gap = untrackedOn(days[i]);
      if (gap >= 60 && state.colorBy === "device") lines.push("Untracked: " + fmt(gap));
      if (missing.length) lines.push("No data: " + missing.join(", "));
      lines.push("Click for timeline");
      return lines;
    },
  };
  options.scales.x.stacked = state.colorBy === "category";
  options.scales.y.stacked = state.colorBy === "category";
  options.onClick = (evt, els, chart) => {
    const pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
    if (pts.length) openDetail({ type: "day", day: days[pts[0].index] });
  };
  options.onHover = (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; };

  charts.push(new Chart(document.getElementById("daily"), {
    type: "bar",
    data: { labels: days.map((d) => fmtDay(d)), datasets },
    options,
  }));
}

// ---------- apps table ----------
function appStats(segs, sessions) {
  const stats = new Map();
  const get = (dev, app) => {
    const key = dev + "|" + app;
    if (!stats.has(key)) stats.set(key, { dev, app, time: 0, opens: 0, longest: 0, days: new Set() });
    return stats.get(key);
  };
  for (const s of segs) { const st = get(s[0], s[1]); st.time += s[3] - s[2]; st.days.add(Math.floor(s[2] / DAY)); }
  for (const s of sessions) { const st = get(s[0], s[1]); st.opens++; st.longest = Math.max(st.longest, s[4]); }
  return [...stats.values()].map((st) => ({ ...st, avg: st.opens ? st.time / st.opens : 0 }));
}
function renderAppsTable(segs, sessions, days) {
  const cols = [
    ["time", "Time"], ["opens", "Opens"], ["avg", "Avg session"], ["longest", "Longest"], ["days", "Days used"],
  ];
  const rows = appStats(segs, sessions).sort((a, b) =>
    state.sort === "days" ? b.days.size - a.days.size : b[state.sort] - a[state.sort]);
  const shown = state.showAllApps ? rows : rows.slice(0, 15);
  const maxTime = Math.max(1, ...rows.map((r) => r.time));

  let html = '<thead><tr><th class="l">App</th><th class="l">Category</th><th class="l"></th>' +
    cols.map(([k, label]) => '<th class="sortable' + (state.sort === k ? " sorted" : "") + '" data-sort="' + k + '">' + label + "</th>").join("") +
    "</tr></thead><tbody>";
  for (const r of shown) {
    const app = DATA.apps[r.app];
    html += '<tr class="clickable" data-dev="' + r.dev + '" data-app="' + r.app + '">' +
      '<td class="l"><div class="app-cell">' + sw(deviceColor(r.dev)) + esc(appLabel(r.app, r.dev)) + "</div></td>" +
      '<td class="l"><div class="app-cell muted">' + sw(catColor(app.cat)) + esc(catName(app.cat)) + "</div></td>" +
      '<td class="bar-cell"><div class="bar" style="width:' + (r.time / maxTime) * 100 + "%;background:" + catColor(app.cat) + '"></div></td>' +
      '<td class="num">' + fmt(r.time) + '</td><td class="num">' + r.opens + '</td><td class="num">' + fmt(r.avg) +
      '</td><td class="num">' + fmt(r.longest) + '</td><td class="num">' + r.days.size + "</td></tr>";
  }
  const table = document.getElementById("apps-table");
  table.innerHTML = html + "</tbody>";
  table.onclick = (e) => {
    const th = e.target.closest("th.sortable");
    if (th) { state.sort = th.dataset.sort; render(); return; }
    const tr = e.target.closest("tr.clickable");
    if (tr) openDetail({ type: "app", dev: Number(tr.dataset.dev), app: Number(tr.dataset.app) });
  };

  const more = document.getElementById("apps-more");
  more.innerHTML = rows.length > 15
    ? '<button class="close">' + (state.showAllApps ? "Show top 15" : "Show all " + rows.length + " apps") + "</button>"
    : "";
  more.onclick = () => { state.showAllApps = !state.showAllApps; render(); };
}

// ---------- heatmap ----------
function renderHeatmap(segs) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const daysWithData = new Set();
  for (const s of segs) {
    daysWithData.add(Math.floor(s[2] / DAY));
    let t = s[2];
    while (t < s[3]) {
      const hourEnd = Math.min(s[3], Math.floor(t / 3600) * 3600 + 3600);
      const d = new Date(t * 1000);
      grid[d.getUTCDay()][d.getUTCHours()] += hourEnd - t;
      t = hourEnd;
    }
  }
  const weekdayCount = new Array(7).fill(0);
  for (const d of daysWithData) weekdayCount[dayDate(d).getUTCDay()]++;

  const avgMin = grid.map((row, wd) => row.map((secs) => (weekdayCount[wd] ? secs / 60 / weekdayCount[wd] : null)));
  const max = Math.max(1, ...avgMin.flat().filter((v) => v !== null));
  document.getElementById("heat-hint").textContent = showDeviceNames()
    ? "Average minutes per hour on days with data. Devices are added together, so an hour can go above 60."
    : "Average minutes per hour, on days with data.";
  const level = (v) => (v === null || v < 0.5 ? 0 : Math.min(5, Math.ceil((v / max) * 5)));

  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = "<div></div>" + Array.from({ length: 24 }, (_, h) =>
    '<div class="hr">' + (h % 3 === 0 ? fmtHourLabel(h) : "") + "</div>").join("");
  for (const wd of order) {
    html += '<div class="lbl">' + WEEKDAYS[wd] + "</div>";
    for (let h = 0; h < 24; h++) {
      html += '<div class="cell" data-wd="' + wd + '" data-h="' + h + '" style="background:var(--heat-' + level(avgMin[wd][h]) + ')"></div>';
    }
  }
  const heat = document.getElementById("heat");
  heat.innerHTML = html;
  heat.onmousemove = (e) => {
    const c = e.target.closest(".cell"); if (!c) return hideTip();
    const wd = Number(c.dataset.wd), h = Number(c.dataset.h), v = avgMin[wd][h];
    showTip(e, "<b>" + WEEKDAYS[wd] + " " + fmtHourLabel(h) + " to " + fmtHourLabel((h + 1) % 24) + "</b><br>" +
      (v === null ? "no data" : Math.round(v) + " min on average") +
      '<br><span class="muted">' + weekdayCount[wd] + " " + WEEKDAYS[wd] + "s with data</span>");
  };
  heat.onmouseleave = hideTip;

  document.getElementById("heat-legend").innerHTML = "Less " +
    [0, 1, 2, 3, 4, 5].map((l) => '<span class="cell" style="background:var(--heat-' + l + ')"></span>').join("") +
    " More (up to " + Math.round(max) + " min)";
}

// ---------- daily table ----------
function renderTable(days, daily) {
  let html = '<thead><tr><th class="l">Date</th>' + daily.map(({ dev }) => "<th>" + esc(DATA.devices[dev]) + "</th>").join("") + "</tr></thead><tbody>";
  for (let i = days.length - 1; i >= 0; i--) {
    html += '<tr><td class="l">' + fmtDay(days[i], true) + "</td>" + daily.map(({ values }) =>
      values[i] === null ? '<td class="empty">no data</td>' : '<td class="num">' + fmt(values[i]) + "</td>").join("") + "</tr>";
  }
  document.getElementById("table").innerHTML = html + "</tbody>";
}

// ---------- detail panel ----------
function renderDetail(days) {
  const panel = document.getElementById("detail");
  const d = state.detail;
  if (!d) { panel.hidden = true; return; }
  panel.hidden = false;
  document.getElementById("detail-close").onclick = () => { state.detail = null; render(); };
  if (d.type === "day") renderDayDetail(d.day);
  else renderAppDetail(d.dev, d.app, days);
}

function renderDayDetail(day) {
  const devs = selectedDevices();
  const dayStart = day * DAY;
  const daySessions = SESSIONS.filter((s) => devs.includes(s[0]) && s[3] > dayStart && s[2] < dayStart + DAY);
  const daySegs = DATA.segs.filter((s) => devs.includes(s[0]) && Math.floor(s[2] / DAY) === day);

  // Per-app totals and opens for this day
  const totals = new Map();
  for (const s of daySegs) {
    const key = s[0] + "|" + s[1];
    if (!totals.has(key)) totals.set(key, { dev: s[0], app: s[1], time: 0, opens: 0 });
    totals.get(key).time += s[3] - s[2];
  }
  for (const s of daySessions) {
    if (Math.floor(s[2] / DAY) !== day) continue;
    const key = s[0] + "|" + s[1];
    if (totals.has(key)) totals.get(key).opens++;
  }
  const rows = [...totals.values()].sort((a, b) => b.time - a.time);

  document.getElementById("detail-title").textContent = fmtDay(day, true);
  document.getElementById("detail-stats").innerHTML = devs.map((dev) => {
    const t = daySegs.filter((s) => s[0] === dev).reduce((a, s) => a + s[3] - s[2], 0);
    return "<span>" + sw(deviceColor(dev)) + " " + esc(DATA.devices[dev]) + ": <b>" +
      (deviceDays[dev].has(day) ? fmt(t) : "no data") + "</b></span>";
  }).join("") + "<span>Apps used: <b>" + rows.length + "</b></span>" +
    "<span>Opens: <b>" + daySessions.filter((s) => Math.floor(s[2] / DAY) === day).length + "</b></span>" +
    (untrackedOn(day) >= 60 ? '<span><span class="swatch hatch"></span> Untracked: <b>' + fmt(untrackedOn(day)) + "</b></span>" : "");
  const dayGaps = DATA.gaps.filter((g) => devs.includes(g[0]) && Math.floor(g[1] / DAY) === day);

  // Timeline: one track per device, sessions as blocks colored by category
  let html = '<div class="section-label">Timeline</div>';
  for (const dev of devs) {
    const has = deviceDays[dev].has(day);
    html += '<div class="tl-row"><div class="cov-name">' + sw(deviceColor(dev)) + esc(DATA.devices[dev]) +
      '</div><div class="tl-track' + (has ? "" : " none") + '">';
    if (!has) html += '<div class="nodata">No data for this day</div>';
    dayGaps.forEach((g, i) => {
      if (g[0] !== dev) return;
      const a = g[1] - dayStart, b = g[2] - dayStart;
      html += '<div class="tl-gap" data-g="' + i + '" style="left:' + (a / DAY) * 100 + "%;width:" + ((b - a) / DAY) * 100 + '%"></div>';
    });
    daySessions.forEach((s, i) => {
      if (s[0] !== dev) return;
      const a = Math.max(s[2], dayStart) - dayStart, b = Math.min(s[3], dayStart + DAY) - dayStart;
      html += '<div class="tl-block" data-i="' + i + '" style="left:' + (a / DAY) * 100 + "%;width:" +
        ((b - a) / DAY) * 100 + "%;background:" + catColor(DATA.apps[s[1]].cat) + '"></div>';
    });
    html += "</div></div>";
  }
  html += '<div class="tl-axis">' + [0, 3, 6, 9, 12, 15, 18, 21].map((h) =>
    '<span style="left:' + (h / 24) * 100 + '%">' + fmtHourLabel(h) + "</span>").join("") + "</div>";
  const cats = CAT_ORDER.filter((c) => daySessions.some((s) => DATA.apps[s[1]].cat === c));
  html += '<div class="cat-legend">' + cats.map((c) => "<span>" + sw(catColor(c)) + esc(catName(c)) + "</span>").join("") +
    (dayGaps.length ? '<span><span class="swatch hatch"></span>Untracked (screen on, no app recorded)</span>' : "") + "</div>";

  // App list for the day
  html += '<div class="section-label">Apps</div>';
  if (!rows.length) {
    html += '<p class="hint">No data for this day.</p>';
  } else {
    const max = rows[0].time;
    html += '<div class="table-wrap"><table><thead><tr><th class="l">App</th><th class="l"></th><th>Time</th><th>Opens</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="clickable" data-dev="' + r.dev + '" data-app="' + r.app + '"><td class="l"><div class="app-cell">' +
        sw(catColor(DATA.apps[r.app].cat)) + esc(appLabel(r.app, r.dev)) + '</div></td><td class="bar-cell"><div class="bar" style="width:' +
        (r.time / max) * 100 + "%;background:" + catColor(DATA.apps[r.app].cat) + '"></div></td><td class="num">' + fmt(r.time) +
        '</td><td class="num">' + r.opens + "</td></tr>").join("") + "</tbody></table></div>";
  }

  const body = document.getElementById("detail-body");
  body.innerHTML = html;
  body.onmousemove = (e) => {
    const g = e.target.closest(".tl-gap");
    if (g) {
      const gap = dayGaps[Number(g.dataset.g)];
      const hint = gap[3].map(([app, t]) => esc(DATA.apps[app].name) + " at " + fmtClock(t)).join(", ");
      showTip(e, "<b>Untracked</b> " + '<span class="muted">screen on, no app recorded</span><br>' +
        fmtClock(gap[1]) + " to " + fmtClock(gap[2]) + " (" + fmt(gap[2] - gap[1]) + ")" +
        (hint ? '<br><span class="muted">Last opened: ' + hint + "</span>" : ""));
      return;
    }
    const b = e.target.closest(".tl-block"); if (!b) return hideTip();
    const s = daySessions[Number(b.dataset.i)];
    const app = DATA.apps[s[1]];
    showTip(e, "<b>" + esc(app.name) + "</b> " + '<span class="muted">' + esc(catName(app.cat)) + "</span><br>" +
      fmtClock(s[2]) + " to " + fmtClock(s[3]) + " (" + fmt(s[4]) + ")");
  };
  body.onmouseleave = hideTip;
  body.onclick = (e) => {
    const tr = e.target.closest("tr.clickable") ; if (!tr) return;
    openDetail({ type: "app", dev: Number(tr.dataset.dev), app: Number(tr.dataset.app) });
  };
}

function renderAppDetail(dev, app, days) {
  const lo = days[0], hi = days[days.length - 1];
  const byDay = new Map();
  for (const s of DATA.segs) {
    if (s[0] !== dev || s[1] !== app) continue;
    const d = Math.floor(s[2] / DAY);
    byDay.set(d, (byDay.get(d) ?? 0) + (s[3] - s[2]));
  }
  const appSessions = SESSIONS.filter((s) => s[0] === dev && s[1] === app &&
    Math.floor(s[2] / DAY) >= lo && Math.floor(s[2] / DAY) <= hi);
  // 0 when the device has data that day but the app wasn't used; null when the device has no data
  const values = days.map((d) => (byDay.has(d) ? byDay.get(d) : deviceDays[dev].has(d) ? 0 : null));
  const used = values.filter((v) => v);
  const total = used.reduce((a, b) => a + b, 0);
  const longest = appSessions.reduce((a, s) => Math.max(a, s[4]), 0);
  const info = DATA.apps[app];

  document.getElementById("detail-title").textContent = info.name + " on " + DATA.devices[dev];
  document.getElementById("detail-stats").innerHTML =
    "<span>Total: <b>" + fmt(total) + "</b></span>" +
    "<span>Opens: <b>" + appSessions.length + "</b></span>" +
    "<span>Avg session: <b>" + (appSessions.length ? fmt(total / appSessions.length) : "none") + "</b></span>" +
    "<span>Longest: <b>" + fmt(longest) + "</b></span>" +
    "<span>Days used: <b>" + used.length + "</b></span>" +
    "<span>" + sw(catColor(info.cat)) + " " + esc(catName(info.cat)) + "</span>" +
    '<span class="muted">' + esc(info.id) + "</span>";

  document.getElementById("detail-body").innerHTML =
    '<div class="chart-box" style="height:220px"><canvas id="app-daily" role="img" aria-label="Daily time for this app"></canvas></div>';
  document.getElementById("detail-body").onclick = null;
  document.getElementById("detail-body").onmousemove = null;

  const options = baseOptions();
  options.interaction = { mode: "index", intersect: false };
  options.plugins.tooltip.callbacks = {
    title: (items) => fmtDay(days[items[0].dataIndex], true),
    label: (item) => " " + (values[item.dataIndex] === null ? "no data for " + DATA.devices[dev] : fmt(values[item.dataIndex])),
    footer: (items) => (values[items[0].dataIndex] === null ? "" : "Click for timeline"),
  };
  options.onClick = (evt, els, chart) => {
    const pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
    if (pts.length) openDetail({ type: "day", day: days[pts[0].index] });
  };

  charts.push(new Chart(document.getElementById("app-daily"), {
    type: "bar",
    data: {
      labels: days.map((d) => fmtDay(d)),
      datasets: [{ data: values.map(toHours), backgroundColor: catColor(info.cat),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start", maxBarThickness: 18 }],
    },
    options,
  }));
}

render();
