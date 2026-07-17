/**
 * Downloads a small set of real HRRR GRIB2 messages (single-message byte
 * ranges) used as unit-test fixtures for the pure-TS GRIB decoder.
 *
 * The source date is pinned so re-running produces identical bytes.
 * Usage: npm run fetch-grib-fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGribIndex } from "@mattnucc/gribberish";

const BASE = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250612/conus";
const OUT_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "grib");

interface Target {
  file: string;
  var: string;
  level: string;
  out: string;
}

const TARGETS: Target[] = [
  { file: "hrrr.t00z.wrfsfcf06.grib2", var: "PRATE", level: "surface", out: "prate_f06.grib2" },
  { file: "hrrr.t00z.wrfsfcf24.grib2", var: "PRATE", level: "surface", out: "prate_f24.grib2" },
  { file: "hrrr.t00z.wrfsfcf06.grib2", var: "MASSDEN", level: "8 m above ground", out: "massden_f06.grib2" },
  { file: "hrrr.t00z.wrfsfcf24.grib2", var: "MASSDEN", level: "8 m above ground", out: "massden_f24.grib2" },
];

mkdirSync(OUT_DIR, { recursive: true });

const meta: Record<string, { source: string; range: string }> = {};

for (const t of TARGETS) {
  const idxUrl = `${BASE}/${t.file}.idx`;
  const idxText = await (await fetch(idxUrl)).text();
  const entries = parseGribIndex(idxText);
  const entry = entries.find((e) => e.var === t.var && e.level === t.level);
  if (!entry) throw new Error(`${t.var} @ ${t.level} not found in ${idxUrl}`);
  const end = entry.length ? entry.offset + entry.length - 1 : "";
  const range = `bytes=${entry.offset}-${end}`;
  const res = await fetch(`${BASE}/${t.file}`, { headers: { Range: range } });
  if (res.status !== 206) throw new Error(`Range request failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(join(OUT_DIR, t.out), bytes);
  meta[t.out] = { source: `${BASE}/${t.file}`, range };
  console.log(`${t.out}: ${bytes.length} bytes (${t.var} @ ${t.level})`);
}

writeFileSync(join(OUT_DIR, "sources.json"), JSON.stringify(meta, null, 2) + "\n");
