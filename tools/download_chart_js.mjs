// tools/download_chart_js.mjs
//
// Downloads Chart.js (the chart library the dashboard uses) into
// public/vendor/, so the dashboard works without internet. Run it once.
// Without it, the dashboard loads Chart.js from the internet instead.
//
// Run:
//   node tools/download_chart_js.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "4.4.1";
const URL = `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/${VERSION}/chart.umd.min.js`;
const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(projectDir, "public", "vendor", "chart.umd.min.js");

const res = await fetch(URL);
if (!res.ok) {
  console.log(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const text = await res.text();
if (!text.includes("Chart")) {
  console.log("That didn't look like Chart.js, so it wasn't saved.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`Saved Chart.js ${VERSION} to ${path.relative(projectDir, OUT)} (${Math.round(text.length / 1024)} KB)`);
