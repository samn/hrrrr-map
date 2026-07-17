/**
 * Builds a fully self-contained HTML preview of the app: replays the
 * recorded e2e fixtures through the real store + decode + reprojection
 * pipeline, renders each coarse lead as an indexed PNG per layer, and wraps
 * them in the app's UI chrome (scrubber, play/pause, layer chips).
 *
 * Usage: node --experimental-strip-types scripts/export-preview.ts <out.html>
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, STORE_URL } from "../src/config.ts";
import { makeLut, makeQuantizer, quantizeField, PRECIP_COLORMAP, SMOKE_COLORMAP } from "../src/lib/colormap.ts";
import { HRRR_GRID } from "../src/lib/lcc.ts";
import { buildIndexMap, lonLatToMercator } from "../src/lib/reproject.ts";
import { loadField, openHrrrDataset } from "../src/lib/store.ts";

const FIXTURE_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "http");
const OUT = process.argv[2] ?? join(import.meta.dirname, "..", "preview.html");
const WIDTH = 1150;

// ---- replay recorded fixtures through global fetch ----

interface Entry {
  url: string;
  range: string;
  status: number;
  file: string | null;
  contentType: string;
}
const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as {
  initTimeMs: number;
  coarseLeads: number[];
  entries: Entry[];
};
const byKey = new Map(manifest.entries.map((e) => [`${e.url}|${e.range}`, e]));

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const key = `${url}|${headers.get("range") ?? ""}`;
  const entry = byKey.get(key);
  if (!entry || !entry.file) return new Response(null, { status: 404 });
  return new Response(readFileSync(join(FIXTURE_DIR, entry.file)) as unknown as BodyInit, {
    status: entry.status,
    headers: { "content-type": entry.contentType },
  });
}) as typeof fetch;

// ---- minimal indexed-PNG encoder (color type 3, 8-bit, PLTE + tRNS) ----

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(t, data));
  return out;
}

function encodeIndexedPng(indices: Uint8Array, w: number, h: number, lut: Uint8ClampedArray): Buffer {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed color
  const plte = new Uint8Array(256 * 3);
  const trns = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    plte[i * 3] = lut[i * 4]!;
    plte[i * 3 + 1] = lut[i * 4 + 1]!;
    plte[i * 3 + 2] = lut[i * 4 + 2]!;
    trns[i] = lut[i * 4 + 3]!;
  }
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(indices.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("tRNS", trns),
    chunk("IDAT", new Uint8Array(idat)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---- render frames ----

const map = buildIndexMap(HRRR_GRID, WIDTH, HRRR_GRID.ny, HRRR_GRID.nx);
const dataset = await openHrrrDataset(
  STORE_URL,
  LAYERS.map((l) => ({ name: l.arrayName, scale: l.scale })),
);

const COLORMAPS = { smoke: SMOKE_COLORMAP, precip: PRECIP_COLORMAP } as const;
const frames: Record<string, Record<number, string>> = { smoke: {}, precip: {} };

for (const layer of LAYERS) {
  const q = makeQuantizer(COLORMAPS[layer.id]);
  const lut = makeLut(COLORMAPS[layer.id]);
  for (const lead of manifest.coarseLeads) {
    const { values, ny, nx } = await loadField(
      dataset,
      { name: layer.arrayName, scale: layer.scale },
      dataset.latestInitIndex,
      lead,
    );
    const { data } = quantizeField(q, values, ny, nx, 1);
    const px = new Uint8Array(map.width * map.height);
    for (let i = 0; i < map.indices.length; i++) {
      const idx = map.indices[i]!;
      px[i] = idx >= 0 ? data[idx]! : 0;
    }
    const png = encodeIndexedPng(px, map.width, map.height, lut);
    frames[layer.id]![lead] = `data:image/png;base64,${png.toString("base64")}`;
    console.log(`${layer.id} +${lead}h: ${(png.length / 1024).toFixed(0)}kB`);
  }
}

// ---- basemap SVG from the test style's Natural Earth states ----

const style = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "basemap-style.json"), "utf8"));
const geojson = style.sources.states.data as { features: { geometry: { type: string; coordinates: unknown } }[] };
const [tl, , br] = map.corners as [number, number][];
const [mx0, my0] = lonLatToMercator(tl![0]!, tl![1]!);
const [mx1, my1] = lonLatToMercator(br![0]!, br![1]!);

function toPx(lon: number, lat: number): string {
  const [mx, my] = lonLatToMercator(lon, lat);
  const x = ((mx - mx0) / (mx1 - mx0)) * map.width;
  const y = ((my - my0) / (my1 - my0)) * map.height;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

let paths = "";
for (const f of geojson.features) {
  const polys =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates as number[][][]]
      : f.geometry.type === "MultiPolygon"
        ? (f.geometry.coordinates as number[][][][])
        : [];
  let d = "";
  for (const poly of polys) {
    for (const ring of poly) {
      d += `M${ring.map(([lon, lat]) => toPx(lon!, lat!)).join("L")}Z`;
    }
  }
  if (d) paths += `<path d="${d}"/>`;
}

// ---- assemble the page ----

const gradient = (cm: typeof SMOKE_COLORMAP) =>
  `linear-gradient(90deg, ${cm.stops
    .map((s, i) => `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${(s.color[3] / 255).toFixed(2)}) ${((i / (cm.stops.length - 1)) * 100).toFixed(0)}%`)
    .join(", ")})`;

const DATA = JSON.stringify({
  initTimeMs: manifest.initTimeMs,
  leads: manifest.coarseLeads,
  frames,
});

const html = `<title>Smoke & Rain — HRRR forecast preview</title>
<style>
  :root {
    --panel-bg: rgba(16, 20, 24, 0.84);
    --panel-fg: #f2f5f7;
    --panel-dim: #a8b3bb;
    --accent: #4aa8e8;
    --page-bg: #eef1f3;
    --page-fg: #1c2228;
    --page-dim: #5b6770;
    --base-land: #f7f9fa;
    --base-water: #e9edf0;
    --base-line: #b7c0c7;
  }
  @media (prefers-color-scheme: dark) {
    :root { --page-bg: #101418; --page-fg: #e8edf0; --page-dim: #97a3ab; --base-land: #232a31; --base-water: #1a2026; --base-line: #3d4750; }
  }
  :root[data-theme="dark"] { --page-bg: #101418; --page-fg: #e8edf0; --page-dim: #97a3ab; --base-land: #232a31; --base-water: #1a2026; --base-line: #3d4750; }
  :root[data-theme="light"] { --page-bg: #eef1f3; --page-fg: #1c2228; --page-dim: #5b6770; --base-land: #f7f9fa; --base-water: #e9edf0; --base-line: #b7c0c7; }

  body { background: var(--page-bg); color: var(--page-fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 20px 12px 40px; }
  .wrap { max-width: 1150px; margin: 0 auto; }
  .note { font-size: 13px; color: var(--page-dim); margin: 0 auto 14px; max-width: 72ch; line-height: 1.5; }
  .note strong { color: var(--page-fg); font-weight: 600; }
  .note a { color: var(--accent); }

  .stage { position: relative; border-radius: 14px; overflow: hidden;
    background: var(--base-water); box-shadow: 0 8px 30px rgba(0,0,0,0.25);
    aspect-ratio: ${map.width} / ${map.height + 150}; }
  .viewport { position: absolute; inset: 0; }
  .layerstack { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); aspect-ratio: ${map.width} / ${map.height}; }
  .layerstack svg, .layerstack img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .layerstack svg path { fill: var(--base-land); stroke: var(--base-line); stroke-width: 1; }
  .layerstack img { image-rendering: auto; opacity: 0; transition: none; }

  .top-bar { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between;
    align-items: flex-start; gap: 8px; padding: 10px 12px;
    background: linear-gradient(rgba(16,20,24,0.72), rgba(16,20,24,0)); }
  .title-box h1 { font-size: 17px; font-weight: 700; margin: 0; color: var(--panel-fg); letter-spacing: 0.2px; }
  .init-label { font-size: 11px; color: var(--panel-dim); margin-top: 2px; }
  .chip-row { display: flex; gap: 8px; }
  .chip { display: flex; flex-direction: column; gap: 3px; min-width: 84px; padding: 6px 10px;
    border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; background: var(--panel-bg);
    color: var(--panel-fg); font: 600 12px inherit; font-family: inherit; cursor: pointer; opacity: 0.55; text-align: left; }
  .chip[aria-pressed="true"] { opacity: 1; border-color: rgba(255,255,255,0.35); }
  .chip .grad { height: 6px; border-radius: 3px; }
  .chip .range { font-size: 9px; font-weight: 400; color: var(--panel-dim); }
  .chip:focus-visible, .play-btn:focus-visible, .scrubber:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (max-width: 640px) { .stage { aspect-ratio: 4 / 5; } }
  .bottom-bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 14px 12px;
    background: linear-gradient(rgba(16,20,24,0), rgba(16,20,24,0.88) 30%); color: var(--panel-fg); }
  .time-row { display: flex; align-items: center; gap: 12px; }
  .play-btn { width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.25);
    background: rgba(255,255,255,0.12); color: var(--panel-fg); font-size: 16px; cursor: pointer; }
  .time-label { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .rel-label { font-size: 13px; color: var(--panel-dim); margin-left: 10px; font-variant-numeric: tabular-nums; }
  .scrubber { width: 100%; height: 32px; -webkit-appearance: none; appearance: none; background: transparent;
    touch-action: none; cursor: pointer; margin: 4px 0 0; }
  .scrubber::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.22); }
  .scrubber::-webkit-slider-thumb { -webkit-appearance: none; width: 24px; height: 24px; margin-top: -9px;
    border-radius: 50%; border: 2px solid #fff; background: var(--accent); box-shadow: 0 1px 5px rgba(0,0,0,0.5); }
  .scrubber::-moz-range-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.22); }
  .scrubber::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff; background: var(--accent); }
  .axis-row { display: flex; justify-content: space-between; font-size: 10px; color: var(--panel-dim); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .autoplay-off { } }
</style>
<div class="wrap">
  <p class="note"><strong>Static preview of the Smoke &amp; Rain app</strong> (<a href="https://github.com/samn/hrrrr-map/pull/1">PR #1</a>).
  Frames below are the app's real render pipeline output for the HRRR run initialized <span id="init-utc"></span> &mdash;
  the same recorded data the visual-regression tests replay. The deployed site streams live NOAA data in-browser,
  updates every 6 hours, adds hourly frames, and supports pan/zoom + centering on your location.</p>

  <div class="stage">
    <div class="viewport">
      <div class="layerstack" id="stack">
        <svg viewBox="0 0 ${map.width} ${map.height}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>
      </div>
    </div>
    <div class="top-bar">
      <div class="title-box">
        <h1>Smoke &amp; Rain</h1>
        <div class="init-label" id="init-label"></div>
      </div>
      <div class="chip-row">
        <button class="chip" id="chip-smoke" aria-pressed="true">Smoke
          <span class="grad" style="background:${gradient(SMOKE_COLORMAP)}"></span>
          <span class="range">2&ndash;500 &micro;g/m&sup3;</span></button>
        <button class="chip" id="chip-precip" aria-pressed="true">Rain
          <span class="grad" style="background:${gradient(PRECIP_COLORMAP)}"></span>
          <span class="range">0.1&ndash;100 mm/hr</span></button>
      </div>
    </div>
    <div class="bottom-bar">
      <div class="time-row">
        <button class="play-btn" id="play" aria-label="Play animation">&#9654;</button>
        <div><span class="time-label" id="time-label">—</span><span class="rel-label" id="rel-label">+0h</span></div>
      </div>
      <input class="scrubber" id="scrubber" type="range" min="0" max="48" step="0.1" value="0" aria-label="Forecast hour" />
      <div class="axis-row"><span>0h</span><span>+12h</span><span>+24h</span><span>+36h</span><span>+48h</span></div>
    </div>
  </div>
</div>
<script>
const DATA = ${DATA};
const stack = document.getElementById("stack");
const layers = { smoke: { on: true, imgs: {} }, precip: { on: true, imgs: {} } };
for (const id of ["smoke", "precip"]) {
  for (const lead of DATA.leads) {
    const img = document.createElement("img");
    img.src = DATA.frames[id][lead];
    img.alt = "";
    stack.appendChild(img);
    layers[id].imgs[lead] = img;
  }
}

const init = new Date(DATA.initTimeMs);
document.getElementById("init-utc").textContent =
  init.toISOString().replace("T", " ").slice(0, 16) + " UTC";
document.getElementById("init-label").textContent = "HRRR forecast from " +
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric" }).format(init) +
  " \u00b7 static preview";

let t = 0, playing = false, lastTs = null, raf = null;
const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" });
const scrubber = document.getElementById("scrubber");
const playBtn = document.getElementById("play");

function render() {
  const leads = DATA.leads;
  let a = leads[0], b = leads[leads.length - 1];
  for (const l of leads) { if (l <= t) a = l; }
  for (let i = leads.length - 1; i >= 0; i--) { if (leads[i] >= t) b = leads[i]; }
  const blend = b > a ? (t - a) / (b - a) : 0;
  for (const id of ["smoke", "precip"]) {
    const layer = layers[id];
    for (const lead of leads) {
      const img = layer.imgs[lead];
      if (!layer.on) { img.style.opacity = 0; continue; }
      img.style.opacity = lead === a ? 1 - (lead === b ? 0 : blend) : lead === b ? blend : 0;
    }
  }
  document.getElementById("time-label").textContent = fmt.format(new Date(DATA.initTimeMs + t * 3600e3));
  document.getElementById("rel-label").textContent = "+" + Math.round(t) + "h";
  if (document.activeElement !== scrubber || playing) scrubber.value = String(t);
}

function tick(ts) {
  if (!playing) return;
  if (lastTs !== null) {
    t += Math.min(0.25, (ts - lastTs) / 1000) * 6;
    if (t > 48) t = 0;
    render();
  }
  lastTs = ts;
  raf = requestAnimationFrame(tick);
}

function setPlaying(on) {
  playing = on;
  playBtn.innerHTML = on ? "&#10074;&#10074;" : "&#9654;";
  playBtn.setAttribute("aria-label", on ? "Pause animation" : "Play animation");
  lastTs = null;
  if (on) raf = requestAnimationFrame(tick);
  else if (raf) cancelAnimationFrame(raf);
}

playBtn.addEventListener("click", () => setPlaying(!playing));
scrubber.addEventListener("input", () => { if (playing) setPlaying(false); t = Number(scrubber.value); render(); });
for (const id of ["smoke", "precip"]) {
  const chip = document.getElementById("chip-" + id);
  chip.addEventListener("click", () => {
    layers[id].on = !layers[id].on;
    chip.setAttribute("aria-pressed", String(layers[id].on));
    render();
  });
}

render();
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
</script>
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024 / 1024).toFixed(2)}MB)`);
