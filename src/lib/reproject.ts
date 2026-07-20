/**
 * Reprojection of the HRRR Lambert conformal grid onto a web-mercator-aligned
 * canvas. A one-time index map turns each per-frame repaint into a cheap
 * gather + palette lookup.
 */
import { makeGridTransform, type LccGrid } from "./lcc.ts";

const DEG = Math.PI / 180;

/** Normalized web mercator (x: 0..1 west→east, y: 0..1 north→south). */
export function lonLatToMercator(lonDeg: number, latDeg: number): [number, number] {
  const x = (lonDeg + 180) / 360;
  const s = Math.sin(latDeg * DEG);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const lat = Math.atan(Math.sinh((0.5 - y) * 2 * Math.PI)) / DEG;
  return [lon, lat];
}

export interface IndexMap {
  width: number;
  height: number;
  /** Per-canvas-pixel index into a north-up row-major grid array, or -1. */
  indices: Int32Array;
  /**
   * Canvas corner coordinates as [lon, lat] in the order MapLibre's canvas
   * source expects: top-left, top-right, bottom-right, bottom-left.
   */
  corners: [number, number][];
}

/** Normalized-mercator bounding box of a grid's (curved) outline. */
export interface MercatorBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * The grid edges are curves in mercator space; walk all four edges to get a
 * tight bounding box.
 */
export function gridMercatorBounds(grid: LccGrid): MercatorBounds {
  const tf = makeGridTransform(grid);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  const scan = (col: number, row: number) => {
    const [lon, lat] = tf.gridToLonLat(col, row);
    const [mx, my] = lonLatToMercator(lon, lat);
    if (mx < xMin) xMin = mx;
    if (mx > xMax) xMax = mx;
    if (my < yMin) yMin = my;
    if (my > yMax) yMax = my;
  };
  for (let c = 0; c < grid.nx; c += 8) {
    scan(c, 0);
    scan(c, grid.ny - 1);
  }
  for (let r = 0; r < grid.ny; r += 8) {
    scan(0, r);
    scan(grid.nx - 1, r);
  }
  scan(grid.nx - 1, 0);
  scan(grid.nx - 1, grid.ny - 1);
  return { xMin, xMax, yMin, yMax };
}

/**
 * Build the canvas-pixel → grid-cell index map. The canvas spans the grid's
 * bounding box in mercator space; pixels outside the grid get index -1.
 *
 * `gridNy`/`gridNx` are the dimensions of the (possibly downsampled) data
 * frames the indices point into.
 */
export function buildIndexMap(
  grid: LccGrid,
  canvasWidth: number,
  gridNy: number,
  gridNx: number,
): IndexMap {
  const tf = makeGridTransform(grid);
  const { xMin, xMax, yMin, yMax } = gridMercatorBounds(grid);

  const width = canvasWidth;
  const height = Math.max(1, Math.round((canvasWidth * (yMax - yMin)) / (xMax - xMin)));

  const colScale = gridNx / grid.nx;
  const rowScale = gridNy / grid.ny;

  const indices = new Int32Array(width * height);
  for (let py = 0; py < height; py++) {
    const my = yMin + ((py + 0.5) / height) * (yMax - yMin);
    for (let px = 0; px < width; px++) {
      const mx = xMin + ((px + 0.5) / width) * (xMax - xMin);
      const [lon, lat] = mercatorToLonLat(mx, my);
      const [col, row] = tf.lonLatToGrid(lon, lat);
      let idx = -1;
      if (col >= -0.5 && col <= grid.nx - 0.5 && row >= -0.5 && row <= grid.ny - 0.5) {
        const c = Math.min(gridNx - 1, Math.max(0, Math.round(col * colScale)));
        const r = Math.min(gridNy - 1, Math.max(0, Math.round(row * rowScale)));
        idx = r * gridNx + c;
      }
      indices[py * width + px] = idx;
    }
  }

  const [tlLon, tlLat] = mercatorToLonLat(xMin, yMin);
  const [brLon, brLat] = mercatorToLonLat(xMax, yMax);
  return {
    width,
    height,
    indices,
    corners: [
      [tlLon, tlLat],
      [brLon, tlLat],
      [brLon, brLat],
      [tlLon, brLat],
    ],
  };
}

/**
 * Paint a frame (or a crossfade of two frames) into an RGBA pixel buffer
 * using the index map and a 256-entry RGBA LUT. `t` blends frameA→frameB.
 */
export function paintFrame(
  map: IndexMap,
  lut: Uint8ClampedArray,
  pixels: Uint8ClampedArray,
  frameA: Uint8Array,
  frameB: Uint8Array | null,
  t: number,
): void {
  const n = map.indices.length;
  const blend = frameB !== null && t > 0;
  for (let i = 0; i < n; i++) {
    const idx = map.indices[i]!;
    const o = i * 4;
    if (idx < 0) {
      pixels[o + 3] = 0;
      continue;
    }
    let b = frameA[idx]!;
    if (blend) {
      b = Math.round(b * (1 - t) + frameB[idx]! * t);
    }
    const l = b * 4;
    pixels[o] = lut[l]!;
    pixels[o + 1] = lut[l + 1]!;
    pixels[o + 2] = lut[l + 2]!;
    pixels[o + 3] = lut[l + 3]!;
  }
}
