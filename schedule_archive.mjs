// schedule_archive.mjs
//
// Runs the archiver automatically once a day using launchd, the Mac's
// built-in scheduler. If the Mac is asleep or off at the scheduled time,
// launchd runs it as soon as the Mac wakes up.
//
// Each run archives new data; the dashboard (npm start) shows it the next
// time you load the page. Output goes to ~/screen_time_archive/logs/archive.log.
//
// Run:
//   npm run schedule -- install          (every day at 10:00 PM)
//   npm run schedule -- install 08:30    (every day at 8:30 AM)
//   npm run schedule -- status           (is it scheduled, and the latest log)
//   npm run schedule -- run              (run the scheduled job now, to test it)
//   npm run schedule -- uninstall        (stop running automatically)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARCHIVE_DIR } from "./screen_time_lib.mjs";

const LABEL = "local.screen_time_tracker.archive";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(ARCHIVE_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "archive.log");
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_SCRIPT = path.join(PROJECT_DIR, "archive_screen_time.mjs");
const NODE = process.execPath;
const DOMAIN = `gui/${process.getuid?.() ?? ""}`;

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPlist(hour, minute) {
  const args = [NODE, "--no-warnings", ARCHIVE_SCRIPT];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(PROJECT_DIR)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_FILE)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function launchctl(args, { quiet = false } = {}) {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    if (!quiet) console.log(`  launchctl ${args.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
    return { ok: false, out: "" };
  }
}

function isLoaded() {
  return launchctl(["print", `${DOMAIN}/${LABEL}`], { quiet: true }).ok;
}

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text ?? "22:00");
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function formatTime(hour, minute) {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function install(timeArg) {
  const time = parseTime(timeArg);
  if (!time) {
    console.log(`"${timeArg}" isn't a valid time. Use 24-hour HH:MM, like 22:00 or 08:30.`);
    return;
  }

  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (isLoaded()) launchctl(["bootout", `${DOMAIN}/${LABEL}`], { quiet: true });
  fs.writeFileSync(PLIST, buildPlist(time.hour, time.minute));
  if (!launchctl(["bootstrap", DOMAIN, PLIST]).ok) return;

  console.log(`Scheduled: the archiver will run every day at ${formatTime(time.hour, time.minute)}.`);
  console.log(`Log: ${LOG_FILE}`);
  console.log(`
One more step. Scheduled runs don't go through Terminal, so Node needs its
own Full Disk Access to read Screen Time data:

  1. Open System Settings > Privacy & Security > Full Disk Access
  2. Click +, then press Cmd + Shift + G and paste:
       ${NODE}
  3. Click Open and make sure the new entry is switched on

Then test it with:
  npm run schedule -- run
  npm run schedule -- status

If you move this folder or update Node, run "install" again.`);
}

function uninstall() {
  if (isLoaded()) launchctl(["bootout", `${DOMAIN}/${LABEL}`]);
  if (fs.existsSync(PLIST)) fs.rmSync(PLIST);
  console.log("The archiver will no longer run automatically. Your archive and logs are untouched.");
}

function status() {
  if (!fs.existsSync(PLIST)) {
    console.log("Not scheduled. Run: npm run schedule -- install");
    return;
  }
  const plist = fs.readFileSync(PLIST, "utf8");
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)/.exec(plist)?.[1];
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)/.exec(plist)?.[1];
  const time = hour !== undefined ? formatTime(Number(hour), Number(minute ?? 0)) : "unknown time";
  console.log(`Scheduled every day at ${time} (${isLoaded() ? "active" : "not active, run install again"}).`);

  if (!plist.includes(xml(NODE))) {
    console.log(`Note: it was set up with a different Node than ${NODE}. Run install again if you updated Node.`);
  }

  if (!fs.existsSync(LOG_FILE)) {
    console.log("No runs logged yet.");
    return;
  }
  // Show the most recent run from the log
  const log = fs.readFileSync(LOG_FILE, "utf8");
  const start = log.lastIndexOf("=== Archive run");
  const lastRun = (start >= 0 ? log.slice(start) : log.split("\n").slice(-25).join("\n")).trim();
  console.log("\nLatest run:\n" + lastRun.split("\n").map((l) => "  " + l).join("\n"));
  if (/Permission denied|EPERM/.test(lastRun)) {
    console.log(`\nThe last run couldn't read Screen Time data. Give Full Disk Access to:\n  ${NODE}`);
  }
}

function runNow() {
  if (!isLoaded()) {
    console.log("Not scheduled yet. Run: npm run schedule -- install");
    return;
  }
  if (launchctl(["kickstart", `${DOMAIN}/${LABEL}`]).ok) {
    console.log("Started. Give it about 10 seconds, then check: npm run schedule -- status");
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.log("This script only runs on macOS.");
    return;
  }
  const [command, arg] = process.argv.slice(2);
  if (command === "install") install(arg);
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else if (command === "run") runNow();
  else console.log("Usage: npm run schedule -- install [HH:MM] | status | run | uninstall");
}

main();
