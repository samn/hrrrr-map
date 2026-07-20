import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { BASEMAP_STYLE_URL, LAYERS, PRECIP_LAYER, SMOKE_LAYER, STORE_URL } from "./config.ts";
import { makeLut, PRECIP_COLORMAP, SMOKE_COLORMAP } from "./lib/colormap.ts";
import { FrameStore } from "./lib/frames.ts";
import { HRRR_GRID } from "./lib/lcc.ts";
import { Timeline } from "./lib/timeline.ts";
import { GpuForecastLayer, gpuRendererSupported } from "./render/gpuLayer.ts";
import { ForecastLayer, type OverlayPlacement } from "./render/layer.ts";
import { AppUI } from "./ui/ui.ts";
import type { MainToWorker, PaintJob, WorkerToMain } from "./worker/protocol.ts";

const COLORMAPS = { smoke: SMOKE_COLORMAP, precip: PRECIP_COLORMAP } as const;

const params = new URLSearchParams(location.search);
const autoplay = params.get("autoplay") !== "0";
/**
 * GPU renderer (reprojection + crossfade + palette in a custom-layer shader)
 * by default; the worker-painted canvas renderer is the fallback when WebGL2
 * or the shader won't initialize. `?gpu=1`/`?gpu=0` force a renderer.
 */
const gpuParam = params.get("gpu");
const useGpu = gpuParam === "0" ? false : gpuParam === "1" ? true : gpuRendererSupported();
// Test hook: lets e2e specs assert on renderer selection.
(window as unknown as { __renderer: string }).__renderer = useGpu ? "gpu" : "canvas";

// CONUS overview used until (and unless) we get a location fix.
const CONUS_CENTER: [number, number] = [-97.5, 39.0];
const CONUS_ZOOM = 3.4;
const LOCATED_ZOOM = 6.3;

function inHrrrDomain(lon: number, lat: number): boolean {
  return lon >= -134 && lon <= -60 && lat >= 21 && lat <= 53;
}

const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
const downsample = isCoarsePointer ? 2 : 1;
const canvasWidth = isCoarsePointer ? 1000 : 1600;

const overlayRoot = document.getElementById("overlay")!;

const enabled = new Map<string, boolean>(LAYERS.map((l) => [l.id, true]));

const ui = new AppUI(
  overlayRoot,
  [
    { config: SMOKE_LAYER, colormap: SMOKE_COLORMAP, rangeText: "2–500 µg/m³" },
    { config: PRECIP_LAYER, colormap: PRECIP_COLORMAP, rangeText: "0.1–100 mm/hr" },
  ],
  {
    onScrub: (t) => timeline.scrubTo(t),
    onPlayToggle: () => timeline.toggle(),
    onLayerToggle: (id, on) => {
      enabled.set(id, on);
      forecastLayers.get(id)?.setVisible(on);
      gpuLayers.get(id)?.setVisible(on);
      renderFrames();
    },
    onLocate: () => requestLocation(true),
  },
);

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP_STYLE_URL,
  center: CONUS_CENTER,
  zoom: CONUS_ZOOM,
  minZoom: 2.5,
  maxZoom: 11,
  attributionControl: { compact: true, customAttribution: "Forecast: NOAA HRRR via dynamical.org (CC BY 4.0)" },
});
map.touchPitch.disable();
map.keyboard.enable();
// Test hook: lets e2e specs assert on map state (center, layers).
(window as unknown as { __map: maplibregl.Map }).__map = map;
map.on("error", (e) => {
  // Basemap/tile errors shouldn't kill the app; the forecast overlay works
  // without them.
  console.warn("map error:", e.error?.message ?? e);
});

const timeline = new Timeline({ maxHours: 48 });

const worker = new Worker(new URL("./worker/dataWorker.ts", import.meta.url), { type: "module" });
worker.postMessage({
  type: "open",
  storeUrl: STORE_URL,
  layerIds: LAYERS.map((l) => l.id),
  downsample,
  canvasWidth,
  sendFrameBytes: useGpu,
} satisfies MainToWorker);

let frameStore: FrameStore | null = null;
let initTime: Date | null = null;
const forecastLayers = new Map<string, ForecastLayer>();
// GPU layers exist from startup so frames arriving before the basemap loads
// are kept; they attach to the map in maybeAddLayers().
const gpuLayers = new Map<string, GpuForecastLayer>(
  useGpu
    ? [SMOKE_LAYER, PRECIP_LAYER].map((config) => [
        config.id,
        new GpuForecastLayer(config.id, HRRR_GRID, downsample, makeLut(COLORMAPS[config.id])),
      ])
    : [],
);
let layersAdded = false;
let placement: OverlayPlacement | null = null;
let started = false;
let mapLoaded = false;
let renderQueued = false;

map.on("load", () => {
  mapLoaded = true;
  // Start with the compact attribution collapsed so it never covers the
  // timeline on small screens (it stays one tap away behind the ⓘ button).
  document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  document.querySelector(".maplibregl-ctrl-attrib")?.removeAttribute("open");
  maybeAddLayers();
});

function maybeAddLayers(): void {
  if (!mapLoaded || !placement || layersAdded) return;
  layersAdded = true;
  // Smoke below precip so rain cells stay readable over smoke plumes.
  for (const config of [SMOKE_LAYER, PRECIP_LAYER]) {
    const gpuLayer = gpuLayers.get(config.id);
    if (gpuLayer) {
      map.addLayer(gpuLayer);
      gpuLayer.setVisible(enabled.get(config.id) ?? true);
    } else {
      const layer = new ForecastLayer(map, config.id, placement);
      layer.addTo();
      forecastLayers.set(config.id, layer);
    }
  }
  renderFrames();
}

