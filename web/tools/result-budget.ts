import type { RoomState, ToolResultData } from "../../shared/ws-messages.ts";

export const TOOL_RESULT_MAX_UTF8_BYTES = 2_048;
const TARGET_UTF8_BYTES = 1_900;

export interface ToolFailureResult {
  error: {
    code: string;
    message: string;
  };
}

const encoder = new TextEncoder();

export function utf8JsonSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function clip(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) return value;
  if (limit <= 1) return "…";
  return `${points.slice(0, limit - 1).join("")}…`;
}

function compactVotes(votes: Record<string, "yes" | "no">): Record<string, "yes" | "no"> {
  return Object.fromEntries(
    Object.entries(votes)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 6)
      .map(([memberId, choice]) => [clip(memberId, 32), choice]),
  );
}

interface CompactProfile {
  memberName: number;
  hypothesisTitle: number;
  evidence: number;
  rebuttals: number;
  rebuttalEvidence: number;
  blastRadius: number;
  logEntries: number;
  logText: number;
}

const COMPACT_PROFILES: readonly CompactProfile[] = [
  {
    memberName: 40,
    hypothesisTitle: 72,
    evidence: 120,
    rebuttals: 1,
    rebuttalEvidence: 72,
    blastRadius: 96,
    logEntries: 3,
    logText: 96,
  },
  {
    memberName: 28,
    hypothesisTitle: 48,
    evidence: 72,
    rebuttals: 0,
    rebuttalEvidence: 0,
    blastRadius: 64,
    logEntries: 2,
    logText: 64,
  },
  {
    memberName: 20,
    hypothesisTitle: 36,
    evidence: 44,
    rebuttals: 0,
    rebuttalEvidence: 0,
    blastRadius: 40,
    logEntries: 0,
    logText: 0,
  },
] as const;

function projectRoomState(state: RoomState, profile: CompactProfile): Record<string, unknown> {
  return {
    id: clip(state.id, 64),
    phase: state.phase,
    incidentStartedAt: state.incidentStartedAt,
    resolvedAt: state.resolvedAt,
    members: state.members.slice(0, 6).map((member) => ({
      id: clip(member.id, 32),
      name: clip(member.name, profile.memberName),
      role: member.role,
      agentActive: member.agentActive,
    })),
    hypotheses: state.hypotheses.slice(0, 5).map((hypothesis) => ({
      id: clip(hypothesis.id, 32),
      by: clip(hypothesis.by, 32),
      title: clip(hypothesis.title, profile.hypothesisTitle),
      evidence: clip(hypothesis.evidence, profile.evidence),
      confidence: hypothesis.confidence,
      rebuttals: hypothesis.rebuttals.slice(0, profile.rebuttals).map((rebuttal) => ({
        by: clip(rebuttal.by, 32),
        evidence: clip(rebuttal.evidence, profile.rebuttalEvidence),
      })),
      rebuttalCount: hypothesis.rebuttals.length,
      votes: compactVotes(hypothesis.votes),
    })),
    mitigations: state.mitigations.slice(0, 3).map((mitigation) => ({
      id: clip(mitigation.id, 32),
      hypothesisId: clip(mitigation.hypothesisId, 32),
      actionId: mitigation.actionId,
      blastRadius: clip(mitigation.blastRadius, profile.blastRadius),
      votes: compactVotes(mitigation.votes),
      passed: mitigation.passed,
    })),
    appliedActions: state.appliedActions.slice(0, 3),
    log: state.log.slice(-profile.logEntries).map((entry) => ({
      t: entry.t,
      text: clip(entry.text, profile.logText),
    })),
  };
}

function compactStateResult(
  state: RoomState,
  wrap: (stateProjection: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  for (const profile of COMPACT_PROFILES) {
    const candidate = { ...wrap(projectRoomState(state, profile)), truncated: true };
    if (utf8JsonSize(candidate) <= TARGET_UTF8_BYTES) return candidate;
  }

  return {
    ...wrap({
      id: clip(state.id, 64),
      phase: state.phase,
      incidentStartedAt: state.incidentStartedAt,
      resolvedAt: state.resolvedAt,
      memberCount: state.members.length,
      hypothesisCount: state.hypotheses.length,
      mitigationCount: state.mitigations.length,
      appliedActions: state.appliedActions.slice(0, 3),
    }),
    truncated: true,
  };
}

function compactLogs(data: Extract<ToolResultData, { kind: "logs" }>): Record<string, unknown> {
  const lines: string[] = [];
  let truncated = false;

  for (const rawLine of data.lines) {
    const line = clip(rawLine, 600);
    const candidate = {
      kind: "logs",
      lines: [...lines, line],
      untrustedContentHint: true,
      truncated: false,
    };
    if (utf8JsonSize(candidate) > TARGET_UTF8_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    if (line !== rawLine) truncated = true;
  }

  if (lines.length < data.lines.length) truncated = true;
  return {
    kind: "logs",
    lines,
    untrustedContentHint: true,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function budgetToolResult(value: unknown): unknown {
  if (utf8JsonSize(value) <= TARGET_UTF8_BYTES) return value;

  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;

    if (candidate.kind === "room_state" && candidate.state) {
      return compactStateResult(candidate.state as RoomState, (state) => ({
        kind: "room_state",
        state,
      }));
    }

    if (typeof candidate.memberId === "string" && candidate.state) {
      return compactStateResult(candidate.state as RoomState, (state) => ({
        memberId: clip(candidate.memberId as string, 32),
        state,
      }));
    }

    if (candidate.kind === "logs" && Array.isArray(candidate.lines)) {
      return compactLogs(candidate as unknown as Extract<ToolResultData, { kind: "logs" }>);
    }
  }

  return toolFailure(
    "result_too_large",
    "The result exceeded the safe output budget. Retry with a narrower request.",
  );
}

export function toolFailure(code: string, message: string): ToolFailureResult {
  const result: ToolFailureResult = {
    error: {
      code: clip(code, 64),
      message: clip(message, 320),
    },
  };
  if (utf8JsonSize(result) >= TOOL_RESULT_MAX_UTF8_BYTES) {
    return { error: { code: "tool_error", message: "The tool call failed." } };
  }
  return result;
}

export function assertWithinToolResultBudget(value: unknown): void {
  const size = utf8JsonSize(value);
  if (size >= TOOL_RESULT_MAX_UTF8_BYTES) {
    throw new RangeError(
      `Tool result is ${size} UTF-8 bytes; it must be under ${TOOL_RESULT_MAX_UTF8_BYTES}.`,
    );
  }
}
