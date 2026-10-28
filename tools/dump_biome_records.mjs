// tools/dump_biome_records.mjs
//
// Read-only. Shows the structure of records in a Biome stream file, so a
// decoder can be written against the actual layout. Records are found using
// the file's own index (SEGB format) and every protobuf field is printed,
// with timestamps converted to dates.
//
// App.InFocus is read from your archive copy. Any other stream is read from
// ~/Library/Biome/streams (needs Full Disk Access for Terminal).
//
// Run:
//   node tools/dump_biome_records.mjs                              (App.InFocus, iPhone)
//   node tools/dump_biome_records.mjs App.InFocus local            (App.InFocus, this Mac)
//   node tools/dump_biome_records.mjs ScreenTime.AppUsage          (another stream, this Mac)
//   node tools/dump_biome_records.mjs ScreenTime.AppUsage local 10 (show 10 records)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ARCHIVED_IN_FOCUS = path.join(HOME, "screen_time_archive", "biome_raw", "App.InFocus");
const STREAM_ROOTS = [
  path.join(HOME, "Library/Biome/streams/restricted"),
  path.join(HOME, "Library/Biome/streams/public"),
];
const APPLE_EPOCH_OFFSET = 978307200;

const STREAM = process.argv[2] || "App.InFocus";
const FOLDER_ARG = process.argv[3];
const RECORDS_TO_SHOW = Number(process.argv[4]) || 4;

function hex(buf, start, len) {
  const out = [];
  for (let i = start; i < Math.min(buf.length, start + len); i += 16) {
    const slice = buf.subarray(i, Math.min(i + 16, start + len, buf.length));
    const h = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const a = [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    out.push(`  ${i.toString().padStart(7)}  ${h.padEnd(48)}  ${a}`);
  }
  return out.join("\n");
}

// Plausible Apple timestamp (2020 to 2030)?
function asDate(v) {
  if (v > 600000000 && v < 950000000) {
    return new Date((v + APPLE_EPOCH_OFFSET) * 1000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    });
  }
  return null;
}

function readVarint(buf, pos, end = buf.length) {
  let result = 0n, shift = 0n;
  while (pos < end) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
    if (shift > 70n) break;
  }
  throw new Error("bad varint");
}

// Generic protobuf decode; returns lines or throws if the bytes don't parse
function decodeProto(buf, start, end, depth = 0) {
  const lines = [];
  let pos = start;
  const pad = "    ".repeat(depth + 1);
  while (pos < end) {
    const [key, p1] = readVarint(buf, pos, end);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (field === 0 || field > 1000) throw new Error(`implausible field ${field} at ${pos}`);
    pos = p1;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos, end); pos = p2;
      const date = asDate(Number(v));
      lines.push(`${pad}field ${field} varint ${v}${date ? "  = " + date : ""}`);
    } else if (wire === 1) {
      if (pos + 8 > end) throw new Error("short double");
      const d = buf.readDoubleLE(pos); pos += 8;
      const date = asDate(d);
      lines.push(`${pad}field ${field} double ${d}${date ? "  = " + date : ""}`);
    } else if (wire === 2) {
      const [lenBig, p2] = readVarint(buf, pos, end); pos = p2;
      const len = Number(lenBig);
      if (pos + len > end) throw new Error("length past end");
      const bytes = buf.subarray(pos, pos + len);
      const printable = len > 0 && [...bytes].every((b) => b >= 0x20 && b <= 0x7e);
      if (printable) {
        lines.push(`${pad}field ${field} string "${bytes.toString("latin1")}"`);
      } else {
        try {
          const inner = decodeProto(buf, pos, pos + len, depth + 1);
          lines.push(`${pad}field ${field} message {`, ...inner, `${pad}}`);
        } catch {
          lines.push(`${pad}field ${field} bytes (${len}) ${bytes.subarray(0, 24).toString("hex")}`);
        }
      }
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > end) throw new Error("short fixed32");
      const f = buf.readFloatLE(pos), u = buf.readUInt32LE(pos); pos += 4;
      lines.push(`${pad}field ${field} fixed32 ${u} (float ${f})`);
    } else {
      throw new Error(`wire type ${wire} at ${pos}`);
    }
  }
  return lines;
}

