const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatErrorRate(value: number): string {
  return `${(clamp(value, 0, 1) * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function formatLatency(value: number): string {
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  if (safeValue >= 1_000) {
    return `${(safeValue / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(safeValue)}ms`;
}

export function formatConfidence(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

export function formatElapsed(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function epochSecondsToDate(value: number): Date {
  const maximumEpochSeconds = 8_640_000_000_000;
  const safeValue = clamp(
    Number.isFinite(value) ? value : 0,
    -maximumEpochSeconds,
    maximumEpochSeconds,
  );
  return new Date(safeValue * 1_000);
}

export function formatActivityTime(value: number): string {
  const date = epochSecondsToDate(value);
  if (Number.isNaN(date.valueOf())) {
    return "Unknown time";
  }
  return timeFormatter.format(date);
}

const stampFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatTimestamp(value: number): string {
  const date = epochSecondsToDate(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : stampFormatter.format(date);
}

/** ISO 8601, for the machine-readable half of a run report. */
export function isoTimestamp(value: number): string {
  const date = epochSecondsToDate(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case "triage":
      return "Triage";
    case "diagnosing":
      return "Diagnosing";
    case "mitigating":
      return "Mitigating";
    case "resolved":
      return "Resolved";
    default:
      return "Waiting";
  }
}

export function commanderSeatTaken(
  members: readonly { role: string; agentActive: boolean }[] | undefined,
): boolean {
  return (members ?? []).some((member) => member.role === "commander" && member.agentActive);
}

/**
 * The instruction a judge copies to their agent. The commander-open wording is
 * the default because an empty seat deadlocks approval; once someone holds it,
 * a second agent must not steal it.
 */
export function agentInstruction(commanderTaken: boolean): string {
  if (commanderTaken) {
    return "Join this incident room as a responder. The commander seat is already taken — do not claim it. Inspect the service, gather evidence, challenge weak theories, and vote on a safe fix. A human in the commander seat must approve anything applied; you cannot approve a write yourself.";
  }
  return "Join this incident room as commander, under the name Judge unless I give you another. That seat is what puts the approval dialog in front of me — you cannot approve anything yourself, and I will be the one clicking. Inspect the service, gather evidence, challenge weak theories, and coordinate a safe fix. Ask me before anything is applied.";
}

export const FIRST_AGENT_INSTRUCTION = agentInstruction(false);

export function agentSeatNote(commanderTaken: boolean): string {
  if (commanderTaken) {
    return "Send it the instruction below rather than pointing it at this page: the commander seat is already taken, so it should join as a responder. Your agent cannot approve a fix — only the seated commander's click can.";
  }
  return "Send it the instruction below rather than pointing it at this page: it asks your agent to take the commander seat, which is what puts the approval dialog in front of you. Your agent cannot approve a fix — only your click can.";
}

export function heroHeadline(phase: string, hypothesisCount: number): string {
  switch (phase) {
    case "diagnosing": {
      const count = Math.max(0, Math.floor(hypothesisCount));
      if (count <= 1) return "One theory on the board";
      if (count === 2) return "Two theories, one cause";
      if (count === 3) return "Three theories, one cause";
      return `${count} theories, one cause`;
    }
    case "mitigating":
      return "One fix, waiting on a human";
    case "resolved":
      return "Back to baseline";
    default:
      return "Production is down";
  }
}
