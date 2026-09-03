import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { INJECTION_TRAP_LINE } from "../shared/scenario";
import { MINTED_ROOM_ID_PATTERN } from "../shared/tenancy";
import { callTool, installWebMcpCapture, openRoom, waitForTools } from "./support/page-tools";
import { startProtocolHarness, type ProtocolHarness } from "./support/protocol-harness";
import { startWebApp, type WebApp } from "./support/web-app";

declare global {
  interface Window {
    __pendingTool?: Promise<unknown>;
  }
}

const SHOT_DIR = resolve("docs/screenshots");
const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

test.use({ browserName: "chromium" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let harness: ProtocolHarness;
let app: WebApp;

test.beforeAll(async () => {
  await mkdir(SHOT_DIR, { recursive: true });
  harness = await startProtocolHarness();
  app = await startWebApp(harness.httpOrigin);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (harness) await harness.close();
});

/** Provision a room the way the lobby does, so shots use a real judge room. */
async function provisionRoom(): Promise<string> {
  const response = await fetch(`${harness.httpOrigin}/rooms`, { method: "POST" });
  const payload = (await response.json()) as { roomId: string };
  expect(payload.roomId).toMatch(MINTED_ROOM_ID_PATTERN);
  return payload.roomId;
}

async function newRoomPage(
  context: BrowserContext,
  room: string,
  demo = false,
  judge = false,
): Promise<Page> {
  const page = await context.newPage();
  if (!judge) {
    await openRoom(page, app.origin, room, demo);
    return page;
  }
  await installWebMcpCapture(page);
  const query = new URLSearchParams({ room, judge: "1" });
  if (demo) query.set("demo", "1");
  await page.goto(`${app.origin}/?${query.toString()}`);
  await waitForTools(page);
  return page;
}

async function shoot(page: Page, name: string, dwellMs = 2_200): Promise<void> {
  // Let the two-second status cadence land at least once so the gauge and the
  // latency timeline have real shape rather than placeholder dashes.
  await page.waitForTimeout(dwellMs);
  await page.screenshot({ path: resolve(SHOT_DIR, `${name}.png`) });
}

test("captures the lobby a judge lands on", async ({ browser }) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await context.newPage();
    await page.goto(`${app.origin}/`);
    await expect(page.getByTestId("start-own-incident")).toBeVisible();
    await expect(page.getByTestId("site-onboarding")).toBeVisible();
    await expect(page.getByTestId("watch-live-demo")).toBeVisible();
    // Wait for the 3D layer so the hero is not a blank stage in the shot.
    await expect
      .poll(() => page.locator(".mc-viz").first().getAttribute("data-viz"), { timeout: 20_000 })
      .toBe("webgl");
    await shoot(page, "01-lobby", 1_500);
  } finally {
    await context.close();
  }
});

