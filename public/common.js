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

export const devColor = (dev) => "var(--dev-" + ((dev % 3) + 1) + ")";

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
