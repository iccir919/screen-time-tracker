// public/organize_page.js
//
// The Organize page. Two parts:
//   Categories: add, recolor, and through each one's ⋯ menu rename, move
//     and delete. Each shows its apps and its time per day.
//   Apps: rename each app and pick its category
// Every change is saved right away through the server's API (see server.mjs).
// Times per day are over the last 30 days, from /api/usage.

import { setupRefresh, showLastArchived } from "./refresh.js";
import { DAY, esc, fmt, todayIdx } from "./common.js";

const SHOW = [["all", "All"], ["unnamed", "Not set"], ["yours", "Set by you"]];
// Who set the name and category: the built-in list, you, or nobody yet
const SOURCE_LABELS = { yours: "You", default: "Built-in", unnamed: "Not set" };
const PER_DAY_DAYS = 30;

// menu: the category whose ⋯ menu is open; renaming: the one being renamed
const state = { show: "all", search: "", colorOpen: null, menu: null, renaming: null, confirmDelete: null };
let apps = [];
let categories = []; // [{ id, name, color }] in your order
let other = { id: "other", name: "Other" };
let colorNames = [];
let perDay = new Map(); // app id -> seconds per day, last 30 days

const table = document.getElementById("apps");
const catList = document.getElementById("categories");
const catStatus = document.getElementById("cat-status");

setupRefresh();

// ---------- helpers ----------

const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const colorVar = (color) => "var(--cat-" + (color + 1) + ")";
const categoryById = (id) => (id === other.id ? null : categories.find((c) => c.id === id));
const categoryColorOf = (id) => { const c = categoryById(id); return c ? colorVar(c.color) : "var(--cat-other)"; };
const timeText = (secs) => (secs >= 30 ? fmt(secs) : "–");

function showError(message) {
  document.getElementById("content").innerHTML = '<div class="notice empty-state"><b>Nothing to show yet</b><span id="load-error"></span></div>';
  document.getElementById("load-error").textContent = message;
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "The server returned an error.");
  return body;
}

// For changes: PUT, POST or DELETE with a JSON body
async function send(method, url, body = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the server. Is npm start still running?");
  }
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? "Couldn't save.");
  return result;
}

// Load the apps and categories again after a category change, since it can move apps
async function reload() {
  const [appList, cats] = await Promise.all([getJson("/api/apps"), getJson("/api/categories")]);
  apps = appList;
  categories = cats.categories;
  other = cats.other;
  colorNames = cats.colors;
  sortApps();
}

// Time per day for each app over the last 30 days, counting only days with data
async function loadTimes() {
  const data = await getJson("/api/usage");
  showLastArchived(data.lastArchived);
  const from = todayIdx - PER_DAY_DAYS + 1;
  const days = new Set();
  const secs = new Map();
  for (const [, app, start, end] of data.segs) {
    const day = Math.floor(start / DAY);
    if (day < from || day > todayIdx) continue;
    days.add(day);
    const id = data.apps[app].id;
    secs.set(id, (secs.get(id) ?? 0) + end - start);
  }
  const n = Math.max(1, days.size);
  perDay = new Map([...secs].map(([id, s]) => [id, s / n]));
}

function flash(el, text, failed = false) {
  el.textContent = text;
  el.classList.toggle("failed", failed);
  if (!failed) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 1500);
}

// ---------- categories ----------

const appsIn = (categoryId) => apps.filter((a) => a.category === categoryId);
const timeIn = (categoryId) => appsIn(categoryId).reduce((sum, a) => sum + (perDay.get(a.id) ?? 0), 0);