test("captures the war room, the debate, the approval and the resolution", async ({ browser }) => {
  const commanderContext = await browser.newContext({ viewport: DESKTOP });
  const responderContext = await browser.newContext({ viewport: DESKTOP });
  try {
    const room = await provisionRoom();
    const commander = await newRoomPage(commanderContext, room, false, true);
    const responder = await newRoomPage(responderContext, room);

    // Before anyone joins: the three ways in, which is the first thing a judge
    // with no agent needs to see.
    await expect(commander.getByTestId("spectator-banner")).toBeVisible();
    await shoot(commander, "03-ways-in", 3_000);

    // No commander secret anywhere: a provisioned room seats its first claimer.
    await callTool(commander, "join_room", { name: "Priya", role: "commander" });
    await callTool(responder, "join_room", { name: "Arjun", role: "responder" });
    await expect(commander.getByTestId("presence-summary")).toContainText("2 people");
    await expect
      .poll(async () => {
        const text = await commander.getByTestId("error-rate").textContent();
        return Number.parseFloat(text ?? "0");
      })
      .toBeGreaterThan(5);
    await shoot(commander, "02-war-room", 14_000);

    // Evidence first, then a theory, then the rebuttal that kills the decoy.
    await callTool(responder, "query_logs", { service: "storefront-api", window: "15m" });
    await callTool(responder, "run_check", { checkId: "pool_in_use" });
    const flag = await callTool<{ hypothesisId: string }>(responder, "propose_hypothesis", {
      title: "The new-checkout flag caused the errors",
      evidence: "new-checkout was enabled this morning and checkout is failing",
      confidence: 0.35,
    });
    const real = await callTool<{ hypothesisId: string }>(responder, "propose_hypothesis", {
      title: "DB connection pool cut to one by deploy 1f3a",
      evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire for 30s",
      confidence: 0.92,
    });
    await callTool(commander, "counter_hypothesis", {
      hypothesisId: flag.hypothesisId,
      evidence: "The error timeline starts before new-checkout was enabled, so the flag is not causal.",
    });
    await expect(responder.getByTestId("hypothesis-card")).toHaveCount(2);
    await expect(
      responder.locator('[data-testid="hypothesis-card"][data-red-herring="true"]'),
    ).toContainText("Challenged");

    // The author concedes by moving their own number. This is the beat the
    // board could not show before: 35% struck through, 10% beside it, and the
    // reason underneath. A rebuttal alone leaves the original figure standing.
    await callTool(responder, "revise_hypothesis", {
      hypothesisId: flag.hypothesisId,
      confidence: 0.1,
      because: "The timeline predates the flag — Priya is right, this is not causal.",
    });
    await expect(
      responder.locator('[data-testid="hypothesis-card"][data-red-herring="true"]'),
    ).toContainText("10%");

    const mitigation = await callTool<{ mitigationId: string }>(responder, "propose_mitigation", {
      hypothesisId: real.hypothesisId,
      actionId: "scale_pool:default",
      blastRadius: "Existing connections may reconnect once. No data loss expected.",
    });
    await shoot(responder, "04-investigation", 3_000);

    // A stated reason on a vote, which is what explain_vote exists for.
    await callTool(commander, "vote", { targetId: mitigation.mitigationId, choice: "yes" });
    await callTool(commander, "explain_vote", {
      targetId: mitigation.mitigationId,
      rationale:
        "deploy_diff shows the pool change and nothing else in 1f3a, so this is the only cause that fits.",
    });
    await callTool(responder, "vote", { targetId: mitigation.mitigationId, choice: "yes" });
    await responder.getByTestId("vote-rationales").getByText("stated reason").click();
    await expect(responder.getByText("deploy_diff shows the pool change")).toBeVisible();
    await shoot(responder, "11-vote-rationale", 1_500);

    // The climax: the commander's overlay, naming the server-derived action.
    await responder.evaluate(({ id }) => {
      const tool = window.__multicomTools?.request_human_confirm;
      if (!tool) throw new Error("request_human_confirm is not registered");
      window.__pendingTool = tool.execute({ mitigationId: id }, { signal: new AbortController().signal });
    }, { id: mitigation.mitigationId });
    await expect(commander.getByTestId("confirm-dialog")).toBeVisible();
    await expect(commander.getByTestId("approval-action")).toHaveText("scale_pool:default");
    await shoot(commander, "05-commander-approval", 1_500);

    await commander.getByTestId("approve-mitigation").click();
    await responder.evaluate(async () => window.__pendingTool);
    await callTool(responder, "apply_mitigation", { actionId: "scale_pool:default" });
    // The refused replay is what fills the single-use rubric row.
    await callTool(commander, "apply_mitigation", { actionId: "scale_pool:default" });
    await callTool(commander, "query_logs", { service: "storefront-api", window: "15m" });
    await expect
      .poll(async () => commander.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");
    await expect(responder.getByTestId("room-phase")).toHaveText("Resolved");
    await shoot(commander, "08-resolved", 2_500);

    // The judge console, with a rubric filled only by events that happened.
    await expect(commander.getByTestId("judge-rubric")).toBeVisible();
    await expect(commander.getByTestId("run-summary")).toBeVisible();
    await commander.getByTestId("judge-console").scrollIntoViewIfNeeded();
    await shoot(commander, "07-judge-console", 1_500);
  } finally {
    await commanderContext.close();
    await responderContext.close();
  }
});

test("captures the manual operator path", async ({ browser }) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await page.getByTestId("drive-manually").click();
    await page.getByTestId("manual-name").fill("Judge");
    await page.getByTestId("manual-role").selectOption("commander");
    await page.getByTestId("manual-join").click();
    await expect(page.getByTestId("participation-tier")).toContainText("Driving it yourself");

    await page.getByTestId("manual-check-id").selectOption("deploy_diff");
    await page.getByTestId("manual-run-check").click();
    await expect(page.locator('[data-testid="manual-output"] .mc-manual__line')).toContainText(
      "DB_POOL_MAX",
    );
    await page.getByTestId("manual-title").fill("DB pool cut to one by deploy 1f3a");
    await page
      .getByTestId("manual-evidence")
      .fill("deploy_diff shows DB_POOL_MAX changed from 50 to 1");
    await page.getByTestId("manual-propose-hypothesis").click();
    await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);
    await page.getByTestId("manual-controls").scrollIntoViewIfNeeded();
    await shoot(page, "06-manual-controls", 2_500);
  } finally {
    await context.close();
  }
});

test("captures untrusted log text rendered literally", async ({ browser }) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await callTool(page, "join_room", { name: "Priya", role: "commander" });
    const logs = await callTool<{ lines: string[] }>(page, "query_logs", {
      service: "storefront-api",
      window: "15m",
    });
    expect(logs.lines).toContain(INJECTION_TRAP_LINE);
    await callTool(page, "propose_hypothesis", {
      title: "A log line asks me to skip diagnosis — treating it as evidence only",
      evidence: INJECTION_TRAP_LINE,
      confidence: 0.15,
    });
    const card = page.getByTestId("hypothesis-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("SYSTEM-NOTE");
    await shoot(page, "09-untrusted-literal", 8_000);
  } finally {
    await context.close();
  }
});

test("captures the room on a small screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: MOBILE });
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await callTool(page, "join_room", { name: "Priya", role: "commander" });
    await callTool(page, "propose_hypothesis", {
      title: "DB connection pool exhausted",
      evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire for 30s",
      confidence: 0.88,
    });
    // The phone layout is tabbed rather than stacked, so shoot the tab a judge
    // would open to read the debate.
    await expect(page.getByTestId("tab-investigation")).toBeVisible();
    await page.getByTestId("tab-investigation").click();
    await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);
    await shoot(page, "10-mobile", 3_000);
  } finally {
    await context.close();
  }
});
