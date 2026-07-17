import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GribMessage } from "@mattnucc/gribberish";
import { describe, expect, it } from "vitest";
import { HRRR_GRID, makeGridTransform, makeLccProjection } from "../../src/lib/lcc.ts";
import { lonLatToMercator, mercatorToLonLat } from "../../src/lib/reproject.ts";

describe("Lambert conformal projection", () => {
  const proj = makeLccProjection(HRRR_GRID);

  it("round-trips forward/inverse", () => {
    for (const [lon, lat] of [
      [-97.5, 38.5],
      [-122.72, 21.14],
      [-60.9, 52.6],
      [-104.99, 39.74],
    ] as const) {
      const [x, y] = proj.forward(lon, lat);
      const [lon2, lat2] = proj.inverse(x, y);
      expect(lon2).toBeCloseTo(lon, 8);
      expect(lat2).toBeCloseTo(lat, 8);
    }
  });

  it("handles 0..360 and -180..180 longitudes identically", () => {
    const a = proj.forward(237.280472, 21.138123);
    const b = proj.forward(237.280472 - 360, 21.138123);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  });

  it("maps the grid anchor to (col 0, north-up row ny-1)", () => {
    const tf = makeGridTransform(HRRR_GRID);
    const [col, row] = tf.lonLatToGrid(HRRR_GRID.lo1, HRRR_GRID.la1);
    expect(col).toBeCloseTo(0, 6);
    expect(row).toBeCloseTo(HRRR_GRID.ny - 1, 6);
  });

  it("matches gribberish's per-point lat/lon for sampled grid cells", () => {
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, "..", "fixtures", "grib", "prate_f06.grib2")),
    );
    const msg = GribMessage.parseFromBuffer(bytes, 0);
    const { latitude, longitude } = msg.latlng;
    const tf = makeGridTransform(HRRR_GRID);
    const { nx, ny } = HRRR_GRID;

    // Sample a spread of points across the grid (oracle arrays are in raw
    // south-first scan order).
    for (const [jSouth, col] of [
      [0, 0],
      [0, nx - 1],
      [ny - 1, 0],
      [ny - 1, nx - 1],
      [529, 899],
      [100, 1500],
      [900, 300],
      [777, 1234],
    ] as const) {
      const k = jSouth * nx + col;
      const [gotCol, gotRow] = tf.lonLatToGrid(longitude[k]!, latitude[k]!);
      expect(Math.abs(gotCol - col)).toBeLessThan(0.01);
      expect(Math.abs(gotRow - (ny - 1 - jSouth))).toBeLessThan(0.01);
    }
  });

  it("grid → lon/lat matches the oracle too", () => {
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, "..", "fixtures", "grib", "prate_f06.grib2")),
    );
    const msg = GribMessage.parseFromBuffer(bytes, 0);
    const { latitude, longitude } = msg.latlng;
    const tf = makeGridTransform(HRRR_GRID);
    const { nx, ny } = HRRR_GRID;

    const jSouth = 400;
    const col = 1000;
    const [lon, lat] = tf.gridToLonLat(col, ny - 1 - jSouth);
    const k = jSouth * nx + col;
    let expectedLon = longitude[k]!;
    if (expectedLon > 180) expectedLon -= 360;
    expect(lon).toBeCloseTo(expectedLon, 4);
    expect(lat).toBeCloseTo(latitude[k]!, 4);
  });
});

describe("web mercator helpers", () => {
  it("round-trips", () => {
    for (const [lon, lat] of [
      [-97.5, 38.5],
      [0, 0],
      [-170, 70],
      [15, -55],
    ] as const) {
      const [x, y] = lonLatToMercator(lon, lat);
      const [lon2, lat2] = mercatorToLonLat(x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });

  it("maps the origin to the center", () => {
    expect(lonLatToMercator(0, 0)).toEqual([0.5, 0.5]);
  });
});
