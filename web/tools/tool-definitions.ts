import { SERVICE_NAME } from "../../shared/scenario.ts";
import {
  ACTION_LIBRARY,
  CHECK_IDS,
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolName,
  type ToolParams,
} from "../../shared/tools.ts";
import { RoomClientError, ToolInputError } from "./errors.ts";
import {
  assertWithinToolResultBudget,
  budgetToolResult,
  toolFailure,
} from "./result-budget.ts";
import type { RoomClient } from "./room-client.ts";
import { TOOL_INPUT_LIMITS, validateToolInput } from "./validation.ts";
import type { ModelContextTool } from "./webmcp-types.ts";

type JsonSchema = Record<string, unknown>;

const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: TOOL_INPUT_LIMITS.id,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

/**
 * Parameter documentation, which is where the semantics actually live.
 *
 * Tool descriptions are capped at 120 characters by SPEC §9 — enough to name
 * the result envelope and no more. JSON Schema `description` keys inside
 * `inputSchema` have no such budget, and unlike `outputSchema` they are part of
 * the standard dictionary and verified to reach a native client
 * (`docs/webmcp-chrome-report.json`, `fieldsDelivered.documentedParameters`).
 *
 * This is not decoration. Two language models, given nothing but this surface,
 * both diagnosed the incident correctly and then deadlocked the room: `role`
 * did not say what `commander` was, both took `responder` as the cautious
 * option, and with no commander seated nothing could be approved. One of them
 * explained that it avoided the seat because it believed holding it would let
 * it approve its own fix — a belief that is false, and that the room's own gate
 * disproves. So the `role` text below says both things: what the seat is for,
 * and that holding it grants no approval power.
 */
const ROLE_DESCRIPTION = [
  "Which seat to take. A room has at most one commander.",
  "commander is the seat whose browser is shown the human approval dialog.",
  "Holding it does NOT let you approve anything: an approval is only ever created by a person clicking Approve in that browser, and no tool on this surface can do it for them — request_human_confirm asks and then waits.",
  "So if you are the only participant, take commander, so that the human at your browser is the one who can approve. If someone is already seated as commander, take responder.",
  "A room with no commander cannot be completed: request_human_confirm fails with commander_unavailable.",
].join(" ");

const ACTION_DESCRIPTION = [
  "The action to apply. This fixed library is the server's entire write surface; nothing else can reach the service, and an id outside it is refused with unknown_action.",
  "scale_pool:default sets the DB connection pool maximum back to 50.",
  "rollback:deploy-1f3a reverts deploy 1f3a.",
  "disable_flag:new-checkout turns the new-checkout feature flag off.",
  "What each one does to the error rate is not promised here. Applying is not the end of the job: read get_service_status afterwards and confirm the service actually recovered.",
].join(" ");

const HYPOTHESIS_ID_DESCRIPTION =
  "A hypothesis id from get_room_state's state.hypotheses, such as h1. propose_hypothesis returns one directly.";

