/**
 * Colormaps and quantization for forecast layers.
 *
 * Values are quantized to bytes in log-value space: byte 0 means "below the
 * first stop" (fully transparent), bytes 1..255 span [vmin, vmax]
 * logarithmically. Blending two quantized frames byte-wise therefore
 * interpolates values geometrically, which suits precipitation and smoke.
 */

export interface ColorStop {
  value: number;
  /** RGBA, 0-255. */
  color: [number, number, number, number];
}

export interface Colormap {
  stops: ColorStop[];
}

/** Precipitation rate, mm/hr — radar-like ramp. */
export const PRECIP_COLORMAP: Colormap = {
  stops: [
    { value: 0.1, color: [140, 200, 245, 90] },
    { value: 0.5, color: [80, 160, 230, 140] },
    { value: 2, color: [40, 110, 210, 175] },
    { value: 5, color: [55, 175, 60, 195] },
    { value: 10, color: [255, 212, 0, 210] },
    { value: 25, color: [255, 130, 0, 225] },
    { value: 50, color: [225, 25, 25, 235] },
    { value: 100, color: [170, 0, 155, 245] },
  ],
};

/** Near-surface smoke, µg/m³ — AQI-inspired PM2.5 breakpoints. */
export const SMOKE_COLORMAP: Colormap = {
  stops: [
    { value: 2, color: [175, 175, 175, 70] },
    { value: 8, color: [190, 180, 130, 110] },
    { value: 20, color: [230, 200, 90, 150] },
    { value: 35, color: [235, 160, 60, 180] },
    { value: 55, color: [220, 100, 45, 200] },
    { value: 150, color: [185, 40, 40, 220] },
    { value: 250, color: [150, 30, 110, 230] },
    { value: 500, color: [95, 20, 75, 240] },
  ],
};

export interface Quantizer {
  vmin: number;
  vmax: number;
  logMin: number;
  logRange: number;
}

export function makeQuantizer(colormap: Colormap): Quantizer {
  const first = colormap.stops[0];
  const last = colormap.stops[colormap.stops.length - 1];
  if (!first || !last) throw new Error("Colormap needs at least one stop");
  const logMin = Math.log10(first.value);
  return {
    vmin: first.value,
    vmax: last.value,
    logMin,
    logRange: Math.log10(last.value) - logMin,
  };
}

/** Quantize a physical value to a byte (0 = transparent/below range). */
export function quantizeValue(q: Quantizer, v: number): number {
  if (!(v >= q.vmin)) return 0; // catches NaN too
  const t = (Math.log10(v) - q.logMin) / q.logRange;
  const b = 1 + Math.round(Math.min(1, t) * 254);
  return b;
}

/** Physical value at a byte level (inverse of quantizeValue midpoint). */
export function byteToValue(q: Quantizer, byte: number): number {
  if (byte <= 0) return 0;
  const t = (byte - 1) / 254;
  return 10 ** (q.logMin + t * q.logRange);
}

/** Quantize a whole field, optionally downsampling by `factor` (block max). */
export function quantizeField(
  q: Quantizer,
  values: Float32Array,
  ny: number,
  nx: number,
  factor = 1,
): { data: Uint8Array; ny: number; nx: number } {
  if (factor === 1) {
    const out = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = quantizeValue(q, values[i]!);
    return { data: out, ny, nx };
  }
  const oy = Math.ceil(ny / factor);
  const ox = Math.ceil(nx / factor);
  const out = new Uint8Array(oy * ox);
  for (let r = 0; r < oy; r++) {
    for (let c = 0; c < ox; c++) {
      // Block max keeps hazard peaks visible after downsampling.
      let m = -Infinity;
      const rowEnd = Math.min((r + 1) * factor, ny);
      const colEnd = Math.min((c + 1) * factor, nx);
      for (let y = r * factor; y < rowEnd; y++) {
        for (let x = c * factor; x < colEnd; x++) {
          const v = values[y * nx + x]!;
          if (v > m) m = v;
        }
      }
      out[r * ox + c] = quantizeValue(q, m);
    }
  }
  return { data: out, ny: oy, nx: ox };
}

/**
 * Build a 256-entry RGBA lookup table for quantized bytes. Colors are
 * interpolated between stops in log-value space; byte 0 is transparent.
 */
export function makeLut(colormap: Colormap): Uint8ClampedArray {
  const q = makeQuantizer(colormap);
  const lut = new Uint8ClampedArray(256 * 4);
  const stops = colormap.stops;
  for (let b = 1; b < 256; b++) {
    const v = byteToValue(q, b);
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1]!.value < v) i++;
    const s0 = stops[i]!;
    const s1 = stops[Math.min(i + 1, stops.length - 1)]!;
    let t = 0;
    if (s1.value > s0.value) {
      t = (Math.log10(v) - Math.log10(s0.value)) / (Math.log10(s1.value) - Math.log10(s0.value));
      t = Math.max(0, Math.min(1, t));
    }
    for (let ch = 0; ch < 4; ch++) {
      lut[b * 4 + ch] = Math.round(s0.color[ch]! + (s1.color[ch]! - s0.color[ch]!) * t);
    }
  }
  return lut;
}
