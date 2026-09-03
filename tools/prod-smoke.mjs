// Read-only smoke check of the deployed build: the wss path, the live metrics,
// the visualization, the onboarding tiers, and the lobby. Provisions nothing, so
// it does not consume the room-creation budget.
import { chromium } from "playwright";

const APP = process.argv[2] ?? "https://multicom-web.pages.dev";
let failures = 0;
const check = (pass, label, detail = "") => {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.addInitScript(() => {
  const tools = {};
  window.__tools = tools;
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool: (t) => { tools[t.name] = t; } },
  });
});

await page.goto(`${APP}/?demo=1`, { waitUntil: "domcontentloaded" });
const toolCount = await page
  .waitForFunction(() => {
    const n = Object.keys(window.__tools ?? {}).length;
    return n === 12 ? n : null;
  }, null, { timeout: 30_000 })
  .then((h) => h.jsonValue())
  .catch(() => 0);
check(toolCount === 12, "12 tools register on the deployed page", String(toolCount));

const live = await page
  .waitForFunction(
    () => document.querySelector(".mc-connection-badge")?.textContent?.includes("Live") ?? false,
    null,
    { timeout: 30_000 },
  )
  .then(() => true)
  .catch(() => false);
check(live, "the deployed page reports a live room connection over wss");

const rate = await page
  .waitForFunction(
    () => {
      const t = document.querySelector('[data-testid="error-rate"]')?.textContent;
      return t && Number.parseFloat(t) > 5 ? t : null;
    },
    null,
    { timeout: 30_000 },
  )
  .then((h) => h.jsonValue())
  .catch(() => null);
check(rate !== null, "live fault metrics arrive from the real target", rate ?? "none");

const viz = await page.getByTestId("hero-viz").getAttribute("data-viz").catch(() => null);
check(viz === "webgl" || viz === "canvas", "hero visualization mounted", `data-viz=${viz}`);

const onboarding = await page.getByTestId("spectator-banner").isVisible().catch(() => false);
check(onboarding, "onboarding tiers shown to a visitor with no seat");

const instruction = await page.getByTestId("agent-instruction").textContent().catch(() => "");
check(
  instruction.includes("under the name Judge") && !instruction.includes("Priya"),
  "the first instruction names no demo fixture",
);

const lobby = await ctx.newPage();
await lobby.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
const hasLobby = await lobby
  .waitForSelector('[data-testid="start-own-incident"]', { timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
check(hasLobby, "the bare URL shows the judge lobby, not a shared room");
const hasDemoPath = await lobby.getByTestId("watch-live-demo").isVisible().catch(() => false);
check(hasDemoPath, "the lobby also offers the curated demo");

check(errors.length === 0, "no console errors", errors.join(" | ").slice(0, 300));

await browser.close();
console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
