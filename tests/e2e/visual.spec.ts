import { expect, test } from "@playwright/test";
import { gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

test.beforeEach(async ({ context, page }) => {
  await routeFixtures(context);
  await gotoApp(page);
  await waitForLoaded(page);
});

test("renders smoke and rain layers over the map", async ({ page }) => {
  await expect(page.locator(".init-label")).toContainText("HRRR forecast from");
  await expect(page).toHaveScreenshot("overview-both-layers.png");
});

test("scrubbing to +30h updates the frame and labels", async ({ page }) => {
  const slider = page.locator(".scrubber");
  await slider.fill("30");
  await expect(page.locator(".rel-label")).toHaveText("+30h");
  await slider.blur();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("scrubbed-plus-30h.png");
});

test("toggling smoke off leaves only rain", async ({ page }) => {
  await page.locator('.chip[data-layer="smoke"]').click();
  await expect(page.locator('.chip[data-layer="smoke"]')).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("rain-only.png");
});

test("toggling rain off leaves only smoke", async ({ page }) => {
  await page.locator('.chip[data-layer="precip"]').click();
  await expect(page.locator('.chip[data-layer="precip"]')).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("smoke-only.png");
});
