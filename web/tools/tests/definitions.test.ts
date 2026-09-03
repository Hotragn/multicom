import assert from "node:assert/strict";
import test from "node:test";
import { INJECTION_TRAP_LINE } from "../../../shared/scenario.ts";
import {
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
} from "../../../shared/tools.ts";
import type { RoomState } from "../../../shared/ws-messages.ts";
import {
  assertWithinToolResultBudget,
  budgetToolResult,
  utf8JsonSize,
} from "../result-budget.ts";
import { RoomClient } from "../room-client.ts";
import { createToolDefinitions, TOOL_INPUT_SCHEMAS } from "../tool-definitions.ts";
import { FakeSocket } from "./fake-socket.ts";

function unusedClient(): RoomClient {
  return new RoomClient({
    url: "ws://example.test/rooms/p1-storefront/ws",
    socketFactory: () => new FakeSocket(),
    autoReconnect: false,
  });
}

test("registers exactly the 12-tool definition set", () => {
  const definitions = createToolDefinitions(unusedClient());
  assert.deepEqual(definitions.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.equal(new Set(definitions.map((tool) => tool.name)).size, 12);

  for (const tool of definitions) {
    assert.equal(tool.description, TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS]);
    assert.ok(tool.description.length > 0);
    assert.ok([...tool.description].length < 120, `${tool.name} description is too long`);
    const expectedAnnotations =
      tool.name === "join_room"
        ? { untrustedContentHint: true }
        : TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS];
    assert.deepEqual(tool.annotations, expectedAnnotations);
  }
});

test("schemas are closed and encode fixed enums and ranges", () => {
  for (const schema of Object.values(TOOL_INPUT_SCHEMAS)) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
  }

  const queryProperties = TOOL_INPUT_SCHEMAS.query_logs.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(queryProperties.service?.const, "storefront-api");
  assert.deepEqual(queryProperties.window?.enum, ["5m", "15m", "1h"]);

  const confidence = (
    TOOL_INPUT_SCHEMAS.propose_hypothesis.properties as Record<
      string,
      Record<string, unknown>
    >
  ).confidence;
  assert.equal(confidence?.minimum, 0);
  assert.equal(confidence?.maximum, 1);
});

test("invalid action input fails safely without opening a socket", async () => {
  const client = unusedClient();
  const apply = createToolDefinitions(client).find((tool) => tool.name === "apply_mitigation");
  assert.ok(apply);
  const result = await apply.execute({ actionId: "delete:production" });
  assert.deepEqual(result, {
    error: {
      code: "unknown_action",
      message:
        "actionId must be one of: scale_pool:default, rollback:deploy-1f3a, disable_flag:new-checkout.",
    },
  });
});

test("log evidence stays unchanged and below the UTF-8 budget", () => {
  const result = budgetToolResult({
    kind: "logs",
    lines: [INJECTION_TRAP_LINE],
    untrustedContentHint: true,
  });
  assert.deepEqual(result, {
    kind: "logs",
    lines: [INJECTION_TRAP_LINE],
    untrustedContentHint: true,
  });
  assertWithinToolResultBudget(result);
});

test("large room state is deterministically compacted below 2 KB", () => {
  const state: RoomState = {
    id: "p1-storefront",
    phase: "diagnosing",
    incidentStartedAt: 1_788_358_682,
    resolvedAt: null,
    members: Array.from({ length: 6 }, (_, index) => ({
      id: `member-${index}`,
      name: `Responder ${index} ${"界".repeat(48)}`,
      role: index === 0 ? "commander" : "responder",
      agentActive: true,
    })),
    hypotheses: Array.from({ length: 5 }, (_, index) => ({
      id: `h${index}`,
      by: `member-${index}`,
      title: `Pool hypothesis ${"界".repeat(120)}`,
      evidence: `Evidence ${"界".repeat(600)}`,
      confidence: 0.8,
      rebuttals: [{ by: "member-5", evidence: `Counter ${"界".repeat(600)}` }],
      votes: Object.fromEntries(
        Array.from({ length: 6 }, (_entry, voteIndex) => [`member-${voteIndex}`, "yes"]),
      ),
      rationales: Object.fromEntries(
        Array.from({ length: 6 }, (_entry, voteIndex) => [
          `member-${voteIndex}`,
          `Because ${"界".repeat(240)}`,
        ]),
      ),
    })),
    mitigations: Array.from({ length: 3 }, (_, index) => ({
      id: `mitigation-${index}`,
      hypothesisId: `h${index}`,
      actionId: "scale_pool:default",
      blastRadius: `Reconnect ${"界".repeat(180)}`,
      votes: { "member-0": "yes" },
      rationales: { "member-0": `Objecting because ${"界".repeat(240)}` },
      passed: true,
    })),
    appliedActions: [],
    log: Array.from({ length: 20 }, (_, index) => ({
      t: 1_788_358_682 + index,
      text: `Activity ${"界".repeat(200)}`,
    })),
  };

  const first = budgetToolResult({ kind: "room_state", state });
  const second = budgetToolResult({ kind: "room_state", state });
  assert.deepEqual(first, second);
  assert.equal((first as { truncated?: boolean }).truncated, true);
  assert.ok(utf8JsonSize(first) < 2_048, `result was ${utf8JsonSize(first)} bytes`);
});
