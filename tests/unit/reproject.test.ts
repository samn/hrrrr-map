import { describe, expect, it } from "vitest";
import { HRRR_GRID, makeGridTransform } from "../../src/lib/lcc.ts";
import { buildIndexMap, paintFrame, type IndexMap } from "../../src/lib/reproject.ts";

describe("buildIndexMap", () => {
  const map = buildIndexMap(HRRR_GRID, 256, HRRR_GRID.ny, HRRR_GRID.nx);

  it("produces a canvas taller than wide scaled by the mercator bbox", () => {
    expect(map.width).toBe(256);
    expect(map.height).toBeGreaterThan(100);
    expect(map.height).toBeLessThan(256);
    expect(map.indices.length).toBe(map.width * map.height);
  });

  it("marks corners outside the LCC trapezoid as -1 and center as valid", () => {
    expect(map.indices[0]).toBe(-1); // top-left of mercator bbox is outside the cone
    expect(map.indices[map.width - 1]).toBe(-1);
    const center = Math.floor(map.height / 2) * map.width + Math.floor(map.width / 2);
    expect(map.indices[center]).toBeGreaterThanOrEqual(0);
  });

  it("maps Denver's pixel to a grid cell near Denver", () => {
    const tf = makeGridTransform(HRRR_GRID);
    const [dCol, dRow] = tf.lonLatToGrid(-104.99, 39.74);
    // Find the canvas pixel whose index equals Denver's rounded grid cell.
    const target = Math.round(dRow) * HRRR_GRID.nx + Math.round(dCol);
    let found = false;
    for (let i = 0; i < map.indices.length; i++) {
      const idx = map.indices[i]!;
      if (idx === -1) continue;
      if (Math.abs((idx % HRRR_GRID.nx) - dCol) < 4 && Math.abs(Math.floor(idx / HRRR_GRID.nx) - dRow) < 4) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    expect(target).toBeGreaterThan(0);
  });

  it("orders corner coordinates TL,TR,BR,BL west→east and north→south", () => {
    const [tl, tr, br, bl] = map.corners as [number, number][] & { length: 4 };
    expect(tl![0]).toBeLessThan(tr![0]);
    expect(bl![0]).toBeLessThan(br![0]);
    expect(tl![1]).toBeGreaterThan(bl![1]);
    expect(tr![1]).toBeGreaterThan(br![1]);
    // Roughly CONUS extent.
    expect(tl![0]).toBeLessThan(-120);
    expect(br![0]).toBeGreaterThan(-65);
    expect(tl![1]).toBeGreaterThan(45);
    expect(br![1]).toBeLessThan(25);
  });

  it("respects downsampled grid dimensions", () => {
    const half = buildIndexMap(HRRR_GRID, 128, Math.ceil(HRRR_GRID.ny / 2), Math.ceil(HRRR_GRID.nx / 2));
    const maxIdx = Math.ceil(HRRR_GRID.ny / 2) * Math.ceil(HRRR_GRID.nx / 2);
    for (const idx of half.indices) {
      expect(idx).toBeLessThan(maxIdx);
    }
  });
});

describe("paintFrame", () => {
  const map: IndexMap = {
    width: 2,
    height: 1,
    indices: new Int32Array([0, -1]),
    corners: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  };
  const lut = new Uint8ClampedArray(256 * 4);
  lut.set([10, 20, 30, 40], 100 * 4);
  lut.set([50, 60, 70, 80], 200 * 4);
  lut.set([30, 40, 50, 60], 150 * 4);

  it("paints single frames through the LUT and clears out-of-grid pixels", () => {
    const pixels = new Uint8ClampedArray(2 * 4).fill(255);
    paintFrame(map, lut, pixels, new Uint8Array([100]), null, 0);
    expect(Array.from(pixels.slice(0, 4))).toEqual([10, 20, 30, 40]);
    expect(pixels[7]).toBe(0); // alpha cleared outside grid
  });

  it("crossfades between two frames in byte space", () => {
    const pixels = new Uint8ClampedArray(2 * 4);
    paintFrame(map, lut, pixels, new Uint8Array([100]), new Uint8Array([200]), 0.5);
    expect(Array.from(pixels.slice(0, 4))).toEqual([30, 40, 50, 60]);
  });
});
