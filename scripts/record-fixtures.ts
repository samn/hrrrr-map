/**
 * Records the HTTP traffic needed for deterministic Playwright tests: opens
 * the real icechunk store and loads the coarse-pass frames for both layers,
 * saving every request body to tests/fixtures/http/ plus a manifest keyed by
 * URL + Range header. The Playwright suite replays these with page.route.
 *
 * Usage: npm run record-fixtures
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, STORE_URL } from "../src/config.ts";
import { loadField, openHrrrDataset } from "../src/lib/store.ts";

const OUT_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "http");
const COARSE_LEADS = [0, 6, 12, 18, 24, 30, 36, 42, 48];

interface FixtureEntry {
  url: string;
  range: string;
  status: number;
  file: string | null;
  contentType: string;
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const entries = new Map<string, FixtureEntry>();
const origFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const range = headers.get("range") ?? "";
  const res = await origFetch(input, init);
  const key = `${url}|${range}`;
  if (!entries.has(key)) {
    const body = new Uint8Array(await res.clone().arrayBuffer());
    let file: string | null = null;
    if (res.ok) {
      file = createHash("sha1").update(key).digest("hex").slice(0, 20) + ".bin";
      writeFileSync(join(OUT_DIR, file), body);
    }
    entries.set(key, {
      url,
      range,
      status: res.status,
      file,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    });
    console.log(`${res.status} ${(body.length / 1024).toFixed(1)}kB ${url.slice(0, 110)} ${range}`);
  }
  return res;
}) as typeof fetch;

const dataset = await openHrrrDataset(
  STORE_URL,
  LAYERS.map((l) => ({ name: l.arrayName, scale: l.scale })),
);
const initTime = dataset.initTimes[dataset.latestInitIndex]!;
console.log(`\nrecording init ${initTime.toISOString()} (index ${dataset.latestInitIndex})`);

for (const layer of LAYERS) {
  for (const lead of COARSE_LEADS) {
    await loadField(dataset, { name: layer.arrayName, scale: layer.scale }, dataset.latestInitIndex, lead);
  }
}

const manifest = {
  recordedAt: new Date().toISOString(),
  initTimeMs: initTime.getTime(),
  initTimeIso: initTime.toISOString(),
  latestInitIndex: dataset.latestInitIndex,
  coarseLeads: COARSE_LEADS,
  entries: [...entries.values()],
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

let total = 0;
for (const e of entries.values()) if (e.file) total++;
console.log(`\nwrote ${total} bodies + manifest.json to ${OUT_DIR}`);
