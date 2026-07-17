/**
 * End-to-end spike: open the real store, find the latest complete init, read
 * one precip + one smoke field through zarrita + the gribberish codec, and
 * report network usage. Usage: node --experimental-strip-types scripts/spike-read.ts
 */
import { PRECIP_LAYER, SMOKE_LAYER, STORE_URL } from "../src/config.ts";
import { loadField, openHrrrDataset } from "../src/lib/store.ts";

let requests = 0;
let bytes = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  const res = await origFetch(input, init);
  const len = res.headers.get("content-length");
  if (len) bytes += Number(len);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  console.log(`  [net] ${res.status} ${(Number(len) / 1024).toFixed(1)}kB ${url.slice(0, 130)}`);
  return res;
}) as typeof fetch;

const t0 = performance.now();
const ds = await openHrrrDataset(STORE_URL, [
  { name: PRECIP_LAYER.arrayName, scale: PRECIP_LAYER.scale },
  { name: SMOKE_LAYER.arrayName, scale: SMOKE_LAYER.scale },
]);
console.log(`\nopened in ${(performance.now() - t0).toFixed(0)}ms; ${requests} requests, ${(bytes / 1024 / 1024).toFixed(2)}MB`);
console.log(`inits: ${ds.initTimes.length}, latest complete: #${ds.latestInitIndex} = ${ds.initTimes[ds.latestInitIndex]!.toISOString()}`);
console.log(`leads: ${ds.leadTimeHours.length} (${ds.leadTimeHours[0]}..${ds.leadTimeHours.at(-1)}h)`);

for (const layer of [PRECIP_LAYER, SMOKE_LAYER]) {
  const t1 = performance.now();
  const { values, ny, nx } = await loadField(ds, { name: layer.arrayName, scale: layer.scale }, ds.latestInitIndex, 6);
  let min = Infinity, max = -Infinity, nan = 0, sum = 0;
  for (const v of values) {
    if (Number.isNaN(v)) { nan++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  console.log(
    `${layer.id}: ${ny}x${nx} in ${(performance.now() - t1).toFixed(0)}ms; ` +
    `min=${min.toExponential(2)} max=${max.toExponential(2)} mean=${(sum / values.length).toExponential(2)} nan=${nan} ${layer.units}`,
  );
}
console.log(`\ntotal: ${requests} requests, ${(bytes / 1024 / 1024).toFixed(2)}MB`);
