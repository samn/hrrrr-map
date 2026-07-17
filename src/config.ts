/** Application configuration: data store, variables, rendering. */

export const STORE_URL =
  "https://dynamical-noaa-hrrr.s3.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk";

export interface LayerConfig {
  id: "precip" | "smoke";
  label: string;
  /** Zarr array name. */
  arrayName: string;
  /** Multiply raw store values by this to get display units. */
  scale: number;
  units: string;
}

/** Precipitation rate: kg m-2 s-1 → mm/hr. */
export const PRECIP_LAYER: LayerConfig = {
  id: "precip",
  label: "Rain",
  arrayName: "precipitation_rate_surface",
  scale: 3600,
  units: "mm/hr",
};

/** Near-surface smoke: kg m-3 → µg/m³. */
export const SMOKE_LAYER: LayerConfig = {
  id: "smoke",
  label: "Smoke",
  arrayName: "mass_density_8m",
  scale: 1e9,
  units: "µg/m³",
};

export const LAYERS: LayerConfig[] = [SMOKE_LAYER, PRECIP_LAYER];

export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Number of lead-time frames (0..48 h hourly). */
export const NUM_LEADS = 49;

/** Progressive loading passes: hour strides, coarse first. */
export const LOAD_PASSES = [6, 3, 1];
