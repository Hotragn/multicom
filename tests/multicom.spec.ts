import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { INJECTION_TRAP_LINE } from "../shared/scenario";
import { TOOL_NAMES } from "../shared/tools";
import { callTool, openRoom } from "./support/page-tools";
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
    const appeared = commander.waitForFunction(
      (text) => Array.from(document.querySelectorAll('[data-testid="hypothesis-card"]'))
        .some((node) => node.textContent?.includes(text)),
      hostile,
    );
    const started = performance.now();
    await hypothesis(responder, hostile);
    await appeared;
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(300);
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
    await expect.poll(async () => page.locator(".mc-member-summary").textContent(), { timeout: 3_000 }).toContain("2 people");
    expect(performance.now() - started).toBeLessThan(3_000);

    const redHerring = page.locator('[data-testid="hypothesis-card"]', { hasText: "new-checkout flag caused" });
    await expect(redHerring).toBeVisible({ timeout: 10_000 });
    expect(performance.now() - started).toBeLessThan(10_000);
    await callTool(page, "run_check", { checkId: "error_timeline" });
    await expect(redHerring).toContainText("Challenged");
    await expect(redHerring).toContainText("timeline starts before new-checkout");
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

    await expect(page.getByTestId("spectator-banner")).toBeVisible();
    await expect(page.getByTestId("spectator-banner")).toContainText("ask it to join");

    // The service metrics are live rather than placeholder dashes.
    await expect
      .poll(async () => {
        const text = await page.getByTestId("error-rate").textContent();
        return Number.parseFloat(text ?? "NaN");
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // The house responder joins and argues on its own, so the board is not empty.
    await expect.poll(async () => page.locator(".mc-member-summary").textContent(), { timeout: 5_000 })
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
    await expect.poll(async () => page.locator(".mc-member-summary").textContent()).toContain("2 people");
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
    const hypothesisId = await hypothesis(page);
    const mitigationId = await mitigation(page, hypothesisId, "scale_pool:default");
    await callTool(page, "vote", { targetId: mitigationId, choice: "yes" });
    await beginConfirmation(page, mitigationId);
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("approve-mitigation").click();
    await finishPending(page);
    await callTool(page, "apply_mitigation", { actionId: "scale_pool:default" });
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
