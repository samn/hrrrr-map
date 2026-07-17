/**
 * Dev utility: inspect the dynamical.org HRRR icechunk store — node hierarchy,
 * zarr metadata for the arrays we use, coordinate values, and a sample chunk
 * read. Usage: node --experimental-strip-types scripts/inspect-store.ts
 */
import { IcechunkStore } from "icechunk-js";

const STORE_URL =
  "https://dynamical-noaa-hrrr.s3.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk";

const store = await IcechunkStore.open(STORE_URL);
console.log("snapshot:", store.session.getSnapshotId());

const children = store.listChildren("/");
console.log("root children:", children);

for (const path of ["/", "/precipitation_rate_surface", "/mass_density_8m", "/init_time", "/lead_time", "/x", "/y"]) {
  try {
    const meta = store.getMetadata(path);
    console.log(`\n=== ${path}`);
    console.log(JSON.stringify(meta, null, 1).slice(0, 2500));
  } catch (e) {
    console.log(`\n=== ${path}: ERROR ${(e as Error).message}`);
  }
}
