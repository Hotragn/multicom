import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { INJECTION_TRAP_LINE, ROOM_ID } from "../shared/scenario";
import { MINTED_ROOM_ID_PATTERN, isMintedRoomId } from "../shared/tenancy";
import { TOOL_NAMES } from "../shared/tools";
import { callTool, installWebMcpCapture, openRoom, waitForTools } from "./support/page-tools";
import { startProtocolHarness, type ProtocolHarness } from "./support/protocol-harness";
import { RawClient } from "./support/raw-client";
import { startWebApp, type WebApp } from "./support/web-app";

interface ToolFailure {
  error: { code: string; message: string };
}

interface ToolData {
  kind: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __pendingTool?: Promise<unknown>;
    __xssExecuted?: number;
    /** Stamped in the observing page when a propagated hypothesis first renders. */
    __seenAt?: number;
  }
}

test.use({ browserName: "chromium" });
test.describe.configure({ mode: "serial" });
test.setTimeout(30_000);

let harness: ProtocolHarness;
let app: WebApp;

test.beforeAll(async () => {
  harness = await startProtocolHarness();
  app = await startWebApp(harness.httpOrigin);
});

test.afterEach(() => {
  harness.reset();
});

test.afterAll(async () => {
  if (app) await app.close();
  if (harness) await harness.close();
});

async function newRoomPage(context: BrowserContext, room: string, demo = false, commander = false): Promise<Page> {
  const page = await context.newPage();
  await openRoom(page, app.origin, room, demo, commander ? "test-commander-token" : undefined);
  return page;
}

async function join(page: Page, name: string, role: "commander" | "responder"): Promise<void> {
  const result = await callTool<{ memberId?: string; error?: unknown }>(page, "join_room", { name, role });
  expect(result.error).toBeUndefined();
  expect(result.memberId).toMatch(/^u\d+$/);
}

async function hypothesis(page: Page, title = "DB pool exhausted"): Promise<string> {
  const result = await callTool<ToolData>(page, "propose_hypothesis", {
    title,
    evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire",
    confidence: 0.88,
  });
  expect(result.kind).toBe("hypothesis");
  return result.hypothesisId as string;
}

async function mitigation(page: Page, hypothesisId: string, actionId: string): Promise<string> {
  const result = await callTool<ToolData>(page, "propose_mitigation", {
    hypothesisId,
    actionId,
    blastRadius: "Existing connections may reconnect once.",
  });
  expect(result.kind).toBe("mitigation");
  return result.mitigationId as string;
}

async function beginConfirmation(page: Page, mitigationId: string): Promise<void> {
  await page.evaluate(({ id }) => {
    const tool = window.__multicomTools?.request_human_confirm;
    if (!tool) throw new Error("request_human_confirm is not registered");
    window.__pendingTool = tool.execute(
      { mitigationId: id },
      { signal: new AbortController().signal },
    );
  }, { id: mitigationId });
}

async function finishPending<T>(page: Page): Promise<T> {
  return page.evaluate(async () => {
    if (!window.__pendingTool) throw new Error("No pending tool call.");
    return window.__pendingTool;
  }) as Promise<T>;
}

/** Provision a room the way the lobby does, and hand back its minted id. */
async function provisionRoom(): Promise<string> {
  const response = await fetch(`${harness.httpOrigin}/rooms`, { method: "POST" });
  expect(response.ok).toBe(true);
  const payload = (await response.json()) as { roomId?: string; selfServe?: boolean };
  expect(payload.roomId).toMatch(MINTED_ROOM_ID_PATTERN);
  expect(payload.selfServe).toBe(true);
  return payload.roomId!;
}

/** Drive one room from a fault to a verified recovery, through the real gates. */
async function resolveRoom(page: Page, mitigationAction = "scale_pool:default"): Promise<void> {
  const hypothesisId = await hypothesis(page, `Pool exhausted in ${await page.title()}`);
  const mitigationId = await mitigation(page, hypothesisId, mitigationAction);
  await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });
  await beginConfirmation(page, mitigationId);
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("approve-mitigation").click();
  await finishPending(page);
  const applied = await callTool<ToolData>(page, "apply_mitigation", { actionId: mitigationAction });
  expect(applied).toMatchObject({ kind: "apply", applied: true });
}

async function errorRate(page: Page): Promise<number> {
  const text = await page.getByTestId("error-rate").textContent();
  return Number.parseFloat(text ?? "NaN");
}

test("registers the exact WebMCP surface once with bounded descriptions", async ({ page }) => {
  await openRoom(page, app.origin, "registration");
  const tools = await page.evaluate(() => Object.values(window.__multicomTools ?? {}).map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations ?? {},
  })));

  expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  expect(tools).toHaveLength(12);
  expect(tools.every((tool) => tool.description.length < 120)).toBe(true);
  expect(tools.find((tool) => tool.name === "query_logs")?.annotations).toMatchObject({
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  expect(await page.locator("iframe").count()).toBe(0);
});

