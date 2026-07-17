import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { BASEMAP_STYLE_URL, LAYERS, PRECIP_LAYER, SMOKE_LAYER, STORE_URL } from "./config.ts";
import { makeLut, PRECIP_COLORMAP, SMOKE_COLORMAP } from "./lib/colormap.ts";
import { FrameStore } from "./lib/frames.ts";
import type { IndexMap } from "./lib/reproject.ts";
import { Timeline } from "./lib/timeline.ts";
import { ForecastLayer } from "./render/layer.ts";
import { AppUI } from "./ui/ui.ts";
import type { MainToWorker, WorkerToMain } from "./worker/protocol.ts";

const COLORMAPS = { smoke: SMOKE_COLORMAP, precip: PRECIP_COLORMAP } as const;

const params = new URLSearchParams(location.search);
const autoplay = params.get("autoplay") !== "0";

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
} satisfies MainToWorker);

let frameStore: FrameStore | null = null;
let initTime: Date | null = null;
const forecastLayers = new Map<string, ForecastLayer>();
let indexMap: IndexMap | null = null;
let started = false;
let mapLoaded = false;
let renderQueued = false;

map.on("load", () => {
  mapLoaded = true;
  maybeAddLayers();
});

function maybeAddLayers(): void {
  if (!mapLoaded || !indexMap || forecastLayers.size > 0) return;
  // Smoke below precip so rain cells stay readable over smoke plumes.
  for (const config of [SMOKE_LAYER, PRECIP_LAYER]) {
    const layer = new ForecastLayer(map, config.id, makeLut(COLORMAPS[config.id]), indexMap);
    layer.addTo();
    forecastLayers.set(config.id, layer);
  }
  renderFrames();
}

function renderFrames(): void {
  if (renderQueued || !frameStore) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!frameStore) return;
    for (const [id, layer] of forecastLayers) {
      if (!enabled.get(id)) continue;
      const n = frameStore.neighbors(id, timeline.t);
      if (!n) continue;
      const a = frameStore.getFrame(id, n.a)!;
      const b = n.b !== n.a ? frameStore.getFrame(id, n.b) : null;
      layer.render(a, b, n.blend);
    }
  });
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
      indexMap = {
        width: msg.indexWidth,
        height: msg.indexHeight,
        indices: msg.indices,
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
    case "frame": {
      frameStore?.addFrame(msg.layerId, msg.leadIndex, msg.data);
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

function requestLocation(fly: boolean): void {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude, latitude } = pos.coords;
      if (!inHrrrDomain(longitude, latitude)) return;
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
