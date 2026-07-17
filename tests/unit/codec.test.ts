import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GribberishCodec, registerGribberishCodec } from "../../src/lib/grib/codec.ts";
import { decodeGrib2Message } from "../../src/lib/grib/decoder.ts";
import { registry } from "zarrita";

const FIXTURE = new Uint8Array(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "grib", "prate_f06.grib2")),
);

const NY = 1059;
const NX = 1799;
const CHUNK_META = { dataType: "float64", shape: [1, 1, NY, NX] };

describe("GribberishCodec", () => {
  it("registers with zarrita's codec registry", () => {
    registerGribberishCodec();
    expect(registry.has("gribberish")).toBe(true);
  });

  it("decodes a GRIB chunk with north_up row flip", () => {
    const codec = GribberishCodec.fromConfig({ var: "PRATE", north_up: true }, CHUNK_META);
    const chunk = codec.decode(FIXTURE);
    expect(chunk.shape).toEqual([1, 1, NY, NX]);
    expect(chunk.stride).toEqual([NY * NX, NY * NX, NX, 1]);
    expect(chunk.data).toBeInstanceOf(Float64Array);
    expect(chunk.data.length).toBe(NY * NX);

    // HRRR scans south→north, so with north_up the codec's first row must
    // equal the raw decoder's last row.
    const raw = decodeGrib2Message(FIXTURE);
    for (let col = 0; col < NX; col += 97) {
      expect(chunk.data[col]).toBeCloseTo(raw.values[(NY - 1) * NX + col]!, 12);
      expect(chunk.data[(NY - 1) * NX + col]).toBeCloseTo(raw.values[col]!, 12);
    }
  });

  it("preserves row order without north_up", () => {
    const codec = GribberishCodec.fromConfig({ var: "PRATE" }, CHUNK_META);
    const chunk = codec.decode(FIXTURE);
    const raw = decodeGrib2Message(FIXTURE);
    for (let col = 0; col < NX; col += 211) {
      expect(chunk.data[col]).toBeCloseTo(raw.values[col]!, 12);
    }
  });

  it("supports float32 output", () => {
    const codec = GribberishCodec.fromConfig({}, { dataType: "float32", shape: [1, 1, NY, NX] });
    expect(codec.decode(FIXTURE).data).toBeInstanceOf(Float32Array);
  });

  it("rejects unexpected point counts and unsupported dtypes", () => {
    const codec = GribberishCodec.fromConfig({}, { dataType: "float64", shape: [1, 1, 10, 10] });
    expect(() => codec.decode(FIXTURE)).toThrow(/points/);
    expect(() => GribberishCodec.fromConfig({}, { dataType: "int32", shape: [1] })).toThrow(/data type/);
  });

  it("is read-only", () => {
    const codec = GribberishCodec.fromConfig({}, CHUNK_META);
    expect(() => codec.encode()).toThrow(/read-only/);
  });
});