test("propagates hypotheses across isolated tabs in under 300 ms and renders hostile text literally", async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const commander = await newRoomPage(first, "realtime", false, true);
    const responder = await newRoomPage(second, "realtime");
    await join(commander, "Priya", "commander");
    await join(responder, "Arjun", "responder");

    const logs = await callTool<ToolData>(responder, "query_logs", { service: "storefront-api", window: "15m" });
    expect(logs.kind).toBe("logs");
    expect(logs.untrustedContentHint).toBe(true);
    expect(logs.lines).toContain(INJECTION_TRAP_LINE);
    expect(Buffer.byteLength(JSON.stringify(logs), "utf8")).toBeLessThan(2_048);

    await commander.evaluate(() => { window.__xssExecuted = 0; });
    const hostile = '<img src=x onerror="window.__xssExecuted=1"> pool exhausted';

    // SPEC criterion 1 is about the room: a hypothesis reaches every other
    // browser within 300 ms. Timing it from the test process measured the CDP
    // round trips either side of that as well, which is why it read 1.4s on a
    // loaded machine and 468ms on a merely busy one. Both stamps are now taken
    // inside the pages, with Date.now() so they share a clock, and a
    // MutationObserver rather than rAF because a background page throttles
    // animation frames.
    await commander.evaluate((text) => {
      window.__seenAt = 0;
      const holdsText = () =>
        Array.from(document.querySelectorAll('[data-testid="hypothesis-card"]')).some((node) =>
          node.textContent?.includes(text),
        );
      const stamp = (): boolean => {
        if (!holdsText()) return false;
        window.__seenAt = Date.now();
        observer.disconnect();
        return true;
      };
      const observer = new MutationObserver(() => stamp());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      stamp();
    }, hostile);

    const sentAt = await responder.evaluate(async ({ text }) => {
      const tool = window.__multicomTools?.propose_hypothesis;
      if (!tool) throw new Error("propose_hypothesis is not registered");
      const at = Date.now();
      await tool.execute(
        {
          title: text,
          evidence: "pool_in_use reports 1/1 and checkout waits at pool.acquire",
          confidence: 0.88,
        },
        { signal: new AbortController().signal },
      );
      return at;
    }, { text: hostile });

    await commander.waitForFunction(() => (window.__seenAt ?? 0) > 0);
    const seenAt = await commander.evaluate(() => window.__seenAt ?? 0);
    expect(seenAt - sentAt).toBeLessThan(300);
    const card = commander.locator('[data-testid="hypothesis-card"]', { hasText: hostile });
    await expect(card).toHaveCount(1);
    expect(await card.locator("img").count()).toBe(0);
    expect(await commander.evaluate(() => window.__xssExecuted)).toBe(0);

    const sourceFiles = ["web/ui/index.ts", "web/ui/dom.ts"];
    for (const relative of sourceFiles) {
      const source = await readFile(resolve(relative), "utf8");
      expect(source).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test("enforces passage, approval binding, expiry, and single-use replay protection", async ({ browser }) => {
  const commanderContext = await browser.newContext();
  const responderContext = await browser.newContext();
  try {
    const commander = await newRoomPage(commanderContext, "approval", false, true);
    const responder = await newRoomPage(responderContext, "approval");
    await join(commander, "Priya", "commander");
    await join(responder, "Arjun", "responder");
    const hypothesisId = await hypothesis(responder);
    const mitigationId = await mitigation(responder, hypothesisId, "rollback:deploy-1f3a");

    await callTool(commander, "vote", { targetId: mitigationId, choice: "yes" });
    const notPassed = await callTool<ToolFailure>(commander, "apply_mitigation", { actionId: "rollback:deploy-1f3a" });
    expect(notPassed.error.code).toBe("not_passed");

    const invented = await callTool<ToolFailure>(commander, "apply_mitigation", { actionId: "shell:restart" });
    expect(invented.error.code).toBe("unknown_action");

    await callTool(responder, "vote", { targetId: mitigationId, choice: "yes" });
    const unapproved = await callTool<ToolFailure>(responder, "apply_mitigation", { actionId: "rollback:deploy-1f3a" });
    expect(unapproved.error.code).toBe("needs_human_confirm");

    await beginConfirmation(responder, mitigationId);
    await expect(commander.getByTestId("confirm-dialog")).toBeVisible();
    await commander.getByTestId("approve-mitigation").click();
    expect(await finishPending<ToolData>(responder)).toMatchObject({ kind: "confirm", approved: true, reason: "granted" });

    // A commander who says no reads differently from one who never answered.
    const second = await mitigation(responder, hypothesisId, "disable_flag:new-checkout");
    await callTool(commander, "vote", { targetId: second, choice: "yes" });
    await callTool(responder, "vote", { targetId: second, choice: "yes" });
    await beginConfirmation(responder, second);
    await expect(commander.getByTestId("confirm-dialog")).toBeVisible();
    await commander.getByTestId("reject-mitigation").click();
    expect(await finishPending<ToolData>(responder)).toMatchObject({
      kind: "confirm",
      approved: false,
      reason: "rejected",
    });
    const afterReject = await callTool<ToolFailure>(responder, "apply_mitigation", { actionId: "disable_flag:new-checkout" });
    expect(afterReject.error.code).toBe("needs_human_confirm");

    const applied = await callTool<ToolData>(responder, "apply_mitigation", { actionId: "rollback:deploy-1f3a" });
    expect(applied).toMatchObject({ kind: "apply", applied: true });
    const replay = await callTool<ToolFailure>(responder, "apply_mitigation", { actionId: "rollback:deploy-1f3a" });
    expect(replay.error.code).toBe("needs_human_confirm");

    await expect.poll(async () => commander.getByTestId("error-rate").textContent()).toBe("17%");
    await expect(commander.getByTestId("room-phase")).toHaveText("Mitigating");
  } finally {
    await commanderContext.close();
    await responderContext.close();
  }

  harness.reset();
  harness.setApprovalTtl(1_200);
  const expiryContext = await browser.newContext();
  try {
    const page = await newRoomPage(expiryContext, "approval-expiry", false, true);
    await join(page, "Sam", "commander");
    const hypothesisId = await hypothesis(page);
    const mitigationId = await mitigation(page, hypothesisId, "disable_flag:new-checkout");
    await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });
    await beginConfirmation(page, mitigationId);
    expect(await finishPending<ToolData>(page)).toMatchObject({ kind: "confirm", approved: false, reason: "expired" });
    const expiredApply = await callTool<ToolFailure>(page, "apply_mitigation", { actionId: "disable_flag:new-checkout" });
    expect(expiredApply.error.code).toBe("needs_human_confirm");
    const productionRoom = await readFile(resolve("worker/src/room.ts"), "utf8");
    expect(productionRoom).toMatch(/APPROVAL_TTL_MS\s*=\s*60_000/);
  } finally {
    await expiryContext.close();
  }
});

test("real mitigation turns every connected tab healthy and resolved within ten seconds", async ({ browser }) => {
  test.setTimeout(25_000);
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const commander = await newRoomPage(first, "recovery", false, true);
    const responder = await newRoomPage(second, "recovery");
    await join(commander, "Priya", "commander");
    await join(responder, "Arjun", "responder");
    const hypothesisId = await hypothesis(responder);
    await callTool(responder, "counter_hypothesis", {
      hypothesisId,
      evidence: "The error timeline predates the feature flag change.",
    });
    const mitigationId = await mitigation(responder, hypothesisId, "scale_pool:default");
    await callTool(commander, "vote", { targetId: mitigationId, choice: "yes" });
    await callTool(responder, "vote", { targetId: mitigationId, choice: "yes" });
    await beginConfirmation(responder, mitigationId);
    await expect(commander.getByTestId("confirm-dialog")).toBeVisible();
    await commander.getByTestId("approve-mitigation").click();
    await finishPending(responder);

    const started = performance.now();
    const applied = await callTool<ToolData>(responder, "apply_mitigation", { actionId: "scale_pool:default" });
    expect(applied).toMatchObject({ kind: "apply", applied: true });
    await expect.poll(async () => {
      const values = await Promise.all([
        commander.getByTestId("error-rate").textContent(),
        responder.getByTestId("error-rate").textContent(),
      ]);
      return values.every((value) => value !== null && Number.parseFloat(value) < 2);
    }, { timeout: 10_000, intervals: [100, 250, 500] }).toBe(true);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    await expect(commander.getByTestId("room-phase")).toHaveText("Resolved");
    await expect(responder.getByTestId("room-phase")).toHaveText("Resolved");
    await expect(commander.getByTestId("resolved-summary")).toContainText("DB pool restored");
  } finally {
    await first.close();
    await second.close();
  }
});