/**
 * Crossfade steps per frame interval. Coarser steps mean fewer worker
 * repaints during playback; 1/8 steps are invisible at playback speed.
 */
const BLEND_STEPS = 8;

/** Per-layer key of the frame pair + blend the canvas currently shows. */
const painted = new Map<string, string>();
let paintInFlight = false;
/** Spent RGBA buffers cycling back to the worker to avoid reallocation. */
const pixelPool: ArrayBuffer[] = [];

function renderFrames(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (useGpu) updateGpuLayers();
    else requestPaint();
  });
}

/**
 * Point each GPU layer at its bracketing frames + blend; a repaint costs one
 * map render, so no blend quantization or repaint dedup is needed.
 */
function updateGpuLayers(): void {
  if (!frameStore) return;
  const start = performance.now();
  let dirty = false;
  for (const [id, layer] of gpuLayers) {
    if (!enabled.get(id)) continue;
    const n = frameStore.neighbors(id, timeline.t);
    if (!n) continue;
    if (layer.setTime(n.a, n.b, n.blend)) dirty = true;
  }
  if (dirty) {
    map.triggerRepaint();
    // Main-thread cost of one overlay refresh; tests/e2e/perf.spec.ts
    // watches this to catch work sliding back onto the main thread.
    performance.measure("overlay-update", { start });
  }
}

/**
 * Ask the worker to repaint any visible layer whose bracketing frames or
 * quantized blend changed. At most one request is in flight; timeline moves
 * during a paint are picked up when the response lands.
 */
function requestPaint(): void {
  if (paintInFlight || !frameStore) return;
  const jobs: PaintJob[] = [];
  for (const id of forecastLayers.keys()) {
    if (!enabled.get(id)) continue;
    const n = frameStore.neighbors(id, timeline.t);
    if (!n) continue;
    const blend = n.a === n.b ? 0 : Math.round(n.blend * BLEND_STEPS) / BLEND_STEPS;
    const key = `${n.a}:${n.b}:${blend}`;
    if (painted.get(id) === key) continue;
    painted.set(id, key);
    jobs.push({ layerId: id, a: n.a, b: n.b, blend });
  }
  if (jobs.length === 0) return;
  paintInFlight = true;
  const recycle = pixelPool.splice(0, jobs.length);
  worker.postMessage({ type: "paint", jobs, recycle } satisfies MainToWorker, recycle);
}

function updateTimeUI(): void {
  if (!initTime) return;
  const valid = new Date(initTime.getTime() + timeline.t * 3_600_000);
  ui.setTime(valid, timeline.t, timeline.playing);
}

timeline.onChange(() => {
  updateTimeUI();
  renderFrames();
});

worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "opened": {
      initTime = new Date(msg.initTimeMs);
      frameStore = new FrameStore(
        LAYERS.map((l) => l.id),
        msg.leadHours,
      );
      frameStore.onFrame(renderFrames);
      placement = {
        width: msg.indexWidth,
        height: msg.indexHeight,
        corners: msg.corners,
      };
      const maxHours = msg.leadHours[msg.leadHours.length - 1] ?? 48;
      ui.setMaxHours(maxHours);
      ui.setInit(initTime);
      ui.setStatus("Loading frames…", false);
      updateTimeUI();
      maybeAddLayers();
      worker.postMessage({ type: "loadAll" } satisfies MainToWorker);
      break;
    }
    case "frameLoaded": {
      if (msg.data) gpuLayers.get(msg.layerId)?.setFrame(msg.leadIndex, msg.data);
      frameStore?.markLoaded(msg.layerId, msg.leadIndex);
      break;
    }
    case "painted": {
      paintInFlight = false;
      const start = performance.now();
      for (const f of msg.frames) {
        forecastLayers.get(f.layerId)?.render(f.pixels);
        pixelPool.push(f.pixels.buffer);
      }
      // Main-thread cost of one overlay refresh; tests/e2e/perf.spec.ts
      // watches this to catch work sliding back onto the main thread.
      if (msg.frames.length > 0) performance.measure("overlay-update", { start });
      // Catch up on anything that changed while this paint was in flight.
      requestPaint();
      break;
    }
    case "progress": {
      ui.setProgress(msg.loaded, msg.total);
      if (msg.firstPassDone && !started) {
        started = true;
        ui.setStatus(null, false);
        if (autoplay) timeline.play();
        else updateTimeUI();
      }
      break;
    }
    case "frameError": {
      console.warn(`frame ${msg.layerId}@${msg.leadIndex} failed: ${msg.message}`);
      break;
    }
    case "error": {
      ui.setStatus(`Could not load forecast data: ${msg.message}`, true);
      break;
    }
  }
};

worker.onerror = (e) => {
  ui.setStatus(`Could not load forecast data: ${e.message ?? "worker error"}`, true);
};

let locationMarker: maplibregl.Marker | null = null;

function showLocationDot(lon: number, lat: number): void {
  if (!locationMarker) {
    const el = document.createElement("div");
    el.className = "user-location-dot";
    el.setAttribute("aria-label", "Your location");
    locationMarker = new maplibregl.Marker({ element: el });
  }
  locationMarker.setLngLat([lon, lat]).addTo(map);
}

function requestLocation(fly: boolean): void {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude, latitude } = pos.coords;
      if (!inHrrrDomain(longitude, latitude)) return;
      showLocationDot(longitude, latitude);
      if (fly) {
        map.flyTo({ center: [longitude, latitude], zoom: LOCATED_ZOOM, duration: 1200 });
      } else {
        map.jumpTo({ center: [longitude, latitude], zoom: LOCATED_ZOOM });
      }
    },
    () => {
      // Denied or unavailable: stay on the CONUS overview.
    },
    { enableHighAccuracy: false, timeout: 6000, maximumAge: 600_000 },
  );
}

requestLocation(false);
