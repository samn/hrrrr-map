import { expect, test } from "@playwright/test";
import { routeFixtures, waitForLoaded } from "./helpers.ts";

/**
 * Main-thread responsiveness during playback, for both renderers.
 *
 * Headless CI renders GL in software (SwiftShader), so total frame pacing is
 * dominated by the basemap raster and can't carry tight thresholds. The
 * primary guard is therefore the app's own "overlay-update" measure — the
 * main-thread cost of applying one overlay refresh (a blit in worker mode,
 * uniform updates in GPU mode). Rasterizing frames on the main thread again
 * would push it from ~1-3ms to 15-40ms+, which fails here on any hardware.
 * Frame-gap percentiles and the longest task are looser smoke checks.
 *
 * Long tasks are Chromium-only (PerformanceObserver "longtask"), so this
 * suite runs on the chromium project only. Metrics are attached to the
 * report as JSON for tracking over time.
 */

interface PerfMetrics {
  durationMs: number;
  frames: number;
  medianFrameGapMs: number;
  p95FrameGapMs: number;
  longTaskCount: number;
  longestTaskMs: number;
  overlayUpdateCount: number;
  overlayUpdateMedianMs: number;
  overlayUpdateMaxMs: number;
}

/** Sample rAF cadence, long tasks, and overlay-update measures. */
function collectPerf(durationMs: number): Promise<PerfMetrics> {
  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ type: "longtask" });

  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = -1;
    const start = performance.now();
    const tick = (now: number) => {
      if (last >= 0) gaps.push(now - last);
      last = now;
      if (now - start < durationMs) {
        requestAnimationFrame(tick);
        return;
      }
      observer.disconnect();
      const percentile = (values: number[], p: number): number => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      };
      const updates = performance
        .getEntriesByName("overlay-update", "measure")
        .filter((e) => e.startTime >= start)
        .map((e) => e.duration);
      resolve({
        durationMs: now - start,
        frames: gaps.length + 1,
        medianFrameGapMs: percentile(gaps, 0.5),
        p95FrameGapMs: percentile(gaps, 0.95),
        longTaskCount: longTasks.length,
        longestTaskMs: longTasks.reduce((a, b) => Math.max(a, b), 0),
        overlayUpdateCount: updates.length,
        overlayUpdateMedianMs: percentile(updates, 0.5),
        overlayUpdateMaxMs: percentile(updates, 1),
      });
    };
    requestAnimationFrame(tick);
  });
}

test.skip(({ browserName }) => browserName !== "chromium", "longtask API is Chromium-only");

for (const mode of [
  { name: "worker", query: "?autoplay=0&gpu=0" },
  { name: "gpu", query: "?autoplay=0&gpu=1" },
]) {
  test(`playback stays responsive (${mode.name} renderer)`, async ({ context, page }, testInfo) => {
    await routeFixtures(context);
    // No pinClock here: the fake clock feeds rAF fabricated 16ms timestamps,
    // which would corrupt the frame-gap measurement.
    await page.goto(`/${mode.query}`);
    await waitForLoaded(page);

    // Play from 0h so the 6s window (6 h/s playback) stays inside 48h.
    await page.locator(".scrubber").fill("0");
    await page.locator(".play-btn").click();

    // Pan while playing: interaction during playback is what regressions
    // jank first. Runs concurrently with the sampling below.
    const interact = (async () => {
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(1200);
        await page.evaluate((dx) => {
          (window as unknown as { __map: { panBy(o: [number, number], opts: object): void } }).__map.panBy(
            [dx, 0],
            { duration: 600 },
          );
        }, i % 2 === 0 ? 250 : -250);
      }
    })();
    const metrics = await page.evaluate(collectPerf, 6_000);
    await interact;

    await testInfo.attach(`perf-${mode.name}`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });
    console.log(`perf ${mode.name}:`, JSON.stringify(metrics));

    // The pipeline must actually be repainting for the numbers to mean much.
    expect(metrics.overlayUpdateCount).toBeGreaterThan(10);
    // Core guard: applying an overlay refresh stays cheap on the main thread.
    expect(metrics.overlayUpdateMedianMs).toBeLessThan(8);
    expect(metrics.overlayUpdateMaxMs).toBeLessThan(50);
    // Smoke checks, loose enough for software-GL CI.
    expect(metrics.p95FrameGapMs).toBeLessThan(250);
    expect(metrics.longestTaskMs).toBeLessThan(400);
  });
}
