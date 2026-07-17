/**
 * Data access layer for the dynamical.org HRRR icechunk store, built on
 * icechunk-js + zarrita with the custom gribberish codec.
 */
import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import { registerGribberishCodec } from "./grib/codec.ts";

export interface VariableSpec {
  /** Zarr array name in the store. */
  name: string;
  /** Multiply raw values by this to get display units. */
  scale: number;
}

export interface HrrrDataset {
  store: IcechunkStore;
  arrays: Map<string, zarr.Array<zarr.DataType, IcechunkStore>>;
  /** All forecast init times in the store, ascending. */
  initTimes: Date[];
  /** Index of the most recent init with complete data. */
  latestInitIndex: number;
  /** Lead time offsets in hours (0..48). */
  leadTimeHours: number[];
}

async function readNumericArray(
  store: IcechunkStore,
  path: `/${string}`,
): Promise<number[]> {
  const arr = await zarr.open(store.resolve(path), { kind: "array" });
  const result = await zarr.get(arr as zarr.Array<zarr.NumberDataType | zarr.BigintDataType, IcechunkStore>);
  const data = result.data as ArrayLike<number | bigint>;
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number(data[i]);
  return out;
}

/**
 * Find the most recent init whose final lead-time chunk exists. Probes the
 * chunk manifest with 1-byte range reads, walking backwards from the newest
 * init. dynamical.org appends init slices as forecasts complete, so a
 * missing final chunk means that cycle isn't fully available yet.
 */
export interface ChunkProber {
  session: {
    getChunkRange(
      path: string,
      coords: number[],
      range: { offset: number; length: number },
    ): Promise<Uint8Array | null>;
  };
}

export async function findLatestCompleteInit(
  store: ChunkProber,
  arrayPath: string,
  initCount: number,
  lastLeadIndex: number,
  maxProbes = 8,
): Promise<number> {
  const session = store.session;
  for (let i = initCount - 1; i >= Math.max(0, initCount - maxProbes); i--) {
    try {
      const probe = await session.getChunkRange(arrayPath, [i, lastLeadIndex, 0, 0], {
        offset: 0,
        length: 1,
      });
      if (probe !== null) return i;
    } catch {
      // Treat fetch errors on a probe as "not available" and keep walking back.
    }
  }
  throw new Error("No complete forecast init found in the store");
}

export async function openHrrrDataset(
  storeUrl: string,
  variables: VariableSpec[],
): Promise<HrrrDataset> {
  registerGribberishCodec();
  const store = await IcechunkStore.open(storeUrl, { branch: "main" });

  const [initTimeSecs, leadTimeSecs] = await Promise.all([
    readNumericArray(store, "/init_time"),
    readNumericArray(store, "/lead_time"),
  ]);

  const arrays = new Map<string, zarr.Array<zarr.DataType, IcechunkStore>>();
  await Promise.all(
    variables.map(async (v) => {
      const arr = await zarr.open(store.resolve(`/${v.name}`), { kind: "array" });
      arrays.set(v.name, arr);
    }),
  );

  const leadTimeHours = leadTimeSecs.map((s) => s / 3600);
  const firstVar = variables[0];
  if (!firstVar) throw new Error("No variables requested");
  const latestInitIndex = await findLatestCompleteInit(
    store,
    `/${firstVar.name}`,
    initTimeSecs.length,
    leadTimeHours.length - 1,
  );

  return {
    store,
    arrays,
    initTimes: initTimeSecs.map((s) => new Date(s * 1000)),
    latestInitIndex,
    leadTimeHours,
  };
}

/**
 * Read one (init, lead) field as Float32Array in north-up row-major order,
 * with display-unit scaling applied.
 */
export async function loadField(
  dataset: HrrrDataset,
  variable: VariableSpec,
  initIndex: number,
  leadIndex: number,
  signal?: AbortSignal,
): Promise<{ values: Float32Array; ny: number; nx: number }> {
  const arr = dataset.arrays.get(variable.name);
  if (!arr) throw new Error(`Array not opened: ${variable.name}`);
  const result = await zarr.get(arr as zarr.Array<zarr.NumberDataType, IcechunkStore>, [initIndex, leadIndex, null, null], {
    opts: { signal } as never,
  });
  const src = result.data as Float64Array | Float32Array;
  const [ny, nx] = result.shape as [number, number];
  const values = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) values[i] = src[i]! * variable.scale;
  return { values, ny, nx };
}