function categoryRowHtml(c, i) {
  const count = appsIn(c.id).length;
  const id = esc(c.id);
  const name = state.renaming === c.id
    ? '<input class="name-input cat-name" value="' + esc(c.name) + '" maxlength="40" aria-label="New name for ' + esc(c.name) + '">'
    : "<b>" + esc(c.name) + "</b>";
  let html = '<div class="cat-row" data-id="' + id + '">' +
    '<button class="color-dot" style="background:' + colorVar(c.color) + '" ' +
    'aria-label="Color for ' + esc(c.name) + ": " + esc(colorNames[c.color]) + '. Change" ' +
    'aria-expanded="' + (state.colorOpen === c.id) + '"></button>' +
    '<div class="cat-who">' + name + "<span>" + plural(count, "app") + "</span></div>" +
    '<span class="cat-time">' + timeText(timeIn(c.id)) + "</span>" +
    '<button class="more-button" aria-label="More for ' + esc(c.name) + '" aria-haspopup="true" aria-expanded="' + (state.menu === c.id) + '">⋯</button>';
  if (state.menu === c.id) {
    html += '<div class="menu" role="menu">' +
      '<button role="menuitem" data-act="rename">Rename</button>' +
      '<button role="menuitem" data-act="up"' + (i === 0 ? " disabled" : "") + ">Move up</button>" +
      '<button role="menuitem" data-act="down"' + (i === categories.length - 1 ? " disabled" : "") + ">Move down</button>" +
      '<button role="menuitem" data-act="delete" class="danger">Delete</button></div>';
  }
  if (state.confirmDelete === c.id) {
    html += '<div class="confirm"><span>' + (count ? "Move " + plural(count, "app") + " to Other and delete?" : "Delete " + esc(c.name) + "?") + "</span>" +
      '<button class="button small danger confirm-delete">Delete</button>' +
      '<button class="button small cancel-delete">Cancel</button></div>';
  }
  html += "</div>";
  if (state.colorOpen === c.id) {
    html += '<div class="swatches" role="group" aria-label="Colors for ' + esc(c.name) + '" data-for="' + id + '">' +
      colorNames.map((cname, k) =>
        '<button class="swatch-button" data-color="' + k + '" style="background:' + colorVar(k) + '" ' +
        'title="' + esc(cname) + '" aria-label="' + esc(cname) + '" aria-pressed="' + (k === c.color) + '"></button>').join("") +
      "</div>";
  }
  return html;
}

function renderCategories() {
  // The share bar: each category's part of the time, in your order, Other last
  const parts = categories.map((c) => [timeIn(c.id), colorVar(c.color), c.name]).concat([[timeIn(other.id), "var(--cat-other)", other.name]]);
  const sum = parts.reduce((a, [s]) => a + s, 0);
  document.getElementById("cat-share").innerHTML = sum
    ? parts.filter(([s]) => s > 0).map(([s, color, name]) =>
      '<span style="flex:' + (s / sum).toFixed(4) + " 1 0;background:" + color + '" data-tip="' + esc(name + " " + fmt(s) + " a day") + '"></span>').join("")
    : "";
  catList.innerHTML = categories.map(categoryRowHtml).join("") +
    '<div class="cat-row other-row">' +
    '<span class="color-dot fixed" style="background:var(--cat-other)"></span>' +
    '<div class="cat-who"><b>' + esc(other.name) + "</b><span>" + plural(appsIn(other.id).length, "app") + " · always here</span></div>" +
    '<span class="cat-time">' + timeText(timeIn(other.id)) + "</span><span></span></div>";
  const input = catList.querySelector(".cat-name");
  if (input) { input.focus(); input.select(); }
}

async function categoryChange(fn, successText) {
  try {
    await fn();
    await reload();
    renderCategories();
    render();
    if (successText) flash(catStatus, successText);
  } catch (err) {
    flash(catStatus, err.message, true);
    // Put the list back the way the server has it
    try { await reload(); } catch { /* keep what we have */ }
    renderCategories();
    render();
  }
}

const focusIn = (id, selector) => catList.querySelector('.cat-row[data-id="' + CSS.escape(id) + '"] ' + selector)?.focus();

