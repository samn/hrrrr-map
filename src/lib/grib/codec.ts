/**
 * zarrita codec for the "gribberish" zarr v3 codec used by dynamical.org
 * stores: each chunk is a complete GRIB2 message. Mirrors the behavior of
 * gribberish's Python codec for the configuration the HRRR store uses.
 */
import { registry } from "zarrita";
import { decodeGrib2Message } from "./decoder.ts";

export interface GribberishCodecConfig {
  var?: string;
  /** Reorder rows so row 0 is northern-most (no-op if already north-up). */
  north_up?: boolean;
  /** Rewrap global 0-360 longitude grids; no-op for regional LCC grids. */
  adjust_longitude_range?: boolean;
}

interface ChunkMeta {
  dataType: string;
  shape: number[];
}

interface Chunk {
  data: Float64Array | Float32Array;
  shape: number[];
  stride: number[];
}

function strides(shape: number[]): number[] {
  const out = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = acc;
    acc *= shape[i]!;
  }
  return out;
}

export class GribberishCodec {
  readonly kind = "array_to_bytes";

  private readonly config: GribberishCodecConfig;
  private readonly meta: ChunkMeta;

  constructor(config: GribberishCodecConfig, meta: ChunkMeta) {
    if (meta.dataType !== "float64" && meta.dataType !== "float32") {
      throw new Error(`gribberish codec: unsupported data type ${meta.dataType}`);
    }
    this.config = config;
    this.meta = meta;
  }

  static fromConfig(config: unknown, meta: ChunkMeta): GribberishCodec {
    return new GribberishCodec((config ?? {}) as GribberishCodecConfig, meta);
  }

  decode(bytes: Uint8Array): Chunk {
    const decoded = decodeGrib2Message(bytes);
    const expected = this.meta.shape.reduce((a, b) => a * b, 1);
    if (decoded.values.length !== expected) {
      throw new Error(
        `gribberish codec: GRIB message has ${decoded.values.length} points, chunk expects ${expected}`,
      );
    }

    const nx = decoded.grid?.nx ?? this.meta.shape[this.meta.shape.length - 1]!;
    const ny = decoded.values.length / nx;

    // Scan mode bit 0x40 set = rows run south→north; north_up asks for
    // north-first rows, so reverse row order.
    const southFirst = decoded.grid ? (decoded.grid.scanMode & 0x40) !== 0 : false;
    const flip = !!this.config.north_up && southFirst;

    const src = decoded.values;
    const out = this.meta.dataType === "float64" ? new Float64Array(src.length) : new Float32Array(src.length);
    if (flip) {
      for (let row = 0; row < ny; row++) {
        const srcOff = (ny - 1 - row) * nx;
        for (let col = 0; col < nx; col++) out[row * nx + col] = src[srcOff + col]!;
      }
    } else {
      out.set(src);
    }

    return { data: out, shape: this.meta.shape.slice(), stride: strides(this.meta.shape) };
  }

  encode(): never {
    throw new Error("gribberish codec is read-only");
  }
}

let registered = false;

/** Register the gribberish codec with zarrita's global codec registry. */
export function registerGribberishCodec(): void {
  if (registered) return;
  registered = true;
  registry.set("gribberish", () => GribberishCodec as never);
}
