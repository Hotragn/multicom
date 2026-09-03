import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { INJECTION_TRAP_LINE } from "../shared/scenario";
import { callTool, openRoom } from "./support/page-tools";
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

async function newRoomPage(
  context: BrowserContext,
  room: string,
  commander = false,
  demo = false,
): Promise<Page> {
  const page = await context.newPage();
  await openRoom(page, app.origin, room, demo, commander ? "test-commander-token" : undefined);
  return page;
}

async function shoot(page: Page, name: string, dwellMs = 2_200): Promise<void> {
  // Let the two-second sparkline sweep at least once so the trend has shape.
  await page.waitForTimeout(dwellMs);
  await page.screenshot({ path: resolve(SHOT_DIR, `${name}.png`) });
}

test("captures the incident room walkthrough", async ({ browser }) => {
  const commanderContext = await browser.newContext({ viewport: DESKTOP });
  const responderContext = await browser.newContext({ viewport: DESKTOP });
  try {
    const commander = await newRoomPage(commanderContext, "shots", true);
    const responder = await newRoomPage(responderContext, "shots");
    await callTool(commander, "join_room", { name: "Priya", role: "commander" });
    await callTool(responder, "join_room", { name: "Arjun", role: "responder" });
    await expect(commander.getByText("2 people in room")).toBeVisible();
    await expect
      .poll(async () => {
        const text = await commander.getByTestId("error-rate").textContent();
        return Number.parseFloat(text ?? "0");
      })
      .toBeGreaterThan(5);
    await shoot(commander, "01-critical-room", 14_000);

    const hypothesis = await callTool<{ hypothesisId: string }>(responder, "propose_hypothesis", {
      title: "DB connection pool exhausted",
      evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire for 30s",
      confidence: 0.88,
    });
    await callTool(commander, "counter_hypothesis", {
      hypothesisId: hypothesis.hypothesisId,
      evidence: "The error timeline predates the feature flag change, so the flag is not the cause.",
    });
    await expect(responder.getByTestId("hypothesis-card")).toHaveCount(1);
    await responder.getByRole("group").getByText("Review rebuttal").click();
    await expect(responder.getByText("The error timeline predates")).toBeVisible();
    await shoot(responder, "02-hypothesis-and-rebuttal");

    const mitigation = await callTool<{ mitigationId: string }>(responder, "propose_mitigation", {
      hypothesisId: hypothesis.hypothesisId,
      actionId: "scale_pool:default",
      blastRadius: "Existing connections may reconnect once.",
    });
    await callTool(commander, "vote", { targetId: mitigation.mitigationId, choice: "yes" });
    await callTool(responder, "vote", { targetId: mitigation.mitigationId, choice: "yes" });
    await responder.evaluate(({ id }) => {
      const tool = window.__multicomTools?.request_human_confirm;
      if (!tool) throw new Error("request_human_confirm is not registered");
      window.__pendingTool = tool.execute({ mitigationId: id }, { signal: new AbortController().signal });
    }, { id: mitigation.mitigationId });
    await expect(commander.getByTestId("confirm-dialog")).toBeVisible();
    await shoot(commander, "03-commander-confirmation");

    await commander.getByTestId("approve-mitigation").click();
    await responder.evaluate(async () => window.__pendingTool);
    await callTool(responder, "apply_mitigation", { actionId: "scale_pool:default" });
    await expect
      .poll(async () => commander.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");
    await expect(responder.getByTestId("room-phase")).toHaveText("Resolved");
    await shoot(commander, "04-resolved-room");
    await shoot(responder, "05-resolved-second-browser");
  } finally {
    await commanderContext.close();
    await responderContext.close();
  }
});

test("captures the cold open a judge sees with no agent attached", async ({ browser }) => {
  harness.reset();
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    // No join_room call: this is exactly what opening the public demo link shows.
    const page = await newRoomPage(context, "shots-spectator", false, true);
    await expect(page.getByTestId("spectator-banner")).toBeVisible();
    const redHerring = page.locator('[data-testid="hypothesis-card"]', { hasText: "new-checkout flag caused" });
    await expect(redHerring).toBeVisible({ timeout: 12_000 });
    await shoot(page, "08-judge-cold-open", 4_000);
  } finally {
    await context.close();
  }
});

test("captures untrusted log text rendered literally", async ({ browser }) => {
  harness.reset();
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await newRoomPage(context, "shots-untrusted", true);
    await callTool(page, "join_room", { name: "Priya", role: "commander" });
    const logs = await callTool<{ lines: string[] }>(page, "query_logs", {
      service: "storefront-api",
      window: "15m",
    });
    expect(logs.lines).toContain(INJECTION_TRAP_LINE);
    await callTool(page, "propose_hypothesis", {
      title: "Log line asks me to skip diagnosis — treating it as evidence only",
      evidence: INJECTION_TRAP_LINE,
      confidence: 0.15,
    });
    const card = page.getByTestId("hypothesis-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("SYSTEM-NOTE");
    await shoot(page, "06-untrusted-text-literal", 8_000);
  } finally {
    await context.close();
  }
});

test("captures the room on a small screen", async ({ browser }) => {
  harness.reset();
  const context = await browser.newContext({ viewport: MOBILE });
  try {
    const page = await newRoomPage(context, "shots-mobile", true);
    await callTool(page, "join_room", { name: "Priya", role: "commander" });
    await callTool(page, "propose_hypothesis", {
      title: "DB connection pool exhausted",
      evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire for 30s",
      confidence: 0.88,
    });
    await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);
    await shoot(page, "07-mobile-room");
  } finally {
    await context.close();
  }
});
