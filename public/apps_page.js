// public/apps_page.js
//
// The Apps page. Two parts:
//   Categories: add, rename, recolor, reorder and delete your categories
//   Apps: rename each app and pick its category
// Every change is saved right away through the server's API (see server.mjs).

const SHOW = [["all", "All"], ["unnamed", "Not set"], ["yours", "Set by you"]];
// Who set the name and category: the built-in list, you, or nobody yet
const SOURCE_LABELS = { yours: "You", default: "Built-in", unnamed: "Not set" };

const state = { show: "all", search: "", colorOpen: null, confirmDelete: null };
let apps = [];
let categories = []; // [{ id, name, color }] in your order
let other = { id: "other", name: "Other" };
let colorNames = [];

const table = document.getElementById("apps");
const catList = document.getElementById("categories");
const catStatus = document.getElementById("cat-status");

// ---------- helpers ----------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmt(secs) {
  const m = Math.round(secs / 60);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  return h ? h + "h " + String(m % 60).padStart(2, "0") + "m" : m + "m";
}

function fmtDay(day) {
  return new Date(day + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const colorVar = (color) => "var(--cat-" + (color + 1) + ")";

function showError(message) {
  document.querySelector("main").innerHTML =
    '<nav class="nav"><a href="/">Dashboard</a><a href="/apps" aria-current="page">Apps</a></nav>' +
    '<h1>Apps</h1><p class="card error"></p>';
  document.querySelector(".error").textContent = message;
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

// Load everything again after a category change, since it can move apps
async function reload() {
  const [appList, cats] = await Promise.all([getJson("/api/apps"), getJson("/api/categories")]);
  apps = appList;
  categories = cats.categories;
  other = cats.other;
  colorNames = cats.colors;
  sortApps();
}

function flash(el, text, failed = false) {
  el.textContent = text;
  el.className = "status" + (failed ? " failed" : "");
  if (!failed) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 1500);
}

// ---------- categories ----------

function appCount(categoryId) {
  return apps.filter((a) => a.category === categoryId).length;
}

function categoryRowHtml(c, i) {
  const count = appCount(c.id);
  let html = '<div class="cat-row" data-id="' + esc(c.id) + '">' +
    '<button class="color-dot" style="background:' + colorVar(c.color) + '" ' +
    'aria-label="Color for ' + esc(c.name) + ": " + esc(colorNames[c.color]) + '. Change" ' +
    'aria-expanded="' + (state.colorOpen === c.id) + '"></button>' +
    '<input class="name-input cat-name" value="' + esc(c.name) + '" maxlength="40" aria-label="Name for category ' + esc(c.name) + '">' +
    '<span class="cat-count">' + plural(count, "app") + "</span>" +
    '<span class="cat-actions">';
  if (state.confirmDelete === c.id) {
    html += '<span class="confirm-text">' + (count ? "Move " + plural(count, "app") + " to Other and delete?" : "Delete?") + "</span>" +
      '<button class="button danger confirm-delete">Delete</button>' +
      '<button class="link-button cancel-delete">Cancel</button>';
  } else {
    html += '<button class="icon-button move-up" aria-label="Move ' + esc(c.name) + ' up"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
      '<button class="icon-button move-down" aria-label="Move ' + esc(c.name) + ' down"' + (i === categories.length - 1 ? " disabled" : "") + ">↓</button>" +
      '<button class="link-button delete">Delete</button>';
  }
  html += "</span></div>";
  if (state.colorOpen === c.id) {
    html += '<div class="swatches" role="group" aria-label="Colors for ' + esc(c.name) + '">' +
      colorNames.map((name, k) =>
        '<button class="swatch-button" data-color="' + k + '" style="background:' + colorVar(k) + '" ' +
        'title="' + esc(name) + '" aria-label="' + esc(name) + '" aria-pressed="' + (k === c.color) + '"></button>').join("") +
      "</div>";
  }
  return html;
}

function renderCategories() {
  const otherCount = appCount(other.id);
  catList.innerHTML = categories.map(categoryRowHtml).join("") +
    '<div class="cat-row other-row">' +
    '<span class="color-dot fixed" style="background:var(--cat-other)"></span>' +
    '<span class="cat-fixed-name">' + esc(other.name) + "</span>" +
    '<span class="cat-count">' + plural(otherCount, "app") + "</span>" +
    '<span class="cat-actions muted">Always here</span></div>';
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

catList.addEventListener("click", (e) => {
  const row = e.target.closest(".cat-row[data-id]");
  const swatch = e.target.closest(".swatch-button");
  if (swatch) {
    const id = swatch.parentElement.previousElementSibling.dataset.id;
    state.colorOpen = null;
    categoryChange(() => send("PUT", "/api/categories/" + encodeURIComponent(id), { color: Number(swatch.dataset.color) }), "Saved");
    return;
  }
  if (!row) return;
  const id = row.dataset.id;
  const t = e.target;
  if (t.matches(".color-dot")) {
    state.colorOpen = state.colorOpen === id ? null : id;
    renderCategories();
    catList.querySelector('.cat-row[data-id="' + CSS.escape(id) + '"] .color-dot').focus();
  } else if (t.matches(".move-up, .move-down")) {
    const ids = categories.map((c) => c.id);
    const i = ids.indexOf(id), j = t.matches(".move-up") ? i - 1 : i + 1;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    categoryChange(() => send("PUT", "/api/category-order", { ids })).then(() => {
      // Keep focus on the arrow, so you can keep moving the same category
      const again = catList.querySelector('.cat-row[data-id="' + CSS.escape(id) + '"] ' + (t.matches(".move-up") ? ".move-up" : ".move-down"));
      if (again && !again.disabled) again.focus();
    });
  } else if (t.matches(".delete")) {
    state.confirmDelete = id;
    renderCategories();
    catList.querySelector(".confirm-delete").focus();
  } else if (t.matches(".cancel-delete")) {
    state.confirmDelete = null;
    renderCategories();
  } else if (t.matches(".confirm-delete")) {
    state.confirmDelete = null;
    const name = categories.find((c) => c.id === id)?.name ?? "Category";
    categoryChange(() => send("DELETE", "/api/categories/" + encodeURIComponent(id)), name + " deleted");
  }
});

// Rename when you press Enter or click away
catList.addEventListener("change", (e) => {
  if (!e.target.matches(".cat-name")) return;
  const id = e.target.closest(".cat-row").dataset.id;
  const category = categories.find((c) => c.id === id);
  const name = e.target.value.trim();
  if (!name || name === category.name) {
    e.target.value = category.name;
    return;
  }
  send("PUT", "/api/categories/" + encodeURIComponent(id), { name })
    .then((result) => {
      category.name = result.name;
      e.target.value = result.name;
      render(); // the app list's category menus show the new name
      flash(catStatus, "Saved");
    })
    .catch((err) => {
      e.target.value = category.name;
      flash(catStatus, err.message, true);
    });
});
catList.addEventListener("keydown", (e) => {
  if (!e.target.matches(".cat-name")) return;
  if (e.key === "Enter") e.target.blur();
  if (e.key === "Escape") {
    e.target.value = categories.find((c) => c.id === e.target.closest(".cat-row").dataset.id).name;
    e.target.blur();
  }
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
  apps.sort((a, b) => (b.source === "unnamed") - (a.source === "unnamed") || b.seconds - a.seconds);
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
    '<button data-v="' + value + '" aria-pressed="' + (state.show === value) + '">' +
    label + " (" + counts[value] + ")</button>").join("");
  el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    state.show = b.dataset.v;
    render();
  }));
}