// Find the stream folder, then the device folder inside it
function pickFolder() {
  let base;
  if (STREAM === "App.InFocus" && fs.existsSync(ARCHIVED_IN_FOCUS)) {
    base = ARCHIVED_IN_FOCUS;
  } else {
    base = STREAM_ROOTS.map((r) => path.join(r, STREAM)).find((p) => fs.existsSync(p));
  }
  if (!base) return { error: `No stream named ${STREAM} in ${STREAM_ROOTS.join(" or ")}` };

  if (FOLDER_ARG) return { folder: path.join(base, FOLDER_ARG) };

  // App.InFocus defaults to the most recently updated remote device (the
  // iPhone); other streams default to this Mac
  const remote = path.join(base, "remote");
  if (STREAM === "App.InFocus" && fs.existsSync(remote)) {
    let best = null, bestTime = 0;
    for (const d of fs.readdirSync(remote).map((d) => path.join(remote, d))) {
      for (const f of fs.readdirSync(d)) {
        const st = fs.statSync(path.join(d, f));
        if (st.isFile() && st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = d; }
      }
    }
    if (best) return { folder: best };
  }
  return { folder: path.join(base, "local") };
}

// Records via the SEGB v2 index at the end of the file (16 bytes each,
// growing backwards): u32 end offset relative to byte 32, u32 state, double
function segbRecords(buf) {
  if (buf.length < 48 || buf.toString("latin1", 0, 4) !== "SEGB") return null;
  const count = buf.readUInt32LE(4);
  const records = [];
  let prevEnd = 0;
  for (let i = 0; i < count; i++) {
    const idx = buf.length - 16 * (i + 1);
    if (idx < 32) break;
    const endRel = buf.readUInt32LE(idx);
    const state = buf.readUInt32LE(idx + 4);
    const start = 32 + Math.ceil(prevEnd / 4) * 4;
    const end = 32 + endRel;
    prevEnd = endRel;
    if (end > idx || start + 8 > end) return { records, count, broken: i };
    records.push({ i, start, end, state });
  }
  return { records, count, broken: null };
}

function main() {
  const picked = pickFolder();
  if (picked.error) { console.log(picked.error); return; }
  const folder = picked.folder;
  if (!fs.existsSync(folder)) { console.log(`Not found: ${folder}`); return; }

  const files = fs.readdirSync(folder)
    .map((f) => path.join(folder, f))
    .filter((f) => fs.statSync(f).isFile() && fs.statSync(f).size > 64)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) { console.log(`No files in ${folder}`); return; }

  const file = files[0];
  const buf = fs.readFileSync(file);
  console.log(`Stream: ${STREAM}`);
  console.log(`Folder: ${folder}`);
  console.log(`File:   ${path.basename(file)} (${buf.length} bytes, modified ${fs.statSync(file).mtime.toLocaleString()})`);
  console.log(`Other files in this folder: ${files.length - 1}`);

  console.log("\nFirst 48 bytes:");
  console.log(hex(buf, 0, 48));

  const seg = segbRecords(buf);
  if (!seg) {
    console.log("\nThis file isn't in the SEGB format the decoder knows, so records can't be located.");
    return;
  }
  const valid = seg.records.filter((r) => r.state === 1);
  console.log(`\nIndex: ${seg.count} records listed, ${valid.length} valid, ` +
    `${seg.records.length - valid.length} marked deleted` +
    (seg.broken !== null ? `, index stopped making sense at record ${seg.broken}` : ""));

  // The first and last few valid records, to see both old and new entries
  const half = Math.max(1, Math.ceil(RECORDS_TO_SHOW / 2));
  const pick = valid.length <= RECORDS_TO_SHOW ? valid : [...valid.slice(0, half), ...valid.slice(-half)];
  for (const r of pick) {
    console.log("\n" + "-".repeat(60));
    console.log(`Record ${r.i} (bytes ${r.start} to ${r.end}):`);
    console.log(hex(buf, r.start, Math.min(r.end - r.start, 96)));
    try {
      console.log("Decoded (after the 8-byte record prefix):");
      console.log(decodeProto(buf, r.start + 8, r.end).join("\n"));
    } catch (err) {
      console.log(`Could not decode as protobuf: ${err.message}`);
    }
  }
}

main();