test("demo mode joins and argues through the shared protocol on schedule", async ({ browser }) => {
  test.setTimeout(20_000);
  const context = await browser.newContext();
  try {
    const page = await newRoomPage(context, "demo", true, true);
    const started = performance.now();
    await join(page, "Priya", "commander");
    await expect.poll(async () => page.getByTestId("presence-summary").textContent(), { timeout: 3_000 }).toContain("2 people");
    expect(performance.now() - started).toBeLessThan(3_000);

    const redHerring = page.locator('[data-testid="hypothesis-card"]', { hasText: "new-checkout flag caused" });
    await expect(redHerring).toBeVisible({ timeout: 10_000 });
    expect(performance.now() - started).toBeLessThan(10_000);
    await callTool(page, "run_check", { checkId: "error_timeline" });
    await expect(redHerring).toContainText("Challenged");
    await expect(redHerring).toContainText("timeline starts before new-checkout");
    // The scenario's own flag name marks the red herring, so a judge can see
    // which theory is the decoy without reading every rebuttal.
    await expect(redHerring).toHaveAttribute("data-red-herring", "true");
  } finally {
    await context.close();
  }
});

test("shows a live room to a judge who opens the demo link with no agent", async ({ browser }) => {
  test.setTimeout(25_000);
  const context = await browser.newContext();
  try {
    // No join_room call anywhere in this test: this is the cold-open judge path.
    const page = await newRoomPage(context, "spectator", true);
    const started = performance.now();

    // The old copy told a visitor with no agent to go find one, which is a dead
    // end. Every judge must now be offered a path that works where they are.
    const onboarding = page.getByTestId("spectator-banner");
    await expect(onboarding).toBeVisible();
    await expect(onboarding).toContainText("Pick a way to take part");
    await expect(page.getByTestId("tier-agent")).toBeVisible();
    await expect(page.getByTestId("agent-instruction")).toContainText("Join this incident room");
    await expect(page.getByTestId("drive-manually")).toBeEnabled();
    await expect(page.getByTestId("tier-scripted")).toBeVisible();

    // The service metrics are live rather than placeholder dashes.
    await expect
      .poll(async () => {
        const text = await page.getByTestId("error-rate").textContent();
        return Number.parseFloat(text ?? "NaN");
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // The house responder joins and argues on its own, so the board is not empty.
    await expect.poll(async () => page.getByTestId("presence-summary").textContent(), { timeout: 5_000 })
      .toContain("1 person");
    const redHerring = page.locator('[data-testid="hypothesis-card"]', { hasText: "new-checkout flag caused" });
    await expect(redHerring).toBeVisible({ timeout: 12_000 });
    expect(performance.now() - started).toBeLessThan(12_000);
    await expect(page.getByTestId("hypotheses-list")).toContainText("Responder 2");

    // A spectator still cannot change anything without joining.
    const blocked = await callTool<ToolFailure>(page, "propose_hypothesis", {
      title: "Spectators cannot write",
      evidence: "This must be refused because this browser never joined the room.",
      confidence: 0.5,
    });
    expect(blocked.error).toBeDefined();

    // Joining replaces the watching notice with a seat at the table.
    await join(page, "Priya", "responder");
    await expect(page.getByTestId("spectator-banner")).toBeHidden();
    await expect.poll(async () => page.getByTestId("presence-summary").textContent()).toContain("2 people");
  } finally {
    await context.close();
  }
});

test("a self-serve room shows live health before anyone joins", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await expect.poll(() => errorRate(page), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("presence-summary")).toContainText("Nobody seated yet");
    await expect(page.getByTestId("agent-instruction")).toContainText("as commander");
  } finally {
    await context.close();
  }
});

test("agent instruction and headline follow the live room", async ({ browser }) => {
  test.setTimeout(45_000);
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const commander = await newRoomPage(context, room);
    await join(commander, "Priya", "commander");
    await expect(commander.getByTestId("spectator-banner")).toBeHidden();
    await expect(commander.getByText("Room is quiet")).toBeHidden();

    const visitor = await newRoomPage(context, room);
    await expect(visitor.getByTestId("agent-instruction")).toContainText("as a responder");
    await expect(visitor.getByTestId("agent-instruction")).not.toContainText("under the name Judge");

    await visitor.getByTestId("drive-manually").click();
    await expect(visitor.getByTestId("manual-name")).toHaveValue("");
    await expect(visitor.getByTestId("manual-role")).toHaveValue("responder");
    await expect(visitor.getByTestId("manual-confidence")).toHaveAttribute("aria-valuenow", "80");
    await expect(visitor.getByTestId("manual-confidence")).not.toHaveAttribute("readonly");

    await hypothesis(commander, "DB pool reduced to 1 connection");
    await expect(commander.getByTestId("hero-title")).toHaveText("One theory on the board");
    await expect(visitor.getByTestId("hero-title")).toHaveText("One theory on the board");
  } finally {
    await context.close();
  }
});