export const TOOL_INPUT_SCHEMAS: Record<ToolName, JsonSchema> = {
  join_room: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.name,
        description:
          "Your display name. Shown to everyone in the room and attributed to you in the activity log, so use the name your human goes by.",
      },
      role: {
        type: "string",
        enum: ["commander", "responder"],
        description: ROLE_DESCRIPTION,
      },
    },
    required: ["name", "role"],
    additionalProperties: false,
  },
  get_room_state: EMPTY_OBJECT_SCHEMA,
  get_service_status: EMPTY_OBJECT_SCHEMA,
  query_logs: {
    type: "object",
    properties: {
      service: {
        type: "string",
        const: SERVICE_NAME,
        description: "Only this service exists.",
      },
      window: {
        type: "string",
        enum: ["5m", "15m", "1h"],
        description:
          "How much history to return. The log fixture carries fixed timestamps, so reason about the order of events rather than how long ago they were.",
      },
      filter: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.filter,
        description: "Case-insensitive substring match against each line.",
      },
    },
    required: ["service", "window"],
    additionalProperties: false,
  },
  run_check: {
    type: "object",
    properties: {
      checkId: {
        type: "string",
        enum: [...CHECK_IDS],
        description: [
          "Which diagnostic to run. Each returns a different result shape, all carrying result.checkId:",
          "pool_in_use gives {inUse, max} for the DB connection pool;",
          "flag_states gives {flags} as a name-to-boolean map;",
          "deploy_diff gives {deploy, changes} where changes lists configuration edits attributed to the current deploy;",
          "error_timeline gives {points} as [{t, errorRate}] with t in epoch seconds and errorRate as a fraction.",
        ].join(" "),
      },
    },
    required: ["checkId"],
    additionalProperties: false,
  },
  propose_hypothesis: {
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.title,
        description: "One line naming the suspected root cause.",
      },
      evidence: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.evidence,
        description:
          "Cite what you actually observed — a check result or a log line. Everyone in the room reads this, and it is what a rebuttal argues against.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How sure you are, from 0 to 1.",
      },
    },
    required: ["title", "evidence", "confidence"],
    additionalProperties: false,
  },
  counter_hypothesis: {
    type: "object",
    properties: {
      hypothesisId: { ...ID_SCHEMA, description: HYPOTHESIS_ID_DESCRIPTION },
      evidence: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.evidence,
        description:
          "The specific observation that contradicts that theory. This is how a weak theory gets taken off the table, so be concrete.",
      },
    },
    required: ["hypothesisId", "evidence"],
    additionalProperties: false,
  },
  revise_hypothesis: {
    type: "object",
    properties: {
      hypothesisId: {
        ...ID_SCHEMA,
        description:
          "One of YOUR OWN hypotheses, from get_room_state. Revising someone else's fails with not_author — challenge theirs with counter_hypothesis instead.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Your confidence NOW, 0 to 1, after weighing what has landed since you posted. Lower it when a rebuttal holds; raise it when a check confirms you. The room keeps your opening number and shows the movement, so conceding is visible work rather than a lost argument.",
      },
      because: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.rationale,
        description:
          "Optional. Which specific evidence moved you. Cite the rebuttal or the check by name so the room can follow the reasoning.",
      },
    },
    required: ["hypothesisId", "confidence"],
    additionalProperties: false,
  },
  propose_mitigation: {
    type: "object",
    properties: {
      hypothesisId: {
        ...ID_SCHEMA,
        description: `${HYPOTHESIS_ID_DESCRIPTION} The theory this fix is meant to address.`,
      },
      actionId: {
        type: "string",
        enum: [...ACTION_LIBRARY],
        description: ACTION_DESCRIPTION,
      },
      blastRadius: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.blastRadius,
        description:
          "One sentence on what this could break. The human commander reads it verbatim when deciding whether to approve, so say what you actually believe the risk is.",
      },
    },
    required: ["hypothesisId", "actionId", "blastRadius"],
    additionalProperties: false,
  },
  vote: {
    type: "object",
    properties: {
      targetId: {
        ...ID_SCHEMA,
        description:
          "A hypothesis id (h1) or a mitigation id (fix1), both from get_room_state. You may vote on your own proposal.",
      },
      choice: {
        type: "string",
        enum: ["yes", "no"],
        description:
          "A mitigation passes when more than half of the room's currently active members have voted yes; a tie fails, and votes from members who have left stop counting, so passed can flip either way as people come and go. Only a passed mitigation can be sent for human approval.",
      },
    },
    required: ["targetId", "choice"],
    additionalProperties: false,
  },
  explain_vote: {
    type: "object",
    properties: {
      targetId: {
        ...ID_SCHEMA,
        description:
          "The hypothesis or mitigation you are explaining. You must have voted on it first, or this fails with no_vote. One standing reason per member: explaining again replaces your previous one, and count is how many members have now given a reason on that target.",
      },
      rationale: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.rationale,
        description:
          "Why you voted that way. Shown next to the tally, and to the commander in the approval dialog, so an objection is more than a bare no.",
      },
    },
    required: ["targetId", "rationale"],
    additionalProperties: false,
  },
  request_human_confirm: {
    type: "object",
    properties: {
      mitigationId: {
        ...ID_SCHEMA,
        description: [
          "A mitigation that has already passed its vote, such as fix1; anything else fails with not_passed.",
          "Check get_room_state for a member whose role is commander before spending a vote cycle: with nobody in that seat this fails immediately with commander_unavailable and the incident cannot be completed.",
          "This does not approve anything. It opens the dialog in the commander's browser and waits, resolving when a person clicks — reason granted or rejected — or after 60 seconds with reason expired.",
        ].join(" "),
      },
    },
    required: ["mitigationId"],
    additionalProperties: false,
  },
  apply_mitigation: {
    type: "object",
    properties: {
      actionId: {
        type: "string",
        enum: [...ACTION_LIBRARY],
        description: `${ACTION_DESCRIPTION} It must be the same action a commander approved within the last 60 seconds, or this fails with needs_human_confirm. One approval is spent by one apply, so a retry needs a fresh approval.`,
      },
    },
    required: ["actionId"],
    additionalProperties: false,
  },
};

