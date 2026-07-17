import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "http");

interface FixtureManifest {
  initTimeMs: number;
  coarseLeads: number[];
  entries: {
    url: string;
    range: string;
    status: number;
    file: string | null;
    contentType: string;
  }[];
}

export const fixtureManifest: FixtureManifest = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

const basemapStyle = readFileSync(join(import.meta.dirname, "..", "fixtures", "basemap-style.json"));

/**
 * Serve all recorded store/data traffic and a local basemap style; any other
 * external request 404s so tests are fully offline and deterministic.
 */
export async function routeFixtures(context: BrowserContext): Promise<void> {
  const byKey = new Map<string, FixtureManifest["entries"][number]>();
  for (const e of fixtureManifest.entries) byKey.set(`${e.url}|${e.range}`, e);

  await context.route(
    (u) => u.hostname !== "localhost" && u.hostname !== "127.0.0.1",
    async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.startsWith("https://tiles.openfreemap.org/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: basemapStyle,
        });
        return;
      }
      const headers = await req.allHeaders();
      const key = `${url}|${headers["range"] ?? ""}`;
      const entry = byKey.get(key);
      if (!entry || !entry.file) {
        await route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
        return;
      }
      await route.fulfill({
        status: entry.status,
        contentType: entry.contentType,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "*",
        },
        body: readFileSync(join(FIXTURE_DIR, entry.file)),
      });
    },
  );
}

/**
 * Pin Date (not timers — MapLibre and the app need real rAF) 2h after the
 * forecast init so the "now" tick position is deterministic.
 */
export async function pinClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date(fixtureManifest.initTimeMs + 2 * 3_600_000));
}

/** Wait until the progressive loader reports completion (progress bar hidden). */
export async function waitForLoaded(page: Page): Promise<void> {
  await page.locator(".progress-wrap").waitFor({ state: "attached" });
  await page.waitForFunction(
    () => {
      const el = document.querySelector<HTMLElement>(".progress-wrap");
      return el !== null && el.style.opacity === "0";
    },
    { timeout: 45_000 },
  );
  // Let the last repaint land before screenshots.
  await page.waitForTimeout(500);
}

export async function gotoApp(page: Page, query = "?autoplay=0"): Promise<void> {
  await pinClock(page);
  await page.goto(`/${query}`);
}