test("restarts a spent demo room so the next visitor gets a live incident", async ({ browser }) => {
  test.setTimeout(40_000);
  const room = "demo-restart";

  // First visitor runs the incident all the way to resolved.
  const first = await browser.newContext();
  try {
    const page = await newRoomPage(first, room, true, true);
    await join(page, "Priya", "commander");
    // A majority is counted against whoever is present, so wait for the house
    // responder to take its seat before voting. Otherwise the vote can pass
    // 1-of-1 and then stop being a majority when the bot arrives, and the apply
    // is refused for a reason that has nothing to do with this test.
    await expect
      .poll(async () => page.getByTestId("presence-summary").textContent(), { timeout: 5_000 })
      .toContain("2 people");
    const hypothesisId = await hypothesis(page);
    const mitigationId = await mitigation(page, hypothesisId, "scale_pool:default");
    await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });
    await beginConfirmation(page, mitigationId);
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("approve-mitigation").click();
    await finishPending(page);
    // Assert the write landed. A silent apply failure previously showed up only
    // as a phase that never advanced.
    const applied = await callTool<ToolData>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(applied).toMatchObject({ kind: "apply", applied: true });
    await expect
      .poll(async () => page.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");
  } finally {
    await first.close();
  }

  // The next visitor opens the same link and must not inherit a finished demo.
  const second = await browser.newContext();
  try {
    const page = await newRoomPage(second, room, true, true);
    await expect
      .poll(async () => page.getByTestId("room-phase").textContent(), { timeout: 10_000 })
      .not.toBe("Resolved");
    await expect
      .poll(async () => {
        const text = await page.getByTestId("error-rate").textContent();
        return Number.parseFloat(text ?? "NaN");
      }, { timeout: 10_000 })
      .toBeGreaterThan(5);

    // The previous run left nothing behind, and the room accepts work again.
    await expect(page.getByTestId("hypotheses-list")).not.toContainText("DB pool exhausted");
    await join(page, "Arjun", "commander");
    const reopened = await callTool<ToolData>(page, "propose_hypothesis", {
      title: "Fresh incident is investigable",
      evidence: "The room accepts new work after the previous run was cleared.",
      confidence: 0.6,
    });
    expect(reopened.kind).toBe("hypothesis");
  } finally {
    await second.close();
  }
});

test("carries a vote rationale to the other browser and only after a vote", async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const commander = await newRoomPage(first, "rationale", false, true);
    const responder = await newRoomPage(second, "rationale");
    await join(commander, "Priya", "commander");
    await join(responder, "Arjun", "responder");
    const hypothesisId = await hypothesis(responder);
    const mitigationId = await mitigation(responder, hypothesisId, "rollback:deploy-1f3a");

    // A rationale explains a vote, so it needs a vote to explain. Otherwise
    // this is a general message channel rather than a narrow tool.
    const orphan = await callTool<ToolFailure>(responder, "explain_vote", {
      targetId: mitigationId,
      rationale: "Objecting before voting should not be possible.",
    });
    expect(orphan.error.code).toBe("no_vote");

    const missing = await callTool<ToolFailure>(responder, "explain_vote", {
      targetId: "h999",
      rationale: "There is no such target.",
    });
    expect(missing.error.code).toBe("not_found");

    // The objection the drill could not record: a no vote, with a reason.
    await callTool(responder, "vote", { targetId: mitigationId, choice: "no" });
    const hostile = '<img src=x onerror="window.__xssExecuted=1"> rollback leaves the pool at one';
    await commander.evaluate(() => { window.__xssExecuted = 0; });
    const recorded = await callTool<ToolData>(responder, "explain_vote", {
      targetId: mitigationId,
      rationale: hostile,
    });
    expect(recorded).toMatchObject({ kind: "rationale", targetId: mitigationId, count: 1 });

    // It reaches the other browser, and stays literal text there.
    const reasons = commander.getByTestId("vote-rationales");
    await expect(reasons).toBeVisible();
    await reasons.getByText("stated reason").click();
    await expect(commander.getByText(hostile)).toBeVisible();
    expect(await commander.locator('[data-testid="vote-rationales"] img').count()).toBe(0);
    expect(await commander.evaluate(() => window.__xssExecuted)).toBe(0);
    await expect(commander.getByTestId("vote-rationales")).toContainText("Arjun voted no");

    // One standing reason per member: explaining again replaces it.
    const replaced = await callTool<ToolData>(responder, "explain_vote", {
      targetId: mitigationId,
      rationale: "Rollback does not restore DB_POOL_MAX, so errors persist.",
    });
    expect(replaced).toMatchObject({ kind: "rationale", count: 1 });
    await expect(commander.getByTestId("vote-rationales")).toContainText("does not restore DB_POOL_MAX");
  } finally {
    await first.close();
    await second.close();
  }
});

test("rejects malformed input and enforces room and board limits", async () => {
  const url = `${harness.wsOrigin}/rooms/limits/ws?commander=test-commander-token`;
  const clients: RawClient[] = [];
  try {
    const unauthorized = await RawClient.connect(`${harness.wsOrigin}/rooms/unauthorized/ws`);
    clients.push(unauthorized);
    unauthorized.send({ type: "join", name: "Impostor", role: "commander" });
    expect(await unauthorized.next((message) => message.type === "error")).toMatchObject({
      type: "error",
      code: "commander_forbidden",
    });

    for (let index = 0; index < 7; index += 1) clients.push(await RawClient.connect(url));
    for (let index = 0; index < 6; index += 1) {
      clients[index + 1]!.send({ type: "join", name: `Responder ${index}`, role: index === 0 ? "commander" : "responder" });
      const joined = await clients[index + 1]!.next((message) => message.type === "joined");
      expect(joined.type).toBe("joined");
    }
    clients[7]!.send({ type: "join", name: "Overflow", role: "responder" });
    const roomFull = await clients[7]!.next((message) => message.type === "error");
    expect(roomFull).toMatchObject({ type: "error", code: "room_full" });

    const leader = clients[1]!;
    for (let index = 1; index <= 5; index += 1) {
      const proposal = {
        type: "propose_hypothesis",
        requestId: `h-${index}`,
        title: `Hypothesis ${index}`,
        evidence: "bounded evidence",
        confidence: 0.5,
      } as const;
      leader.send(proposal);
      await leader.next((message) => message.type === "tool_result" && message.requestId === `h-${index}`);
      if (index === 1) {
        leader.send(proposal);
        await leader.next((message) => message.type === "tool_result" && message.requestId === "h-1");
        leader.send({ ...proposal, title: "Different payload" });
        expect(await leader.next((message) => message.type === "error" && message.requestId === "h-1")).toMatchObject({
          type: "error",
          code: "request_id_reused",
        });
        leader.send({ type: "get_room_state", requestId: "state-after-replay" });
        const stateResult = await leader.next((message) => message.type === "tool_result" && message.requestId === "state-after-replay");
        expect(stateResult.type === "tool_result" && stateResult.data.kind === "room_state" && stateResult.data.state.hypotheses).toHaveLength(1);
      }
    }
    leader.send({
      type: "propose_hypothesis",
      requestId: "h-overflow",
      title: "Sixth hypothesis",
      evidence: "bounded evidence",
      confidence: 0.5,
    });
    expect(await leader.next((message) => message.type === "error" && message.requestId === "h-overflow")).toMatchObject({
      type: "error",
      code: "board_full",
    });

    const actions = ["scale_pool:default", "rollback:deploy-1f3a", "disable_flag:new-checkout"] as const;
    for (const [index, actionId] of actions.entries()) {
      leader.send({
        type: "propose_mitigation",
        requestId: `fix-${index}`,
        hypothesisId: "h1",
        actionId,
        blastRadius: "bounded impact",
      });
      await leader.next((message) => message.type === "tool_result" && message.requestId === `fix-${index}`);
    }
    leader.send({
      type: "propose_mitigation",
      requestId: "fix-overflow",
      hypothesisId: "h1",
      actionId: "scale_pool:default",
      blastRadius: "bounded impact",
    });
    expect(await leader.next((message) => message.type === "error" && message.requestId === "fix-overflow")).toMatchObject({
      type: "error",
      code: "board_full",
    });

    clients[7]!.send(JSON.stringify({ type: "join", name: "bad\u0000name", role: "responder" }));
    expect(await clients[7]!.next((message) => message.type === "error" && message.code === "invalid_request")).toBeTruthy();
    clients[7]!.send("x".repeat(8_193));
    expect(await clients[7]!.next((message) => message.type === "error" && message.code === "message_too_large")).toBeTruthy();
  } finally {
    for (const client of clients) client.close();
  }
});

