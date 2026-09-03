// Capture what is actually live, as evidence rather than as a walkthrough step.
//
// The numbered screenshots under docs/screenshots/ come from
// `npm run capture:screenshots`, which drives the local build through the room
// protocol. This one photographs the deployed site, so a stale copy silently
// claims the wrong build is in production — which is exactly what happened
// after the 2026-09-03 deploy.
//
//   node tools/capture-production.mjs [--app <origin>]
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const appOrigin = arg("--app", "https://multicom-web.pages.dev");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

// The curated demo, because it shows a live incident with the house responder
// working it — no provisioning, so this costs none of the room budget.
await page.goto(`${appOrigin}/?demo=1`, { waitUntil: "domcontentloaded" });

// Wait for real metrics rather than a placeholder dash, so the shot cannot
// capture a page that never connected.
const rate = await page
  .waitForFunction(
    () => {
      const text = document.querySelector('[data-testid="error-rate"]')?.textContent;
      return text && Number.parseFloat(text) > 5 ? text : null;
    },
    null,
    { timeout: 30_000 },
  )
  .then((handle) => handle.jsonValue())
  .catch(() => null);

if (rate === null) {
  await browser.close();
  console.error("The deployed page never showed a live fault. Not capturing a broken shot.");
  process.exit(1);
}

// Let the house responder post its theory, so the board is not empty.
await page
  .locator('[data-testid="hypothesis-card"]')
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
// One sparkline sweep, so the p99 timeline has shape.
await page.waitForTimeout(3_000);

const path = repo("docs/screenshots/evidence-live-production.png");
await page.screenshot({ path });
console.log(`captured ${appOrigin} at ${rate} errors -> docs/screenshots/evidence-live-production.png`);
await browser.close();
