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

export const TOOL_INPUT_SCHEMAS: Record<ToolName, JsonSchema> = {
  join_room: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: TOOL_INPUT_LIMITS.name },
      role: { type: "string", enum: ["commander", "responder"] },
    },
    required: ["name", "role"],
    additionalProperties: false,
  },
  get_room_state: EMPTY_OBJECT_SCHEMA,
  get_service_status: EMPTY_OBJECT_SCHEMA,
  query_logs: {
    type: "object",
    properties: {
      service: { type: "string", const: SERVICE_NAME },
      window: { type: "string", enum: ["5m", "15m", "1h"] },
      filter: { type: "string", minLength: 1, maxLength: TOOL_INPUT_LIMITS.filter },
    },
    required: ["service", "window"],
    additionalProperties: false,
  },
  run_check: {
    type: "object",
    properties: {
      checkId: { type: "string", enum: [...CHECK_IDS] },
    },
    required: ["checkId"],
    additionalProperties: false,
  },
  propose_hypothesis: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: TOOL_INPUT_LIMITS.title },
      evidence: { type: "string", minLength: 1, maxLength: TOOL_INPUT_LIMITS.evidence },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["title", "evidence", "confidence"],
    additionalProperties: false,
  },
  counter_hypothesis: {
    type: "object",
    properties: {
      hypothesisId: ID_SCHEMA,
      evidence: { type: "string", minLength: 1, maxLength: TOOL_INPUT_LIMITS.evidence },
    },
    required: ["hypothesisId", "evidence"],
    additionalProperties: false,
  },
  propose_mitigation: {
    type: "object",
    properties: {
      hypothesisId: ID_SCHEMA,
      actionId: { type: "string", enum: [...ACTION_LIBRARY] },
      blastRadius: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.blastRadius,
      },
    },
    required: ["hypothesisId", "actionId", "blastRadius"],
    additionalProperties: false,
  },
  vote: {
    type: "object",
    properties: {
      targetId: ID_SCHEMA,
      choice: { type: "string", enum: ["yes", "no"] },
    },
    required: ["targetId", "choice"],
    additionalProperties: false,
  },
  explain_vote: {
    type: "object",
    properties: {
      targetId: ID_SCHEMA,
      rationale: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_INPUT_LIMITS.rationale,
      },
    },
    required: ["targetId", "rationale"],
    additionalProperties: false,
  },
  request_human_confirm: {
    type: "object",
    properties: { mitigationId: ID_SCHEMA },
    required: ["mitigationId"],
    additionalProperties: false,
  },
  apply_mitigation: {
    type: "object",
    properties: {
      actionId: { type: "string", enum: [...ACTION_LIBRARY] },
    },
    required: ["actionId"],
    additionalProperties: false,
  },
};

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
      ...(annotations ? { annotations } : {}),
      execute: (input) => executeTool(client, name, input),
    };
  });
}
