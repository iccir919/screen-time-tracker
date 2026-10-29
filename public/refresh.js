// public/refresh.js
//
// The Refresh button, shared by the pages that have one. It runs the
// archiver through the server (POST /api/archive) and reloads the page.
// The page needs these elements:
//   #refresh         the button
//   #refresh-note    "Updated 5 min ago", and progress while it runs
//   #refresh-error   shown if the archiver fails

// beforeReload: optional function to run just before the page reloads,
// such as saving the filters you picked
export function setupRefresh({ beforeReload } = {}) {
  const button = document.getElementById("refresh");
  const note = document.getElementById("refresh-note");
  const error = document.getElementById("refresh-error");

  button.addEventListener("click", async () => {
    const previousNote = note.textContent;
    button.disabled = true;
    button.textContent = "Refreshing...";
    note.textContent = "Saving new data. This can take a minute.";
    error.hidden = true;
    try {
      const res = await fetch("/api/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "The archiver didn't finish.");
      try {
        beforeReload?.();
      } catch { /* nothing important to keep */ }
      location.reload();
    } catch (err) {
      error.textContent = err instanceof TypeError ? "Can't reach the dashboard server. Is npm start still running?" : err.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = "Refresh";
      note.textContent = previousNote;
    }
  });
}

// "Updated 5 min ago", "Updated today at 8:14 AM", "Updated Oct 26 at 9:02 PM"
export function showLastArchived(iso) {
  const note = document.getElementById("refresh-note");
  if (!iso || !note) return;
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  const clock = then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let text;
  if (mins < 1) text = "just now";
  else if (mins < 60) text = mins + " min ago";
  else if (then.toDateString() === new Date().toDateString()) text = "today at " + clock;
  else text = then.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " at " + clock;
  note.textContent = "Updated " + text;
  note.title = then.toLocaleString();
}