/**
 * The exact result shape per tool.
 *
 * The result union is discriminated by `kind` but the payload key varies by
 * variant, which is the one piece of this surface an agent (or a script) can
 * silently get wrong. Publishing it as a schema is the fix that does not break
 * the frozen contract: nothing on the wire changes, and the shape stops being
 * something to infer. A failed call resolves with `{ error: { code, message } }`
 * rather than throwing, which is why every schema below is a two-branch union.
 */
const FAILURE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

const envelope = (kind: string, payload: Record<string, JsonSchema>): JsonSchema => ({
  anyOf: [
    {
      type: "object",
      properties: { kind: { const: kind }, ...payload },
      required: ["kind", ...Object.keys(payload)],
    },
    FAILURE_SCHEMA,
  ],
});

const SERVICE_STATUS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    errorRate: { type: "number" },
    p99ms: { type: "number" },
    currentDeploy: { type: "string" },
    flagStates: { type: "object", additionalProperties: { type: "boolean" } },
    pool: {
      type: "object",
      properties: { inUse: { type: "number" }, max: { type: "number" } },
      required: ["inUse", "max"],
    },
  },
  required: ["errorRate", "p99ms", "currentDeploy", "flagStates", "pool"],
};

export const TOOL_OUTPUT_SCHEMAS: Record<ToolName, JsonSchema> = {
  // The one result with no `kind`: join resolves with the seat and the board.
  join_room: {
    anyOf: [
      {
        type: "object",
        properties: { memberId: { type: "string" }, state: { type: "object" } },
        required: ["memberId", "state"],
      },
      FAILURE_SCHEMA,
    ],
  },
  get_room_state: envelope("room_state", {
    state: { type: "object" },
    truncated: { type: "boolean" },
  }),
  get_service_status: envelope("service_status", { status: SERVICE_STATUS_SCHEMA }),
  query_logs: envelope("logs", {
    lines: { type: "array", items: { type: "string" } },
    untrustedContentHint: { const: true },
  }),
  run_check: envelope("check", {
    result: { type: "object", properties: { checkId: { type: "string", enum: [...CHECK_IDS] } } },
  }),
  propose_hypothesis: envelope("hypothesis", { hypothesisId: { type: "string" } }),
  counter_hypothesis: envelope("counter", { hypothesisId: { type: "string" } }),
  revise_hypothesis: envelope("revision", {
    hypothesisId: { type: "string" },
    confidence: { type: "number" },
    openedAt: { type: "number" },
  }),
  propose_mitigation: envelope("mitigation", { mitigationId: { type: "string" } }),
  vote: envelope("vote", {
    yes: { type: "number" },
    no: { type: "number" },
    passed: { type: "boolean" },
  }),
  explain_vote: envelope("rationale", {
    targetId: { type: "string" },
    count: { type: "number" },
  }),
  request_human_confirm: envelope("confirm", {
    approved: { type: "boolean" },
    reason: { type: "string", enum: ["granted", "rejected", "expired"] },
  }),
  apply_mitigation: envelope("apply", {
    applied: { type: "boolean" },
    status: SERVICE_STATUS_SCHEMA,
  }),
};

