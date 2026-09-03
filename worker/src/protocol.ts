import type { ActionId } from "../../shared/tools";
import type { ClientMessage } from "../../shared/ws-messages";

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_request", "Message must be a JSON object.");
  }
  return value as Record<string, unknown>;
};

const string = (
  input: Record<string, unknown>,
  key: string,
  maximum: number,
  requestId?: string,
): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ProtocolError("invalid_request", `${key} must be a non-empty string of at most ${maximum} characters.`, requestId);
  }
  if (/\p{C}/u.test(value)) {
    throw new ProtocolError("invalid_request", `${key} cannot contain control characters.`, requestId);
  }
  return value.trim();
};

const requestId = (input: Record<string, unknown>): string => {
  const value = input.requestId;
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new ProtocolError("invalid_request", "requestId has an invalid format.");
  }
  return value;
};

const entityId = (input: Record<string, unknown>, key: string, id: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !ENTITY_ID.test(value)) {
    throw new ProtocolError("invalid_request", `${key} has an invalid format.`, id);
  }
  return value;
};

export function parseClientMessage(raw: string): ClientMessage {
  if (new TextEncoder().encode(raw).byteLength > 8_192) {
    throw new ProtocolError("message_too_large", "Messages may not exceed 8 KB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid_json", "Message is not valid JSON.");
  }
  const input = record(value);
  const type = input.type;
  if (typeof type !== "string") throw new ProtocolError("invalid_request", "Message type is required.");

  if (type === "join") {
    const name = string(input, "name", 40);
    if (input.role !== "commander" && input.role !== "responder") {
      throw new ProtocolError("invalid_request", "role must be commander or responder.");
    }
    return { type, name, role: input.role };
  }

  if (type === "confirm") {
    const confirmationId = entityId(input, "confirmationId", "");
    if (typeof input.approved !== "boolean") {
      throw new ProtocolError("invalid_request", "approved must be boolean.");
    }
    return { type, confirmationId, approved: input.approved };
  }

  const id = requestId(input);
  switch (type) {
    case "get_room_state":
    case "get_service_status":
      return { type, requestId: id };
    case "query_logs": {
      const service = string(input, "service", 64, id);
      const window = input.window;
      if (window !== "5m" && window !== "15m" && window !== "1h") {
        throw new ProtocolError("invalid_request", "window must be 5m, 15m, or 1h.", id);
      }
      if (input.filter === undefined) return { type, requestId: id, service, window };
      const filter = string(input, "filter", 100, id);
      return { type, requestId: id, service, window, filter };
    }
    case "run_check": {
      const checkId = input.checkId;
      if (checkId !== "pool_in_use" && checkId !== "flag_states" && checkId !== "deploy_diff" && checkId !== "error_timeline") {
        throw new ProtocolError("invalid_request", "Unknown diagnostic check.", id);
      }
      return { type, requestId: id, checkId };
    }
    case "propose_hypothesis": {
      const confidence = input.confidence;
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new ProtocolError("invalid_request", "confidence must be a number from 0 to 1.", id);
      }
      return {
        type,
        requestId: id,
        title: string(input, "title", 120, id),
        evidence: string(input, "evidence", 400, id),
        confidence,
      };
    }
    case "counter":
      return {
        type,
        requestId: id,
        hypothesisId: entityId(input, "hypothesisId", id),
        evidence: string(input, "evidence", 400, id),
      };
    case "revise": {
      const confidence = input.confidence;
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new ProtocolError("invalid_request", "confidence must be a number from 0 to 1.", id);
      }
      const hypothesisId = entityId(input, "hypothesisId", id);
      if (input.because === undefined) return { type, requestId: id, hypothesisId, confidence };
      return { type, requestId: id, hypothesisId, confidence, because: string(input, "because", 240, id) };
    }
    case "propose_mitigation":
      return {
        type,
        requestId: id,
        hypothesisId: entityId(input, "hypothesisId", id),
        // Runtime allow-listing happens in the room so invented actions get
        // the contractually required unknown_action error.
        actionId: string(input, "actionId", 64, id) as ActionId,
        blastRadius: string(input, "blastRadius", 200, id),
      } as ClientMessage;
    case "vote": {
      if (input.choice !== "yes" && input.choice !== "no") {
        throw new ProtocolError("invalid_request", "choice must be yes or no.", id);
      }
      return { type, requestId: id, targetId: entityId(input, "targetId", id), choice: input.choice };
    }
    case "explain_vote":
      return {
        type,
        requestId: id,
        targetId: entityId(input, "targetId", id),
        rationale: string(input, "rationale", 240, id),
      };
    case "request_confirm":
      return { type, requestId: id, mitigationId: entityId(input, "mitigationId", id) };
    case "apply":
      return {
        type,
        requestId: id,
        actionId: string(input, "actionId", 64, id) as ActionId,
      } as ClientMessage;
    default:
      throw new ProtocolError("unknown_message", "Unknown message type.", id);
  }
}
