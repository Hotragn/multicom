import {
  ACTION_LIBRARY,
  CHECK_IDS,
  type ActionId,
  type CheckId,
  type ToolName,
  type ToolParams,
} from "../../shared/tools.ts";
import { SERVICE_NAME } from "../../shared/scenario.ts";
import { ToolInputError } from "./errors.ts";

const LIMITS = {
  name: 40,
  title: 120,
  evidence: 400,
  filter: 100,
  id: 64,
  blastRadius: 200,
} as const;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError("Arguments must be a JSON object.");
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ToolInputError(`Missing required argument: ${key}.`);
    }
  }

  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ToolInputError(`Unknown argument: ${unknown}.`);
  }
}

function stringValue(
  value: UnknownRecord,
  key: string,
  maxLength: number,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw new ToolInputError(`${key} must be a string.`);
  }
  const normalized = candidate.trim();
  if (normalized.length === 0) {
    throw new ToolInputError(`${key} must not be empty.`);
  }
  if (candidate.length > maxLength) {
    throw new ToolInputError(`${key} must be at most ${maxLength} characters.`);
  }
  if (/\p{C}/u.test(candidate)) {
    throw new ToolInputError(`${key} cannot contain control characters.`);
  }
  return normalized;
}

function optionalStringValue(
  value: UnknownRecord,
  key: string,
  maxLength: number,
): string | undefined {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return undefined;
  return stringValue(value, key, maxLength);
}

function enumValue<T extends string>(
  value: UnknownRecord,
  key: string,
  allowed: readonly T[],
  errorCode = "invalid_input",
): T {
  const candidate = value[key];
  if (typeof candidate !== "string" || !allowed.includes(candidate as T)) {
    throw new ToolInputError(
      `${key} must be one of: ${allowed.join(", ")}.`,
      errorCode,
    );
  }
  return candidate as T;
}

function idValue(value: UnknownRecord, key: string): string {
  const id = stringValue(value, key, LIMITS.id);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ToolInputError(`${key} contains unsupported characters.`);
  }
  return id;
}

export function validateToolInput<K extends ToolName>(
  toolName: K,
  input: unknown,
): ToolParams[K] {
  const args = record(input);

  switch (toolName) {
    case "join_room": {
      exactKeys(args, ["name", "role"]);
      return {
        name: stringValue(args, "name", LIMITS.name),
        role: enumValue(args, "role", ["commander", "responder"] as const),
      } as ToolParams[K];
    }
    case "get_room_state":
    case "get_service_status": {
      exactKeys(args, []);
      return {} as ToolParams[K];
    }
    case "query_logs": {
      exactKeys(args, ["service", "window"], ["filter"]);
      const service = stringValue(args, "service", 64);
      if (service !== SERVICE_NAME) {
        throw new ToolInputError(`service must be ${SERVICE_NAME}.`);
      }
      return {
        service,
        window: enumValue(args, "window", ["5m", "15m", "1h"] as const),
        filter: optionalStringValue(args, "filter", LIMITS.filter),
      } as ToolParams[K];
    }
    case "run_check": {
      exactKeys(args, ["checkId"]);
      return {
        checkId: enumValue(args, "checkId", CHECK_IDS) as CheckId,
      } as ToolParams[K];
    }
    case "propose_hypothesis": {
      exactKeys(args, ["title", "evidence", "confidence"]);
      const confidence = args.confidence;
      if (
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        throw new ToolInputError("confidence must be a finite number from 0 to 1.");
      }
      return {
        title: stringValue(args, "title", LIMITS.title),
        evidence: stringValue(args, "evidence", LIMITS.evidence),
        confidence,
      } as ToolParams[K];
    }
    case "counter_hypothesis": {
      exactKeys(args, ["hypothesisId", "evidence"]);
      return {
        hypothesisId: idValue(args, "hypothesisId"),
        evidence: stringValue(args, "evidence", LIMITS.evidence),
      } as ToolParams[K];
    }
    case "propose_mitigation": {
      exactKeys(args, ["hypothesisId", "actionId", "blastRadius"]);
      return {
        hypothesisId: idValue(args, "hypothesisId"),
        actionId: enumValue(args, "actionId", ACTION_LIBRARY, "unknown_action") as ActionId,
        blastRadius: stringValue(args, "blastRadius", LIMITS.blastRadius),
      } as ToolParams[K];
    }
    case "vote": {
      exactKeys(args, ["targetId", "choice"]);
      return {
        targetId: idValue(args, "targetId"),
        choice: enumValue(args, "choice", ["yes", "no"] as const),
      } as ToolParams[K];
    }
    case "request_human_confirm": {
      exactKeys(args, ["mitigationId"]);
      return { mitigationId: idValue(args, "mitigationId") } as ToolParams[K];
    }
    case "apply_mitigation": {
      exactKeys(args, ["actionId"]);
      return {
        actionId: enumValue(args, "actionId", ACTION_LIBRARY, "unknown_action") as ActionId,
      } as ToolParams[K];
    }
    default: {
      const exhaustive: never = toolName;
      throw new ToolInputError(`Unsupported tool: ${String(exhaustive)}.`);
    }
  }
}

export { LIMITS as TOOL_INPUT_LIMITS };
