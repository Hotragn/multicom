// Prove a real Chrome exposes WebMCP natively, and that the room page registers
// into it rather than into the MCP-B polyfill.
//
// chrome://flags/#enable-webmcp-testing has no working --enable-features
// spelling, so this drives the flags UI in a persistent profile the way a
// person would, then relaunches that profile and probes the surface.
//
//   node tools/chrome-webmcp-check.mjs [--url <page>] [--profile <dir>]
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Resolve repo paths from this file, so the script works from any directory.
const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const target = arg("--url", "https://multicom-web.pages.dev/?demo=1");
const profile = arg("--profile", join(tmpdir(), "multicom-webmcp-profile"));
const FLAG = "enable-webmcp-testing";

// The flags page nests each experiment in shadow roots.
const setFlag = (flagId) => {
  const walk = (root, out = []) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, out);
    }
    return out;
  };
  const all = walk(document);
  const container = all.find((el) => el.getAttribute?.("id") === flagId);
  if (!container) return { ok: false, reason: "flag not found" };
  const select = walk(container).find((el) => el.tagName === "SELECT") ??
    (container.shadowRoot ? walk(container.shadowRoot).find((el) => el.tagName === "SELECT") : null);
  if (!select) return { ok: false, reason: "no select for flag" };
  const enabled = [...select.options].find((option) => /^enabled$/i.test(option.textContent.trim()));
  if (!enabled) return { ok: false, reason: `options: ${[...select.options].map((o) => o.textContent.trim()).join("|")}` };
  select.value = enabled.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, chose: enabled.textContent.trim() };
};

const probe = () => ({
  navigator: typeof navigator.modelContext,
  document: typeof document.modelContext,
  registerTool: typeof (document.modelContext ?? navigator.modelContext)?.registerTool,
  // The polyfill brands itself; a native surface will not carry this.
  polyfillBrand: Boolean(
    (document.modelContext ?? navigator.modelContext) &&
      Object.prototype.hasOwnProperty.call(document.modelContext ?? navigator.modelContext, "__isWebMCPPolyfill"),
  ),
});

const report = { checkedAt: new Date().toISOString(), target, profile, flag: FLAG };

// 1. Turn the flag on and let Chrome persist it to the profile.
let context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: false });
let page = context.pages()[0] ?? (await context.newPage());
await page.goto("chrome://flags", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2_000);
report.flagToggle = await page.evaluate(setFlag, FLAG);
console.log(`flag toggle: ${JSON.stringify(report.flagToggle)}`);
await page.waitForTimeout(1_000);
await context.close();

// 2. Reopen the same profile so the flag is in effect, and probe a bare page.
context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: false });
page = context.pages()[0] ?? (await context.newPage());
// An opaque origin never gets the API, so probe a real https page instead.
await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
report.secureOrigin = await page.evaluate(probe);
report.nativeWebMcp = report.secureOrigin.registerTool === "function" && !report.secureOrigin.polyfillBrand;
console.log(`https origin, flag on: ${JSON.stringify(report.secureOrigin)}`);
console.log(`native WebMCP: ${report.nativeWebMcp ? "YES" : "no"}`);

// 3. Load the room page and record which surface actually carried the tools.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(target, { waitUntil: "load" });
await page.waitForTimeout(5_000);
report.deployedPage = await page.evaluate(async () => {
  const surface = document.modelContext ?? navigator.modelContext;
  if (!surface || typeof surface.getTools !== "function") return { error: "no getTools on this surface" };
  const tools = await surface.getTools();
  return {
    count: tools.length,
    longestDescription: Math.max(...tools.map((tool) => (tool.description ?? "").length)),
    names: tools.map((tool) => tool.name).sort(),
    viaPolyfill: Object.prototype.hasOwnProperty.call(surface, "__isWebMCPPolyfill"),
  };
});
console.log(`deployed page: ${JSON.stringify(report.deployedPage, null, 2)}`);

await mkdir(repo("docs/screenshots"), { recursive: true });
await page.screenshot({ path: repo("docs/screenshots/11-real-chrome.png") });
await context.close();


// The control: a clean profile with the flag untouched must fall back to the
// polyfill. Without it, "viaPolyfill: false" on its own proves nothing.
const controlProfile = `${profile}-control`;
const control = await chromium.launchPersistentContext(controlProfile, { channel: "chrome", headless: false });
const controlPage = control.pages()[0] ?? (await control.newPage());
await controlPage.goto(target, { waitUntil: "load" });
await controlPage.waitForTimeout(5_000);
report.controlDeployedPage = await controlPage.evaluate(async () => {
  const surface = document.modelContext ?? navigator.modelContext;
  if (!surface || typeof surface.getTools !== "function") return { error: "no getTools on this surface" };
  const tools = await surface.getTools();
  return {
    count: tools.length,
    viaPolyfill: Object.prototype.hasOwnProperty.call(surface, "__isWebMCPPolyfill"),
  };
});
await control.close();
console.log(`control profile, flag off: ${JSON.stringify(report.controlDeployedPage)}`);

report.conclusion =
  report.nativeWebMcp &&
  report.deployedPage?.viaPolyfill === false &&
  report.controlDeployedPage?.viaPolyfill === true
    ? "native WebMCP confirmed: with the flag on the page registers into the browser API; with it off the same page falls back to the polyfill"
    : "inconclusive - compare secureOrigin, deployedPage and controlDeployedPage";
console.log(report.conclusion);

await writeFile(repo("docs/webmcp-chrome-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("\nreport: docs/webmcp-chrome-report.json");
