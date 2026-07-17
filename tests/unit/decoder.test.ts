import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GribMessage } from "@mattnucc/gribberish";
import { describe, expect, it } from "vitest";
import { decodeGrib2Message, GribDecodeError } from "../../src/lib/grib/decoder.ts";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "grib");
const FIXTURES = ["prate_f06.grib2", "prate_f24.grib2", "massden_f06.grib2", "massden_f24.grib2"];

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

describe("decodeGrib2Message vs gribberish oracle", () => {
  for (const name of FIXTURES) {
    it(`matches native gribberish output for ${name}`, () => {
      const bytes = loadFixture(name);
      const oracle = GribMessage.parseFromBuffer(bytes, 0);
      const oracleData = oracle.data;

      const t0 = performance.now();
      const decoded = decodeGrib2Message(bytes);
      const elapsed = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`${name}: decoded ${decoded.values.length} points in ${elapsed.toFixed(1)}ms`);

      expect(decoded.values.length).toBe(oracleData.length);

      let maxRel = 0;
      let mismatches = 0;
      for (let i = 0; i < oracleData.length; i++) {
        const expected = Math.fround(oracleData[i]!);
        const actual = decoded.values[i]!;
        if (Number.isNaN(expected) || Number.isNaN(actual)) {
          if (Number.isNaN(expected) !== Number.isNaN(actual)) mismatches++;
          continue;
        }
        const denom = Math.max(Math.abs(expected), Math.abs(actual), 1e-30);
        const rel = Math.abs(expected - actual) / denom;
        if (rel > maxRel) maxRel = rel;
        if (rel > 1e-6) mismatches++;
      }
      expect(mismatches).toBe(0);
      expect(maxRel).toBeLessThan(1e-6);
    });

    it(`parses grid metadata for ${name}`, () => {
      const decoded = decodeGrib2Message(loadFixture(name));
      const grid = decoded.grid!;
      expect(grid).not.toBeNull();
      expect(grid.templateNumber).toBe(30);
      expect(grid.nx).toBe(1799);
      expect(grid.ny).toBe(1059);
      expect(grid.earthRadiusM).toBe(6371229);
      expect(grid.scanMode).toBe(64);
      // Documented HRRR Lambert conformal parameters.
      expect(grid.latin1).toBeCloseTo(38.5, 5);
      expect(grid.latin2).toBeCloseTo(38.5, 5);
      expect(grid.lov).toBeCloseTo(262.5, 5);
      expect(grid.la1).toBeCloseTo(21.138123, 5);
      expect(grid.lo1).toBeCloseTo(237.280472, 5);
      expect(grid.dx).toBeCloseTo(3000, 1);
      expect(grid.dy).toBeCloseTo(3000, 1);
      expect(decoded.numGridPoints).toBe(1799 * 1059);
      expect(decoded.referenceTime.toISOString()).toBe("2025-06-12T00:00:00.000Z");
    });
  }

  it("has plausible physical values (PRATE non-negative, MASSDEN non-negative)", () => {
    for (const name of FIXTURES) {
      const decoded = decodeGrib2Message(loadFixture(name));
      let min = Infinity;
      let max = -Infinity;
      for (const v of decoded.values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeGreaterThan(0); // June CONUS always has some rain and smoke somewhere
      expect(max).toBeLessThan(1); // kg m^-2 s^-1 and kg m^-3 are far below 1 in practice
    }
  });

  it("rejects non-GRIB input", () => {
    expect(() => decodeGrib2Message(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(GribDecodeError);
    expect(() => decodeGrib2Message(new TextEncoder().encode("GRIBxxxx but not really longer"))).toThrow(
      GribDecodeError,
    );
  });

  it("rejects unsupported data representation templates", () => {
    const bytes = loadFixture("prate_f06.grib2");
    // Find section 5 and corrupt its template number to 40 (JPEG2000).
    const copy = bytes.slice();
    let pos = 16;
    for (;;) {
      const len = (copy[pos]! << 24) | (copy[pos + 1]! << 16) | (copy[pos + 2]! << 8) | copy[pos + 3]!;
      const num = copy[pos + 4]!;
      if (num === 5) {
        copy[pos + 9] = 0;
        copy[pos + 10] = 40;
        break;
      }
      pos += len;
    }
    expect(() => decodeGrib2Message(copy)).toThrow(/5\.40/);
  });
});
