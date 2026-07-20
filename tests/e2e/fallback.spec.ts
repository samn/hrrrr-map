import { expect, test } from "@playwright/test";
import { gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

/**
 * Renderer selection and the worker-painted canvas fallback. The GPU
 * renderer is the default (covered by visual.spec.ts); the canvas path must
 * keep working for devices where WebGL2/shaders won't initialize, and its
 * nearest-cell output keeps its own snapshots.
 */

test("defaults to the gpu renderer when webgl2 is available", async ({ context, page }) => {
  await routeFixtures(context);
  await gotoApp(page);
  expect(await page.evaluate(() => (window as unknown as { __renderer: string }).__renderer)).toBe(
    "gpu",
  );
});

test("selects the canvas renderer when webgl2 is unavailable", async ({ context, page }) => {
  await routeFixtures(context);
  // Kill WebGL2 before the app boots. MapLibre itself can't start either, so
  // only the selection logic is assertable here — but that logic is exactly
  // what must not regress for weak devices.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = function (
      type: string,
      ...args: unknown[]
    ) {
      if (type === "webgl2") return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...args);
    };
  });
  await gotoApp(page);
  expect(await page.evaluate(() => (window as unknown as { __renderer: string }).__renderer)).toBe(
    "canvas",
  );
});

test.describe("canvas renderer (?gpu=0)", () => {
  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page, "?autoplay=0&gpu=0");
    await waitForLoaded(page);
  });

  test("shows smoke and rain layers", async ({ page }) => {
    await expect(page.locator(".init-label")).toContainText("HRRR forecast from");
    await expect(page).toHaveScreenshot("canvas-both-layers.png");
  });

  test("scrubs and toggles layers", async ({ page }) => {
    const slider = page.locator(".scrubber");
    await slider.fill("30");
    await expect(page.locator(".rel-label")).toHaveText("+30h");
    await slider.blur();
    await page.locator('.chip[data-layer="smoke"]').click();
    await expect(page.locator('.chip[data-layer="smoke"]')).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("canvas-rain-only-plus-30h.png");
  });
});
