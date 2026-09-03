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
