import { expect, test } from "@playwright/test";
import { fixtureManifest, gotoApp, routeFixtures, waitForLoaded } from "./helpers.ts";

test.describe("playback", () => {
  test.beforeEach(async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await waitForLoaded(page);
  });

  test("play advances the clock; pause stops it; scrubbing pauses", async ({ page }) => {
    const rel = page.locator(".rel-label");
    const playBtn = page.locator(".play-btn");
    await expect(rel).toHaveText("+0h");

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause animation");
    await expect(rel).not.toHaveText("+0h", { timeout: 5000 });

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Play animation");
    const frozen = await rel.textContent();
    await page.waitForTimeout(700);
    await expect(rel).toHaveText(frozen!);

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause animation");
    await page.locator(".scrubber").fill("12");
    await expect(playBtn).toHaveAttribute("aria-label", "Play animation");
    await expect(rel).toHaveText("+12h");
  });

  test("autoplay starts once the first pass is loaded", async ({ context }) => {
    const page = await context.newPage();
    await gotoApp(page, "");
    await waitForLoaded(page);
    await expect(page.locator(".play-btn")).toHaveAttribute("aria-label", "Pause animation");
  });

  test("valid-time label reflects the forecast init time", async ({ page }) => {
    const init = new Date(fixtureManifest.initTimeMs);
    const expected = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      timeZone: "America/Denver",
    }).format(init);
    // ICU versions differ on the comma after the weekday; ignore it.
    const label = (await page.locator(".time-label").textContent())?.replace(",", "");
    expect(label).toBe(expected.replace(",", ""));
  });
});

test.describe("failure handling", () => {
  test("shows an error when the store is unreachable", async ({ context, page }) => {
    await context.route(
      (u) => u.hostname !== "localhost" && u.hostname !== "127.0.0.1",
      (route) => route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" }),
    );
    await page.goto("/?autoplay=0");
    await expect(page.locator(".status-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".status-error")).toContainText("Could not load forecast data");
  });
});

test.describe("geolocation", () => {
  test.use({
    geolocation: { longitude: -104.99, latitude: 39.74 },
    permissions: ["geolocation"],
  });

  test("centers the map on the user's location inside the HRRR domain", async ({ context, page }) => {
    await routeFixtures(context);
    await gotoApp(page);
    await page.waitForFunction(() => {
      const map = (window as unknown as { __map?: { getCenter(): { lng: number; lat: number } } }).__map;
      if (!map) return false;
      const c = map.getCenter();
      return Math.abs(c.lng - -104.99) < 0.5 && Math.abs(c.lat - 39.74) < 0.5;
    });
  });
});