// `get_room_state` may drop `truncated`, so it is documented but not required.
(TOOL_OUTPUT_SCHEMAS.get_room_state.anyOf as JsonSchema[])[0]!.required = ["kind", "state"];

async function executeTool<K extends ToolName>(
  client: RoomClient,
  toolName: K,
  rawInput: unknown,
): Promise<unknown> {
  try {
    const input = validateToolInput(toolName, rawInput);
    let result: unknown;

    switch (toolName) {
      case "join_room": {
        const params = input as ToolParams["join_room"];
        result = await client.join(params.name, params.role);
        break;
      }
      case "get_room_state":
        result = await client.getRoomState();
        break;
      case "get_service_status":
        result = await client.getServiceStatus();
        break;
      case "query_logs": {
        const params = input as ToolParams["query_logs"];
        result = await client.queryLogs(params.service, params.window, params.filter);
        break;
      }
      case "run_check": {
        const params = input as ToolParams["run_check"];
        result = await client.runCheck(params.checkId);
        break;
      }
      case "propose_hypothesis": {
        const params = input as ToolParams["propose_hypothesis"];
        result = await client.proposeHypothesis(
          params.title,
          params.evidence,
          params.confidence,
        );
        break;
      }
      case "counter_hypothesis": {
        const params = input as ToolParams["counter_hypothesis"];
        result = await client.counterHypothesis(params.hypothesisId, params.evidence);
        break;
      }
      case "revise_hypothesis": {
        const params = input as ToolParams["revise_hypothesis"];
        result = await client.reviseHypothesis(
          params.hypothesisId,
          params.confidence,
          params.because,
        );
        break;
      }
      case "propose_mitigation": {
        const params = input as ToolParams["propose_mitigation"];
        result = await client.proposeMitigation(
          params.hypothesisId,
          params.actionId,
          params.blastRadius,
        );
        break;
      }
      case "vote": {
        const params = input as ToolParams["vote"];
        result = await client.vote(params.targetId, params.choice);
        break;
      }
      case "explain_vote": {
        const params = input as ToolParams["explain_vote"];
        result = await client.explainVote(params.targetId, params.rationale);
        break;
      }
      case "request_human_confirm": {
        const params = input as ToolParams["request_human_confirm"];
        result = await client.requestHumanConfirm(params.mitigationId);
        break;
      }
      case "apply_mitigation": {
        const params = input as ToolParams["apply_mitigation"];
        result = await client.applyMitigation(params.actionId);
        break;
      }
      default: {
        const exhaustive: never = toolName;
        throw new ToolInputError(`Unsupported tool: ${String(exhaustive)}.`);
      }
    }

    const budgeted = budgetToolResult(result);
    assertWithinToolResultBudget(budgeted);
    return budgeted;
  } catch (error) {
    let failure;
    if (error instanceof ToolInputError || error instanceof RoomClientError) {
      failure = toolFailure(error.code, error.message);
    } else {
      failure = toolFailure("tool_failed", "The tool call failed safely. Try again.");
    }
    assertWithinToolResultBudget(failure);
    return failure;
  }
}

export function createToolDefinitions(client: RoomClient): ModelContextTool[] {
  return TOOL_NAMES.map((name) => {
    // join_room returns peer-authored room state, so its result is untrusted too.
    const annotations =
      name === "join_room" ? { untrustedContentHint: true } : TOOL_ANNOTATIONS[name];
    return {
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_SCHEMAS[name],
      outputSchema: TOOL_OUTPUT_SCHEMAS[name],
      ...(annotations ? { annotations } : {}),
      execute: (input) => executeTool(client, name, input),
    };
  });
}