catList.addEventListener("click", (e) => {
  const swatch = e.target.closest(".swatch-button");
  if (swatch) {
    const id = swatch.parentElement.dataset.for;
    state.colorOpen = null;
    categoryChange(() => send("PUT", "/api/categories/" + encodeURIComponent(id), { color: Number(swatch.dataset.color) }), "Saved");
    return;
  }
  const row = e.target.closest(".cat-row[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const t = e.target.closest("button");
  if (!t) return;
  if (t.matches(".color-dot")) {
    state.colorOpen = state.colorOpen === id ? null : id;
    state.menu = null;
    renderCategories();
    focusIn(id, ".color-dot");
  } else if (t.matches(".more-button")) {
    state.menu = state.menu === id ? null : id;
    state.colorOpen = null;
    renderCategories();
    if (state.menu) focusIn(id, ".menu button:not(:disabled)");
    else focusIn(id, ".more-button");
  } else if (t.dataset.act) {
    state.menu = null;
    const act = t.dataset.act;
    if (act === "rename") {
      state.renaming = id;
      renderCategories();
    } else if (act === "delete") {
      state.confirmDelete = id;
      renderCategories();
      focusIn(id, ".confirm-delete");
    } else {
      const ids = categories.map((c) => c.id);
      const i = ids.indexOf(id), j = act === "up" ? i - 1 : i + 1;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      categoryChange(() => send("PUT", "/api/category-order", { ids })).then(() => focusIn(id, ".more-button"));
    }
  } else if (t.matches(".cancel-delete")) {
    state.confirmDelete = null;
    renderCategories();
  } else if (t.matches(".confirm-delete")) {
    state.confirmDelete = null;
    const name = categories.find((c) => c.id === id)?.name ?? "Category";
    categoryChange(() => send("DELETE", "/api/categories/" + encodeURIComponent(id)), name + " deleted");
  }
});

// Close the ⋯ menu when you click anywhere else or press Escape
document.addEventListener("click", (e) => {
  if (state.menu && !e.target.closest(".menu, .more-button")) {
    state.menu = null;
    renderCategories();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.menu) {
    const id = state.menu;
    state.menu = null;
    renderCategories();
    focusIn(id, ".more-button");
  }
});

// Renaming saves when you press Enter or click away; Escape cancels
function finishRename(input, save) {
  const id = state.renaming;
  const category = categories.find((c) => c.id === id);
  state.renaming = null;
  const name = input.value.trim();
  if (!save || !category || !name || name === category.name) {
    renderCategories();
    focusIn(id, ".more-button");
    return;
  }
  send("PUT", "/api/categories/" + encodeURIComponent(id), { name })
    .then((result) => {
      category.name = result.name;
      flash(catStatus, "Saved");
    })
    .catch((err) => flash(catStatus, err.message, true))
    .finally(() => {
      renderCategories();
      render(); // the app list's category menus show the new name
      focusIn(id, ".more-button");
    });
}
catList.addEventListener("keydown", (e) => {
  if (!e.target.matches(".cat-name")) return;
  if (e.key === "Enter") { e.preventDefault(); finishRename(e.target, true); }
  if (e.key === "Escape") { e.stopPropagation(); finishRename(e.target, false); }
});
catList.addEventListener("focusout", (e) => {
  if (e.target.matches(".cat-name") && state.renaming) finishRename(e.target, true);
});

document.getElementById("add-cat").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("new-cat");
  const name = input.value.trim();
  if (!name) return;
  categoryChange(async () => {
    await send("POST", "/api/categories", { name });
    input.value = "";
  }, name + " added");
});

// ---------- apps ----------

// Apps not set yet first (they need attention), then most used
function sortApps() {
  apps.sort((a, b) => (b.source === "unnamed") - (a.source === "unnamed") ||
    (perDay.get(b.id) ?? 0) - (perDay.get(a.id) ?? 0) || b.seconds - a.seconds);
}

function visibleApps() {
  const q = state.search.trim().toLowerCase();
  return apps.filter((a) => {
    if (state.show !== "all" && a.source !== state.show) return false;
    return !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q);
  });
}

function renderFilters() {
  const el = document.getElementById("show-filter");
  const counts = { all: apps.length, unnamed: 0, yours: 0 };
  for (const a of apps) if (a.source in counts) counts[a.source]++;
  el.innerHTML = SHOW.map(([value, label]) =>
    '<button data-v="' + value + '" aria-pressed="' + (state.show === value) + '">' + label + " " + counts[value] + "</button>").join("");
}

document.getElementById("show-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  state.show = b.dataset.v;
  render();
});

