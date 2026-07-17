import { describe, expect, it } from "vitest";
import { FrameStore } from "../../src/lib/frames.ts";
import { Timeline } from "../../src/lib/timeline.ts";
import { progressiveLeadOrder } from "../../src/worker/schedule.ts";

const HOURS = Array.from({ length: 49 }, (_, i) => i);

describe("FrameStore.neighbors", () => {
  it("returns null with no frames", () => {
    const fs = new FrameStore(["precip"], HOURS);
    expect(fs.neighbors("precip", 5)).toBeNull();
    expect(fs.neighbors("missing-layer", 5)).toBeNull();
  });

  it("brackets t between the nearest loaded frames", () => {
    const fs = new FrameStore(["precip"], HOURS);
    fs.addFrame("precip", 6, new Uint8Array(1));
    fs.addFrame("precip", 12, new Uint8Array(1));
    const n = fs.neighbors("precip", 9)!;
    expect(n.a).toBe(6);
    expect(n.b).toBe(12);
    expect(n.blend).toBeCloseTo(0.5);
  });

  it("uses tighter brackets as more frames load", () => {
    const fs = new FrameStore(["precip"], HOURS);
    fs.addFrame("precip", 6, new Uint8Array(1));
    fs.addFrame("precip", 12, new Uint8Array(1));
    fs.addFrame("precip", 9, new Uint8Array(1));
    const n = fs.neighbors("precip", 9.5)!;
    expect(n.a).toBe(9);
    expect(n.b).toBe(12);
    expect(n.blend).toBeCloseTo(0.5 / 3);
  });

  it("clamps to a single frame at the edges", () => {
    const fs = new FrameStore(["precip"], HOURS);
    fs.addFrame("precip", 6, new Uint8Array(1));
    expect(fs.neighbors("precip", 3)).toEqual({ a: 6, b: 6, blend: 0 });
    expect(fs.neighbors("precip", 20)).toEqual({ a: 6, b: 6, blend: 0 });
    expect(fs.neighbors("precip", 6)).toEqual({ a: 6, b: 6, blend: 0 });
  });

  it("notifies listeners and tracks counts", () => {
    const fs = new FrameStore(["a", "b"], HOURS);
    let calls = 0;
    fs.onFrame(() => calls++);
    fs.addFrame("a", 0, new Uint8Array(1));
    fs.addFrame("b", 0, new Uint8Array(1));
    fs.addFrame("a", 480, new Uint8Array(1)); // out of range: ignored
    expect(calls).toBe(2);
    expect(fs.loadedCount("a")).toBe(1);
    expect(fs.isAnimatable("a")).toBe(false);
    fs.addFrame("a", 6, new Uint8Array(1));
    expect(fs.isAnimatable("a")).toBe(true);
  });
});

describe("progressiveLeadOrder", () => {
  it("emits coarse-to-fine passes without duplicates, always including the last lead", () => {
    const passes = progressiveLeadOrder(49, [6, 3, 1]);
    expect(passes[0]).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
    expect(passes[1]).toEqual([3, 9, 15, 21, 27, 33, 39, 45]);
    const all = passes.flat();
    expect(new Set(all).size).toBe(49);
    expect(all.length).toBe(49);
  });

  it("handles a single pass", () => {
    const passes = progressiveLeadOrder(5, [1]);
    expect(passes).toEqual([[0, 1, 2, 3, 4]]);
  });
});

describe("Timeline", () => {
  function manualRaf() {
    const cbs = new Map<number, (ts: number) => void>();
    let id = 0;
    return {
      raf: (cb: (ts: number) => void) => {
        cbs.set(++id, cb);
        return id;
      },
      caf: (i: number) => cbs.delete(i),
      fire(ts: number) {
        const pending = [...cbs.values()];
        cbs.clear();
        for (const cb of pending) cb(ts);
      },
    };
  }

  it("advances time while playing and loops at the end", () => {
    const driver = manualRaf();
    const tl = new Timeline({ maxHours: 48, speed: 6, raf: driver.raf, caf: driver.caf });
    tl.play();
    driver.fire(0); // primes lastTs
    driver.fire(1000);
    expect(tl.t).toBeCloseTo(1.5); // dt capped at 0.25s => 0.25 * 6
    tl.t = 47.9;
    driver.fire(1100);
    expect(tl.t).toBe(0); // past maxHours: loops back to the start
  });

  it("scrubbing pauses playback and clamps", () => {
    const driver = manualRaf();
    const tl = new Timeline({ maxHours: 48, raf: driver.raf, caf: driver.caf });
    tl.play();
    expect(tl.playing).toBe(true);
    tl.scrubTo(30);
    expect(tl.playing).toBe(false);
    expect(tl.t).toBe(30);
    tl.scrubTo(-4);
    expect(tl.t).toBe(0);
    tl.scrubTo(99);
    expect(tl.t).toBe(48);
  });

  it("emits change events on play, pause, and scrub", () => {
    const driver = manualRaf();
    const tl = new Timeline({ maxHours: 48, raf: driver.raf, caf: driver.caf });
    let events = 0;
    tl.onChange(() => events++);
    tl.play();
    tl.pause();
    tl.scrubTo(5);
    expect(events).toBe(3);
    tl.toggle();
    expect(tl.playing).toBe(true);
    tl.toggle();
    expect(tl.playing).toBe(false);
  });
});
