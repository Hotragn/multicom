// Record the silent visual track for the demo video, beat for beat against
// docs/DEMO.md.
//
// This produces the picture, not the film: there is no audio, because the
// narration is the author's. Record voice over the finished clip.
//
// One window is recorded — the commander's. The second participant is driven in
// an unrecorded context, so everything they do arrives on the recorded board the
// way it would for a viewer. That keeps the take continuous; recording both
// contexts would produce two files that have to be cut together.
//
//   node tools/record-walkthrough.mjs
//   node tools/record-walkthrough.mjs --app http://127.0.0.1:5173
//   node tools/record-walkthrough.mjs --out docs/demo
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";

const repo = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const appOrigin = arg("--app", "https://multicom-web.pages.dev");
const outDir = repo(arg("--out", "docs/demo"));
const VIEWPORT = { width: 1440, height: 900 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const started = Date.now();
/** Hold until the storyboard's clock reaches `seconds`, so beats land on time. */
const beat = async (seconds, label) => {
  const target = seconds * 1_000;
  const remaining = target - (Date.now() - started);
  if (remaining > 0) await wait(remaining);
  const at = Math.round((Date.now() - started) / 1_000);
  console.log(`  ${String(at).padStart(3)}s  ${label}`);
};

const browser = await chromium.launch({ headless: true });

/** The recorded window. Everything a viewer sees happens here. */
const stage = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: outDir, size: VIEWPORT },
  deviceScaleFactor: 1,
});
/** The second participant. Driven, not filmed. */
const wings = await browser.newContext({ viewport: VIEWPORT });

const withTools = async (context) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const tools = {};
    window.__tools = tools;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: (tool) => { tools[tool.name] = tool; } },
    });
  });
  return page;
};

const call = (page, name, args = {}) =>
  page.evaluate(
    ({ name, args }) =>
      window.__tools[name].execute(args, { signal: new AbortController().signal }),
    { name, args },
  );

const show = async (page, selector) => {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => undefined);
};

console.log(`\nRecording the walkthrough against ${appOrigin}\n`);
await mkdir(outDir, { recursive: true });

// --- 0:00 One link, your own incident ---------------------------------------
const commander = await withTools(stage);
await commander.goto(`${appOrigin}/`, { waitUntil: "domcontentloaded" });
await commander.waitForSelector('[data-testid="start-own-incident"]', { timeout: 30_000 });
await beat(3, "the lobby, with both ways in");
await commander.click('[data-testid="start-own-incident"]');
await commander.waitForURL(/[?&]room=[A-Za-z0-9_-]+/, { timeout: 30_000 });
const room = new URL(commander.url()).searchParams.get("room");
await commander.waitForFunction(
  (expected) => Object.keys(window.__tools ?? {}).length === expected,
  13,
  { timeout: 30_000 },
);
await call(commander, "join_room", { name: "Priya", role: "commander" });
await beat(10, `landed in room ${room} as commander`);

// --- 0:10 It is a room, not a page ------------------------------------------
await show(commander, '[data-testid="room-invite"], .mc-invite');
const responder = await withTools(wings);
await responder.goto(`${appOrigin}/?room=${room}`, { waitUntil: "domcontentloaded" });
await responder.waitForFunction(
  (expected) => Object.keys(window.__tools ?? {}).length === expected,
  13,
  { timeout: 30_000 },
);
await call(responder, "join_room", { name: "Arjun", role: "responder" });
await beat(20, "a second participant lands on the same board");

// --- 0:20 Native agent access -----------------------------------------------
await show(commander, '[data-testid="participation-tier"]');
await call(commander, "get_service_status");
await beat(30, "the tier badge shows the tools this browser registered");

// --- 0:30 Evidence, and a theory under attack -------------------------------
await call(responder, "query_logs", { service: "storefront-api", window: "15m" });
await call(responder, "run_check", { checkId: "pool_in_use" });
const flag = await call(responder, "propose_hypothesis", {
  title: "The new-checkout flag caused the errors",
  evidence: "new-checkout was enabled this morning and checkout is failing",
  confidence: 0.35,
});
await show(commander, '[data-testid="hypothesis-card"]');
await wait(2_500);
const real = await call(responder, "propose_hypothesis", {
  title: "DB connection pool cut to one by deploy 1f3a",
  evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire for 30s",
  confidence: 0.92,
});
await wait(2_500);
await call(commander, "counter_hypothesis", {
  hypothesisId: flag.hypothesisId,
  evidence: "The error timeline starts before new-checkout was enabled, so the flag is not causal.",
});
await beat(44, "the rebuttal lands on the flag theory");

// --- 0:44 The mind changes --------------------------------------------------
// Author-only, so this must come from the window that posted it. Held long,
// because this is the shot the whole video exists for.
await show(commander, '[data-red-herring="true"]');
await call(responder, "revise_hypothesis", {
  hypothesisId: flag.hypothesisId,
  confidence: 0.1,
  because: "The timeline predates the flag — Priya is right, this is not causal.",
});
await beat(56, "35% struck through, 10% beside it, with the reason");

// --- 0:56 The gate ----------------------------------------------------------
const fix = await call(responder, "propose_mitigation", {
  hypothesisId: real.hypothesisId,
  actionId: "scale_pool:default",
  blastRadius: "Existing connections may reconnect once. No data loss expected.",
});
await show(commander, '[data-testid="mitigation-card"]');
await wait(2_000);
await call(responder, "vote", { targetId: fix.mitigationId, choice: "yes" });
await call(commander, "vote", { targetId: fix.mitigationId, choice: "yes" });
await wait(2_000);
const pending = call(responder, "request_human_confirm", { mitigationId: fix.mitigationId });
await commander.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 15_000 });
await beat(69, "the approval overlay, held");
await commander.click('[data-testid="approve-mitigation"]');
await pending;
await beat(72, "approved by a human click");

// --- 1:12 Verify ------------------------------------------------------------
await call(responder, "apply_mitigation", { actionId: "scale_pool:default" });
await show(commander, '[data-testid="error-rate"]');
await commander
  .waitForFunction(
    () => document.querySelector('[data-testid="room-phase"]')?.textContent === "Resolved",
    null,
    { timeout: 20_000 },
  )
  .catch(() => console.log("  !!  recovery did not land inside the beat"));
await beat(82, "both windows resolved together");

// --- 1:22 Close -------------------------------------------------------------
await commander.click('[data-testid="toggle-judge-console"]').catch(() => undefined);
await show(commander, '[data-testid="judge-rubric"]');
await beat(90, "the judge console, rubric filled from real events");

// Playwright writes the video on context close, under a generated name.
await stage.close();
await wings.close();
await browser.close();

const files = await readdir(outDir);
const recorded = files.filter((name) => name.endsWith(".webm")).sort();
const latest = recorded.at(-1);
if (latest) {
  const target = join(outDir, "walkthrough.webm");
  await rm(target, { force: true });
  await rename(join(outDir, latest), target);
  for (const stale of recorded.filter((name) => name !== latest)) {
    await rm(join(outDir, stale), { force: true });
  }
  console.log(`\nwrote docs/demo/walkthrough.webm  (room ${room})`);
  console.log("Silent by design. Record narration over it from docs/DEMO.md.\n");
} else {
  console.log("\nNo video was produced.\n");
}