test("suite is running in Chromium and covers the root test entrypoint", async ({ browserName }) => {
  expect(browserName).toBe("chromium");
  const rootPackage = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  expect(rootPackage.scripts?.test).toContain("test:e2e");
  expect(rootPackage.scripts?.["test:e2e"]).toContain("playwright test");
});

// --- Part 0 acceptance: several judges at once ------------------------------

// The most important test in the project. Before per-room tenancy, one judge
// applying scale_pool:default healed the target for every other judge, in rooms
// they had never opened, and concurrent evaluation was impossible.
test("resolving one room leaves another room's incident untouched", async ({ browser }) => {
  test.setTimeout(45_000);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const roomA = await provisionRoom();
    const roomB = await provisionRoom();
    expect(roomA).not.toBe(roomB);

    const judgeA = await newRoomPage(firstContext, roomA);
    const judgeB = await newRoomPage(secondContext, roomB);
    // No token anywhere: a provisioned room seats its first claimer.
    await join(judgeA, "Judge A", "commander");
    await join(judgeB, "Judge B", "commander");

    await expect.poll(() => errorRate(judgeA), { timeout: 10_000 }).toBeGreaterThan(5);
    await expect.poll(() => errorRate(judgeB), { timeout: 10_000 }).toBeGreaterThan(5);

    await resolveRoom(judgeA);
    await expect
      .poll(() => judgeA.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");
    expect(await errorRate(judgeA)).toBeLessThan(2);

    // Judge B never diagnosed anything, so their service must still be broken.
    expect(await errorRate(judgeB)).toBeGreaterThan(5);
    await expect(judgeB.getByTestId("room-phase")).not.toHaveText("Resolved");
    await expect(judgeB.getByTestId("hypotheses-list")).not.toContainText("Pool exhausted");

    // And B can still run their own incident to a real recovery afterwards.
    await resolveRoom(judgeB);
    await expect
      .poll(() => judgeB.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("a provisioned room seats its first commander and refuses the second", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const first = await newRoomPage(context, room);
    // No commander capability in this URL at all.
    await join(first, "Judge", "commander");

    const second = await newRoomPage(context, room);
    const stolen = await callTool<ToolFailure>(second, "join_room", {
      name: "Intruder",
      role: "commander",
    });
    expect(stolen.error.code).toBe("commander_taken");

    // A responder seat is still open, so a colleague can be pulled in.
    await join(second, "Colleague", "responder");
    await expect
      .poll(() => first.getByTestId("presence-summary").textContent())
      .toContain("2 people");
  } finally {
    await context.close();
  }
});

test("the curated room still demands the commander capability", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    // Self-serve is server state derived from the room id, so no query string
    // can turn the curated room into one. These are the names a judge or an
    // attacker would reach for.
    for (const roomName of [ROOM_ID, "judging-session"]) {
      expect(isMintedRoomId(roomName)).toBe(false);
      const page = await context.newPage();
      await openRoom(page, app.origin, roomName);
      const refused = await callTool<ToolFailure>(page, "join_room", {
        name: "Intruder",
        role: "commander",
      });
      expect(refused.error.code, roomName).toBe("commander_forbidden");
      // A responder seat is unaffected.
      await join(page, "Watcher", "responder");
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test("three judges run three rooms at once without interfering", async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const rooms = await Promise.all([provisionRoom(), provisionRoom(), provisionRoom()]);
    expect(new Set(rooms).size).toBe(3);
    const pages = await Promise.all(
      rooms.map((room, index) => newRoomPage(contexts[index]!, room)),
    );
    await Promise.all(pages.map((page, index) => join(page, `Judge ${index + 1}`, "commander")));

    // Each room is its own incident: nobody sees anybody else's board.
    for (const page of pages) {
      await expect(page.getByTestId("presence-summary")).toContainText("1 person");
      await expect.poll(() => errorRate(page), { timeout: 10_000 }).toBeGreaterThan(5);
    }

    await Promise.all(pages.map((page) => resolveRoom(page)));
    for (const page of pages) {
      await expect
        .poll(() => page.getByTestId("room-phase").textContent(), { timeout: 20_000 })
        .toBe("Resolved");
      await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("the lobby provisions an isolated room and opens it", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${app.origin}/`);
    await expect(page.getByTestId("lobby")).toBeVisible();
    await expect(page.getByTestId("start-own-incident")).toBeVisible();
    await expect(page.getByTestId("watch-live-demo")).toBeVisible();

    await page.getByTestId("start-own-incident").click();
    await page.waitForURL(/[?&]room=r[a-z2-7]{20}/, { timeout: 15_000 });
    const minted = new URL(page.url()).searchParams.get("room") ?? "";
    expect(minted).toMatch(MINTED_ROOM_ID_PATTERN);
    expect(harness.provisionedRooms()).toContain(minted);

    // The room code is visible so a judge can tell two sessions apart.
    await expect(page.getByTestId("room-code")).toContainText(minted.slice(1, 5).toUpperCase());
  } finally {
    await context.close();
  }
});

test("room provisioning is rate limited and room_full offers a way out", async ({ browser }) => {
  harness.setProvisionLimit(1);
  const first = await fetch(`${harness.httpOrigin}/rooms`, { method: "POST" });
  expect(first.ok).toBe(true);
  const limited = await fetch(`${harness.httpOrigin}/rooms`, { method: "POST" });
  expect(limited.status).toBe(429);
  const payload = (await limited.json()) as { error?: string; fallbackRoomId?: string };
  expect(payload.error).toBe("rate_limited");
  // A refused mint still points somewhere usable rather than dead-ending.
  expect(payload.fallbackRoomId).toBe(ROOM_ID);
  harness.setProvisionLimit(8);

  const context = await browser.newContext();
  const clients: RawClient[] = [];
  try {
    const url = `${harness.wsOrigin}/rooms/capacity/ws?commander=test-commander-token`;
    for (let index = 0; index < 6; index += 1) {
      const client = await RawClient.connect(url);
      clients.push(client);
      client.send({
        type: "join",
        name: `Responder ${index}`,
        role: index === 0 ? "commander" : "responder",
      });
      await client.next((message) => message.type === "joined");
    }

    const seventh = await newRoomPage(context, "capacity");
    const full = await callTool<ToolFailure>(seventh, "join_room", {
      name: "Seventh judge",
      role: "responder",
    });
    expect(full.error.code).toBe("room_full");
    await expect(seventh.getByTestId("notice")).toBeVisible();
    await expect(seventh.getByTestId("notice-action")).toHaveText("Start your own room");

    await seventh.getByTestId("notice-action").click();
    await seventh.waitForURL(/[?&]room=r[a-z2-7]{20}/, { timeout: 15_000 });
    await expect.poll(() => seventh.evaluate(() => Object.keys(window.__multicomTools ?? {}).length)).toBe(12);
    await join(seventh, "Seventh judge", "commander");
  } finally {
    for (const client of clients) client.close();
    await context.close();
  }
});

test("manual controls drive the same protocol and clear no gate", async ({ browser }) => {
  test.setTimeout(45_000);
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);

    // Tier 2: a judge whose browser has no agent takes the controls by hand.
    await page.getByTestId("drive-manually").click();
    await expect(page.getByTestId("manual-controls")).toBeVisible();

    // Nothing is writable before joining, exactly as for an agent.
    await expect(page.getByTestId("manual-propose-hypothesis")).toBeDisabled();

    await page.getByTestId("manual-name").fill("Manual judge");
    await page.getByTestId("manual-role").selectOption("commander");
    await page.getByTestId("manual-join").click();
    await expect(page.getByTestId("presence-summary")).toContainText("1 person");
    await expect(page.getByTestId("participation-tier")).toContainText("Driving it yourself");

    // Evidence first, through the same read-only tool an agent calls.
    await page.getByTestId("manual-check-id").selectOption("pool_in_use");
    await page.getByTestId("manual-run-check").click();
    // Assert on the result body, not the heading: the heading repeats the check
    // id, so matching the whole region would pass even on a failed call.
    await expect(page.locator('[data-testid="manual-output"] .mc-manual__line')).toContainText(
      '"inUse":1',
    );

    // Logs come back marked untrusted and stay literal text.
    await page.getByTestId("manual-query-logs").click();
    await expect(page.getByTestId("manual-output")).toContainText("Untrusted data");
    await expect(page.getByTestId("manual-output")).toContainText("SYSTEM-NOTE");
    expect(await page.locator('[data-testid="manual-output"] img').count()).toBe(0);

    await page.getByTestId("manual-title").fill("DB pool cut to one by deploy 1f3a");
    await page
      .getByTestId("manual-evidence")
      .fill("pool_in_use reports 1/1 and checkout waits at pool.acquire");
    await page.getByTestId("manual-propose-hypothesis").click();
    await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);

    await page.getByTestId("manual-action").selectOption("scale_pool:default");
    await page.getByTestId("manual-blast-radius").fill("Existing connections may reconnect once.");
    await page.getByTestId("manual-propose-mitigation").click();
    await expect(page.getByTestId("mitigation-card")).toHaveCount(1);

    // A manual apply before the vote is refused, like any other apply.
    await page.getByTestId("manual-apply-action").selectOption("scale_pool:default");
    await page.getByTestId("manual-apply").click();
    await expect(page.locator('[data-testid="manual-output"] .mc-manual__line')).toContainText(
      "not_passed",
    );

    await page.getByTestId("manual-vote-target").selectOption({ index: 1 });
    await page.getByTestId("manual-vote-yes").click();
    await expect(page.locator('[data-testid="manual-output"] .mc-manual__line')).toHaveText(
      "1 yes, 0 no — passed",
    );
    await page.getByTestId("manual-rationale").fill("deploy_diff shows DB_POOL_MAX went 50 to 1.");
    await page.getByTestId("manual-explain-vote").click();
    await expect(page.getByTestId("vote-rationales")).toBeVisible();

    // Still refused: a majority is not a human approval.
    await page.getByTestId("manual-apply").click();
    await expect(page.locator('[data-testid="manual-output"] .mc-manual__line')).toContainText(
      "needs_human_confirm",
    );

    await page.getByTestId("manual-request-confirm").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await expect(page.getByTestId("approval-action")).toHaveText("scale_pool:default");
    await page.getByTestId("approve-mitigation").click();

    await page.getByTestId("manual-apply").click();
    await expect
      .poll(() => page.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");

    // A resolved room is locked, so every manual write control is disabled —
    // the same `room_resolved` gate an agent hits.
    await expect(page.getByTestId("manual-apply")).toBeDisabled();
    await expect(page.getByTestId("manual-propose-hypothesis")).toBeDisabled();
    await expect(page.getByTestId("manual-request-confirm")).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("the judge console only ticks a row that really happened, and exports no secrets", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const responderContext = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await context.newPage();
    await installWebMcpCapture(page);
    await page.goto(`${app.origin}/?room=${room}&judge=1&commander=test-commander-token`);
    await waitForTools(page);
    await expect(page.getByTestId("judge-console")).toBeVisible();

    const unearned = [
      "challenged",
      "majority-vote",
      "human-approval",
      "single-use-approval",
      "verified-recovery",
    ];
    for (const id of unearned) {
      await expect(page.locator(`[data-rubric-id="${id}"]`), id).toHaveAttribute(
        "data-passed",
        "false",
      );
    }
    // The one row that can already be true is backed by a real observation.
    await expect(page.locator('[data-rubric-id="tool-surface"]')).toHaveAttribute(
      "data-passed",
      "true",
    );
    await expect(page.locator('[data-rubric-id="tool-surface"]')).toContainText("12 tools detected");

    await join(page, "Priya", "commander");
    const responder = await responderContext.newPage();
    await openRoom(responder, app.origin, room);
    await join(responder, "Arjun", "responder");

    await callTool(responder, "query_logs", { service: "storefront-api", window: "15m" });
    await callTool(responder, "run_check", { checkId: "pool_in_use" });
    // The commander reads the logs in their own browser too. Rows that depend
    // on seeing untrusted content only tick for the page that saw it, which is
    // the point: the console reports observations, not hearsay.
    const commanderLogs = await callTool<ToolData>(page, "query_logs", {
      service: "storefront-api",
      window: "15m",
    });
    expect(commanderLogs.lines).toContain(INJECTION_TRAP_LINE);
    const flag = await callTool<ToolData>(responder, "propose_hypothesis", {
      title: "The new-checkout flag caused the errors",
      evidence: "The flag changed this morning and checkout is failing.",
      confidence: 0.35,
    });
    await callTool(responder, "counter_hypothesis", {
      hypothesisId: flag.hypothesisId,
      evidence: "The error timeline starts before new-checkout was enabled.",
    });
    const real = await hypothesis(responder, "DB pool cut to one by deploy 1f3a");
    const fix = await mitigation(responder, real, "scale_pool:default");
    await callTool(responder, "vote", { targetId: fix, choice: "yes" });
    await callTool(page, "vote", { targetId: fix, choice: "yes" });
    await beginConfirmation(responder, fix);
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("approve-mitigation").click();
    await finishPending(responder);
    await callTool(responder, "apply_mitigation", { actionId: "scale_pool:default" });
    // The refused replay is what proves single-use approval, so it is exercised
    // twice: once by the agent that spent the approval, and once by the
    // commander, because the judge console only ticks what its own page saw.
    const replay = await callTool<ToolFailure>(responder, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(replay.error.code).toBe("needs_human_confirm");
    const commanderReplay = await callTool<ToolFailure>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(commanderReplay.error.code).toBe("needs_human_confirm");
    await expect
      .poll(() => page.getByTestId("room-phase").textContent(), { timeout: 15_000 })
      .toBe("Resolved");

    for (const id of [
      ...unearned,
      "multiplayer",
      "evidence-first",
      "red-herring",
      "injection",
      "tool-surface",
    ]) {
      await expect(page.locator(`[data-rubric-id="${id}"]`), id).toHaveAttribute(
        "data-passed",
        "true",
      );
    }
    await expect(page.getByTestId("judge-score")).toHaveText("10/10");
    await expect(page.getByTestId("run-summary")).toBeVisible();
    await expect(page.getByTestId("run-summary")).toContainText("Priya");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("download-run-report").click();
    const artefact = await downloadPromise;
    const exported = await readFile((await artefact.path()) ?? "", "utf8");
    const report = JSON.parse(exported) as {
      roomId: string;
      link: string;
      rubric: Array<{ id: string; passed: boolean; evidence: string | null }>;
    };
    expect(report.roomId).toBe(room);
    // No secret and no other room's data may leave in the artefact.
    expect(exported).not.toContain("test-commander-token");
    expect(exported).not.toContain("commander=");
    expect(report.link).not.toContain("commander");
    expect(exported).not.toContain(ROOM_ID);
    expect(report.rubric.every((entry) => !entry.passed || entry.evidence !== null)).toBe(true);
  } finally {
    await responderContext.close();
    await context.close();
  }
});

test("the hero visualization reaches WebGL, and the room works without it", async ({ browser }) => {
  test.setTimeout(45_000);
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await openRoom(page, app.origin, room);

    // The 2D field paints immediately, then the lazy 3D chunk takes over.
    await expect(page.getByTestId("hero-viz")).toHaveAttribute("data-viz", /canvas|webgl/);
    await expect
      .poll(() => page.getByTestId("hero-viz").getAttribute("data-viz"), { timeout: 20_000 })
      .toBe("webgl");
    // Asking one canvas for both a 2D and a WebGL context can never work, and
    // the failure is only a console line, so it is asserted rather than trusted.
    expect(errors.filter((text) => text.includes("WebGL"))).toEqual([]);

    // With the 3D chunk unreachable, the incident is still fully workable.
    const offline = await context.newPage();
    await offline.route(/three/, (route) => route.abort());
    await openRoom(offline, app.origin, room);
    await expect(offline.getByTestId("hero-viz")).toHaveAttribute("data-viz", "canvas");
    await join(offline, "No-WebGL judge", "responder");
    const posted = await callTool<ToolData>(offline, "propose_hypothesis", {
      title: "The room works without the 3D layer",
      evidence: "This page never loaded the visualization chunk.",
      confidence: 0.5,
    });
    expect(posted.kind).toBe("hypothesis");
    await expect(offline.getByTestId("hypothesis-card")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("a reduced-motion visitor gets the quiet interface and the same board", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await expect(page.locator(".mc-war-room")).toHaveAttribute("data-motion", "reduced");
    await join(page, "Quiet judge", "commander");
    await callTool(page, "propose_hypothesis", {
      title: "Reduced motion changes nothing about the protocol",
      evidence: "The same board renders with animation disabled.",
      confidence: 0.5,
    });
    await expect(page.getByTestId("hypothesis-card")).toHaveCount(1);
    await expect(page.getByTestId("dashboard")).toBeVisible();
  } finally {
    await context.close();
  }
});

// Self-serve rooms let a visitor claim the commander seat with no secret, which
// is what makes the human-approval gate demonstrable by a judge. It also means
// an agent can hold that seat, so the gate must be "a human clicked Approve",
// not "this session holds the seat". Nothing in this test involves a second
// participant: one browser, one agent, no human until the final click.
test("an agent holding the commander seat still cannot approve its own write", async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await join(page, "Solo agent", "commander");
    const hypothesisId = await hypothesis(page);
    const mitigationId = await mitigation(page, hypothesisId, "scale_pool:default");
    await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });

    // A majority of one is a majority, and still not a human decision.
    const beforeRequest = await callTool<ToolFailure>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(beforeRequest.error.code).toBe("needs_human_confirm");

    // Asking for approval does not grant it, even to the seat holder.
    await beginConfirmation(page, mitigationId);
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    const whilePending = await callTool<ToolFailure>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(whilePending.error.code).toBe("needs_human_confirm");

    // Exercise every other tool on the surface while the dialog is open. None of
    // them can answer a confirmation: the room writes an approval in exactly one
    // place, and only the `confirm` message the Approve button sends gets there.
    const probes: Record<string, unknown> = {
      join_room: { name: "Solo agent", role: "commander" },
      get_room_state: {},
      get_service_status: {},
      query_logs: { service: "storefront-api", window: "15m" },
      run_check: { checkId: "pool_in_use" },
      propose_hypothesis: {
        title: "Probing the approval gate",
        evidence: "Trying every tool while a confirmation is pending.",
        confidence: 0.1,
      },
      counter_hypothesis: { hypothesisId, evidence: "Probing the approval gate." },
      propose_mitigation: {
        hypothesisId,
        actionId: "rollback:deploy-1f3a",
        blastRadius: "Probing the approval gate.",
      },
      vote: { targetId: mitigationId, choice: "yes" },
      explain_vote: { targetId: mitigationId, rationale: "Probing the approval gate." },
      request_human_confirm: { mitigationId },
    };
    for (const name of TOOL_NAMES) {
      if (name === "apply_mitigation") continue;
      // Results are deliberately ignored: the assertion is that none of these
      // can move the gate, whether they succeed or are refused.
      await callTool(page, name, probes[name] ?? {});
    }
    const afterEveryTool = await callTool<ToolFailure>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(afterEveryTool.error.code).toBe("needs_human_confirm");

    // The only thing that moves it is a human click in the browser interface.
    await page.getByTestId("approve-mitigation").click();
    expect(await finishPending<ToolData>(page)).toMatchObject({
      kind: "confirm",
      approved: true,
      reason: "granted",
    });
    const applied = await callTool<ToolData>(page, "apply_mitigation", {
      actionId: "scale_pool:default",
    });
    expect(applied).toMatchObject({ kind: "apply", applied: true });

    // And the surface has no confirm-capable tool to reach for in the first
    // place: `request_human_confirm` asks, and nothing on the surface answers.
    const definitions = await readFile(resolve("web/tools/tool-definitions.ts"), "utf8");
    expect(definitions).not.toMatch(/client\.confirm\b/);
    const registered = await page.evaluate(() => Object.keys(window.__multicomTools ?? {}));
    expect(registered).toEqual([...TOOL_NAMES]);
  } finally {
    await context.close();
  }
});

// The palette is only accessible if the cascade actually delivers it. A
// `.mc-war-room button { color: inherit }` reset once out-specified every
// `.mc-button--*` variant, so the primary and approve buttons rendered light
// text on their light fills at 1.98:1 and nothing caught it.
test("text on the key controls clears the WCAG AA contrast floor", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const page = await newRoomPage(context, room);
    await page.getByTestId("drive-manually").click();
    await join(page, "Contrast judge", "commander");
    const hypothesisId = await hypothesis(page);
    const mitigationId = await mitigation(page, hypothesisId, "scale_pool:default");
    await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });
    await beginConfirmation(page, mitigationId);
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();

    const measured = await page.evaluate(() => {
      const parse = (value: string): [number, number, number, number] => {
        const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const channel = (value: number): number => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: [number, number, number, number]): number =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const over = (
        top: [number, number, number, number],
        bottom: [number, number, number, number],
      ): [number, number, number, number] => [
        top[0] * top[3] + bottom[0] * (1 - top[3]),
        top[1] * top[3] + bottom[1] * (1 - top[3]),
        top[2] * top[3] + bottom[2] * (1 - top[3]),
        1,
      ];

      /** The painted background behind an element, compositing transparency. */
      const background = (node: Element): [number, number, number, number] => {
        const stack: Array<[number, number, number, number]> = [];
        let current: Element | null = node;
        while (current) {
          const colour = parse(getComputedStyle(current).backgroundColor);
          if (colour[3] > 0) stack.push(colour);
          if (colour[3] >= 1) break;
          current = current.parentElement;
        }
        return stack.reduceRight<[number, number, number, number]>(
          (below, above) => over(above, below),
          [0, 0, 0, 1],
        );
      };

      const targets = [
        ".mc-button--primary",
        ".mc-button--approve",
        ".mc-button--secondary",
        ".mc-button--ghost",
        ".mc-button--vote",
        ".mc-icon-button",
        ".mc-gauge__value",
        ".mc-stat__value",
        ".mc-card__title",
        ".mc-evidence__text",
        ".mc-rubric__label",
        ".mc-approval__title",
        ".mc-approval__action-id",
        ".mc-field__label",
        ".mc-presence__role",
      ];

      return targets.flatMap((selector) => {
        const node = document.querySelector(selector);
        if (!node) return [{ selector, ratio: 0, required: 4.5, missing: true }];
        const style = getComputedStyle(node);
        const foreground = over(parse(style.color), background(node));
        const light = Math.max(luminance(foreground), luminance(background(node)));
        const dark = Math.min(luminance(foreground), luminance(background(node)));
        const ratio = (light + 0.05) / (dark + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        // WCAG 1.4.3: large text is 24px, or 18.66px when bold.
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        return [{ selector, ratio, required: large ? 3 : 4.5, missing: false }];
      });
    });

    expect(measured.filter((entry) => entry.missing)).toEqual([]);
    const failing = measured.filter((entry) => entry.ratio < entry.required);
    expect(
      failing.map((entry) => `${entry.selector} ${entry.ratio.toFixed(2)}:1 < ${entry.required}:1`),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

// A room with responders and no commander cannot be completed, and two real
// agents walked into exactly that because `role` was undocumented. The refusal
// now names the remedy rather than only the requirement.
test("a room with no commander refuses approval and says how to fix it", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const room = await provisionRoom();
    const first = await newRoomPage(context, room);
    const second = await newRoomPage(context, room);
    // Both take the cautious seat, which is what the agents did.
    await join(first, "Dev", "responder");
    await join(second, "Sam", "responder");

    const hypothesisId = await hypothesis(first);
    const mitigationId = await mitigation(first, hypothesisId, "scale_pool:default");
    await callTool(first, "vote", { targetId: mitigationId, choice: "yes" });
    await callTool(second, "vote", { targetId: mitigationId, choice: "yes" });

    const refused = await callTool<ToolFailure>(first, "request_human_confirm", { mitigationId });
    expect(refused.error.code).toBe("commander_unavailable");
    // The remedy, not just the requirement: an agent reading this knows what to do.
    expect(refused.error.message).toContain("role commander");

    // And the deadlock is escapable without restarting: one of them takes the
    // seat, and the same request now reaches a human.
    const third = await newRoomPage(context, room);
    await join(third, "Priya", "commander");
    await beginConfirmation(first, mitigationId);
    await expect(third.getByTestId("confirm-dialog")).toBeVisible();
    await third.getByTestId("approve-mitigation").click();
    expect(await finishPending<ToolData>(first)).toMatchObject({ approved: true });
  } finally {
    await context.close();
  }
});
