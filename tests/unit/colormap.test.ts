import { describe, expect, it } from "vitest";
import {
  byteToValue,
  makeLut,
  makeQuantizer,
  PRECIP_COLORMAP,
  quantizeField,
  quantizeValue,
  SMOKE_COLORMAP,
} from "../../src/lib/colormap.ts";

describe("quantization", () => {
  const q = makeQuantizer(PRECIP_COLORMAP);

  it("maps below-range, NaN and zero to transparent byte 0", () => {
    expect(quantizeValue(q, 0)).toBe(0);
    expect(quantizeValue(q, 0.05)).toBe(0);
    expect(quantizeValue(q, NaN)).toBe(0);
    expect(quantizeValue(q, -3)).toBe(0);
  });

  it("maps the range endpoints to bytes 1 and 255", () => {
    expect(quantizeValue(q, q.vmin)).toBe(1);
    expect(quantizeValue(q, q.vmax)).toBe(255);
    expect(quantizeValue(q, q.vmax * 100)).toBe(255); // clamps above range
  });

  it("is monotonic and round-trips within quantization error", () => {
    let prev = 0;
    for (const v of [0.1, 0.2, 0.5, 1, 2, 5, 10, 25, 50, 100]) {
      const b = quantizeValue(q, v);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
      const back = byteToValue(q, b);
      expect(back / v).toBeGreaterThan(0.97);
      expect(back / v).toBeLessThan(1.03);
    }
  });

  it("downsamples with block max to preserve peaks", () => {
    const nx = 4;
    const ny = 4;
    const values = new Float32Array(nx * ny);
    values[5] = 50; // a single intense cell inside block (1,1)->(0,0) at factor 2
    const { data, ny: oy, nx: ox } = quantizeField(q, values, ny, nx, 2);
    expect(oy).toBe(2);
    expect(ox).toBe(2);
    expect(data[0]).toBe(quantizeValue(q, 50));
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(0);
    expect(data[3]).toBe(0);
  });

  it("quantizes whole fields at factor 1", () => {
    const values = new Float32Array([0, 0.1, 100, NaN]);
    const { data } = quantizeField(q, values, 1, 4);
    expect(Array.from(data)).toEqual([0, 1, 255, 0]);
  });
});

describe("LUT", () => {
  it("byte 0 is fully transparent, others follow the ramp", () => {
    for (const cm of [PRECIP_COLORMAP, SMOKE_COLORMAP]) {
      const lut = makeLut(cm);
      expect(lut.length).toBe(1024);
      expect(lut[3]).toBe(0);
      // Alpha never decreases along the ramp for these maps.
      let prevAlpha = 0;
      for (let b = 1; b < 256; b++) {
        const a = lut[b * 4 + 3]!;
        expect(a).toBeGreaterThanOrEqual(prevAlpha);
        prevAlpha = a;
      }
      // First stop color at byte 1, last stop color at byte 255.
      const first = cm.stops[0]!.color;
      const last = cm.stops[cm.stops.length - 1]!.color;
      expect(Math.abs(lut[4]! - first[0])).toBeLessThanOrEqual(2);
      expect(Math.abs(lut[255 * 4]! - last[0])).toBeLessThanOrEqual(2);
    }
  });
});