function categoryOptions(selected) {
  return categories.concat([other]).map((c) =>
    '<option value="' + esc(c.id) + '"' + (c.id === selected ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
}

function setByHtml(a) {
  return '<span class="badge ' + a.source + '">' + SOURCE_LABELS[a.source] + "</span>" +
    (a.source === "yours" ? '<button class="link-button reset" title="Go back to the built-in name and category">Reset</button>' : "") +
    '<span class="status" aria-live="polite"></span>';
}

function rowHtml(a) {
  return '<div class="org-line' + (a.source === "unnamed" ? " not-set" : "") + '" data-id="' + esc(a.id) + '">' +
    '<div class="app-who"><input class="name-input" value="' + esc(a.name) + '" maxlength="80" aria-label="Name for ' + esc(a.id) + '">' +
    '<span class="app-id" title="' + esc(a.id + " · " + a.devices.join(", ")) + '">' + esc(a.id) + "</span></div>" +
    '<label class="cat-pick"><span class="swatch" style="background:' + categoryColorOf(a.category) + '"></span>' +
    '<select aria-label="Category for ' + esc(a.name) + '">' + categoryOptions(a.category) + "</select></label>" +
    '<span class="num">' + timeText(perDay.get(a.id) ?? 0) + "</span>" +
    '<div class="set-by">' + setByHtml(a) + "</div></div>";
}

function render() {
  renderFilters();
  const list = visibleApps();
  document.getElementById("count").textContent = list.length === apps.length
    ? plural(apps.length, "app") + ". Apps not set yet are listed first."
    : "Showing " + list.length + " of " + plural(apps.length, "app") + ".";
  table.innerHTML =
    '<div class="org-line head"><span>Name</span><span>Category</span><span class="num">Per day</span><span>Set by</span></div>' +
    (list.length ? list.map(rowHtml).join("") : '<p class="hint org-empty">No apps match.</p>');
}

// Update a row in place rather than redrawing it, so moving from the name
// box to the category menu doesn't lose your place
function updateRow(row, app) {
  const input = row.querySelector(".name-input");
  if (document.activeElement !== input) input.value = app.name;
  row.querySelector("select").value = app.category;
  row.querySelector(".cat-pick .swatch").style.background = categoryColorOf(app.category);
  row.classList.toggle("not-set", app.source === "unnamed");
  row.querySelector(".set-by").innerHTML = setByHtml(app);
}

async function saveApp(row, body) {
  const id = row.dataset.id;
  const status = row.querySelector(".status");
  status.textContent = "Saving...";
  try {
    const result = await send("PUT", "/api/apps/" + encodeURIComponent(id), body);
    const app = apps.find((a) => a.id === id);
    Object.assign(app, { name: result.name, category: result.category, source: result.source });
    updateRow(row, app);
    renderFilters();
    renderCategories(); // app counts and times per category
    flash(row.querySelector(".status"), "Saved");
  } catch (err) {
    flash(row.querySelector(".status"), err.message, true);
  }
}

function saveRow(row) {
  const name = row.querySelector(".name-input").value.trim();
  const app = apps.find((a) => a.id === row.dataset.id);
  if (!name) {
    // An empty name isn't allowed, so put the current one back
    row.querySelector(".name-input").value = app.name;
    return;
  }
  const category = row.querySelector("select").value;
  row.querySelector(".cat-pick .swatch").style.background = categoryColorOf(category);
  if (name === app.name && category === app.category) return;
  saveApp(row, { name, category });
}

// One set of listeners for the whole list, so redrawn rows keep working
table.addEventListener("change", (e) => {
  const row = e.target.closest(".org-line[data-id]");
  if (row && e.target.matches(".name-input, select")) saveRow(row);
});
table.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".name-input")) e.target.blur();
  if (e.key === "Escape" && e.target.matches(".name-input")) {
    const app = apps.find((a) => a.id === e.target.closest(".org-line").dataset.id);
    e.target.value = app.name;
    e.target.blur();
  }
});
table.addEventListener("click", (e) => {
  if (e.target.matches(".reset")) saveApp(e.target.closest(".org-line"), { reset: true });
});
document.getElementById("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});

// ---------- start ----------

// Coming from the Apps page's "Rename it" link: start with that app found
const fromLink = /(?:^#|&)search=([^&]*)/.exec(location.hash);
if (fromLink) {
  state.search = decodeURIComponent(fromLink[1]);
  document.getElementById("search").value = state.search;
}

try {
  await Promise.all([reload(), loadTimes()]);
  sortApps();
  renderCategories();
  render();
} catch (err) {
  showError(err.message.startsWith("Can't reach") || err instanceof TypeError
    ? "Can't reach the dashboard server. Is npm start still running?" : err.message);
}
