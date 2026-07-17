/**
 * Dev utility: screenshot the running app (default http://localhost:5173).
 *   node scripts/screenshot.mjs [url] [outPath] [mobile|desktop] [waitMs]
 *
 * All non-localhost requests are fulfilled through Node's fetch so the
 * browser works in sandboxed environments where only Node has egress.
 */
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://localhost:5173/?autoplay=0";
const out = process.argv[3] ?? "screenshot.png";
const viewport = process.argv[4] === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
await ctx.route(
  (u) => u.hostname !== "localhost" && u.hostname !== "127.0.0.1",
  async (route) => {
    const req = route.request();
    try {
      const headers = { ...(await req.allHeaders()) };
      delete headers["accept-encoding"];
      const res = await fetch(req.url(), {
        method: req.method(),
        headers,
        body: req.postDataBuffer() ?? undefined,
      });
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(
          [...res.headers.entries()].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k)),
        ),
        body: Buffer.from(await res.arrayBuffer()),
      });
    } catch (e) {
      console.log("[route-error]", req.url().slice(0, 120), String(e).slice(0, 120));
      await route.abort();
    }
  },
);
const page = await ctx.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url);
await page.waitForTimeout(Number(process.argv[5] ?? 20000));
await page.screenshot({ path: out });
console.log("saved", out);
await browser.close();
