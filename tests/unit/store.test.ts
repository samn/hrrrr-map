import { describe, expect, it } from "vitest";
import { findLatestCompleteInit, type ChunkProber } from "../../src/lib/store.ts";

function proberWithCompleteInits(complete: Set<number>, log: number[] = []): ChunkProber {
  return {
    session: {
      async getChunkRange(_path, coords) {
        const init = coords[0]!;
        log.push(init);
        return complete.has(init) ? new Uint8Array([0]) : null;
      },
    },
  };
}

describe("findLatestCompleteInit", () => {
  it("returns the newest init when its final chunk exists", async () => {
    const log: number[] = [];
    const prober = proberWithCompleteInits(new Set([99]), log);
    await expect(findLatestCompleteInit(prober, "/x", 100, 48)).resolves.toBe(99);
    expect(log).toEqual([99]);
  });

  it("walks backwards past incomplete inits", async () => {
    const prober = proberWithCompleteInits(new Set([96, 97]));
    await expect(findLatestCompleteInit(prober, "/x", 100, 48)).resolves.toBe(97);
  });

  it("treats probe errors as missing", async () => {
    let calls = 0;
    const prober: ChunkProber = {
      session: {
        async getChunkRange(_path, coords) {
          calls++;
          if (coords[0] === 99) throw new Error("network");
          return coords[0] === 98 ? new Uint8Array([0]) : null;
        },
      },
    };
    await expect(findLatestCompleteInit(prober, "/x", 100, 48)).resolves.toBe(98);
    expect(calls).toBe(2);
  });

  it("throws when nothing is complete within the probe window", async () => {
    const prober = proberWithCompleteInits(new Set([1]));
    await expect(findLatestCompleteInit(prober, "/x", 100, 48, 5)).rejects.toThrow(/No complete/);
  });

  it("probes the final lead index", async () => {
    const coordsSeen: number[][] = [];
    const prober: ChunkProber = {
      session: {
        async getChunkRange(_path, coords) {
          coordsSeen.push(coords);
          return new Uint8Array([0]);
        },
      },
    };
    await findLatestCompleteInit(prober, "/x", 10, 48);
    expect(coordsSeen).toEqual([[9, 48, 0, 0]]);
  });
});