function categoryOptions(selected) {
  return categories.concat([other]).map((c) =>
    '<option value="' + esc(c.id) + '"' + (c.id === selected ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
}

function rowHtml(a) {
  return '<tr data-id="' + esc(a.id) + '">' +
    '<td class="l"><input class="name-input" value="' + esc(a.name) + '" maxlength="80" aria-label="Name for ' + esc(a.id) + '">' +
    '<div class="app-id">' + esc(a.id) + "</div></td>" +
    '<td class="l"><select class="cat-select" aria-label="Category for ' + esc(a.id) + '">' + categoryOptions(a.category) + "</select></td>" +
    '<td class="l">' + esc(a.devices.join(", ")) + "</td>" +
    '<td class="num">' + fmt(a.seconds) + "</td>" +
    '<td class="num">' + fmtDay(a.lastDay) + "</td>" +
    '<td class="l"><span class="badge ' + a.source + '">' + SOURCE_LABELS[a.source] + "</span>" +
    (a.source === "yours" ? ' <button class="link-button reset" title="Go back to the built-in name and category">Reset</button>' : "") +
    '<span class="status" aria-live="polite"></span></td>' +
    "</tr>";
}

function render() {
  renderFilters();
  const list = visibleApps();
  document.getElementById("count").textContent = list.length === apps.length
    ? apps.length + " apps. Apps not set yet are listed first."
    : "Showing " + list.length + " of " + apps.length + " apps.";
  table.innerHTML =
    '<thead><tr><th class="l">Name</th><th class="l">Category</th><th class="l">Devices</th>' +
    '<th>Total time</th><th>Last used</th><th class="l">Set by</th></tr></thead><tbody>' +
    (list.length ? list.map(rowHtml).join("") : '<tr><td class="l empty" colspan="6">No apps match.</td></tr>') +
    "</tbody>";
}

// Update a row in place rather than redrawing it, so moving from the name
// box to the category menu doesn't lose your place
function updateRow(row, app) {
  const input = row.querySelector(".name-input");
  if (document.activeElement !== input) input.value = app.name;
  row.querySelector(".cat-select").value = app.category;
  const badge = row.querySelector(".badge");
  badge.className = "badge " + app.source;
  badge.textContent = SOURCE_LABELS[app.source];
  const reset = row.querySelector(".reset");
  if (app.source === "yours" && !reset) {
    badge.insertAdjacentHTML("afterend", ' <button class="link-button reset" title="Go back to the built-in name and category">Reset</button>');
  } else if (app.source !== "yours" && reset) {
    reset.remove();
  }
}

async function saveApp(row, body) {
  const id = row.dataset.id;
  const status = row.querySelector(".status");
  status.textContent = "Saving...";
  status.className = "status";
  try {
    const result = await send("PUT", "/api/apps/" + encodeURIComponent(id), body);
    const app = apps.find((a) => a.id === id);
    Object.assign(app, { name: result.name, category: result.category, source: result.source });
    updateRow(row, app);
    renderFilters();
    renderCategories(); // app counts per category
    flash(status, "Saved");
  } catch (err) {
    flash(status, err.message, true);
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
  const category = row.querySelector(".cat-select").value;
  if (name === app.name && category === app.category) return;
  saveApp(row, { name, category });
}

// One set of listeners for the whole table, so redrawn rows keep working
table.addEventListener("change", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (row && (e.target.matches(".name-input") || e.target.matches(".cat-select"))) saveRow(row);
});
table.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".name-input")) e.target.blur();
  if (e.key === "Escape" && e.target.matches(".name-input")) {
    const app = apps.find((a) => a.id === e.target.closest("tr").dataset.id);
    e.target.value = app.name;
    e.target.blur();
  }
});
table.addEventListener("click", (e) => {
  if (e.target.matches(".reset")) saveApp(e.target.closest("tr"), { reset: true });
});
document.getElementById("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});

// ---------- start ----------

try {
  await reload();
  renderCategories();
  render();
} catch (err) {
  showError(err.message.startsWith("Can't reach") || err instanceof TypeError
    ? "Can't reach the dashboard server. Is npm start still running?" : err.message);
}
