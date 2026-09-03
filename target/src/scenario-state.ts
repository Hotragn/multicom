import {
  CHECK_RESULTS,
  FAULTY_STATUS,
  HEALTHY_STATUS,
  PARTIAL_ROLLBACK_STATUS,
  SYNTHETIC_LOGS,
} from "../../shared/scenario";
import type { ActionId, CheckId, LogWindow } from "../../shared/tools";
import type { CheckResult, ServiceStatus } from "../../shared/ws-messages";

export interface PersistedScenario {
  armed: boolean;
  armedAt: number;
  actionId: ActionId | null;
  appliedAt: number | null;
}

export const INITIAL_SCENARIO: PersistedScenario = {
  armed: true,
  armedAt: 0,
  actionId: null,
  appliedAt: null,
};

const cloneStatus = (status: ServiceStatus): ServiceStatus => ({
  ...status,
  flagStates: { ...status.flagStates },
  pool: { ...status.pool },
});

const interpolate = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

export function snapshotAt(state: PersistedScenario, nowMs: number): ServiceStatus {
  if (!state.armed) return cloneStatus(HEALTHY_STATUS);

  if (state.actionId === "rollback:deploy-1f3a") {
    return cloneStatus(PARTIAL_ROLLBACK_STATUS);
  }

  if (state.actionId === "disable_flag:new-checkout") {
    const status = cloneStatus(FAULTY_STATUS);
    status.flagStates["new-checkout"] = false;
    return status;
  }

  if (state.actionId !== "scale_pool:default" || state.appliedAt === null) {
    return cloneStatus(FAULTY_STATUS);
  }

  // The curve is derived from persisted time, so every isolate observes the
  // same recovery and no background timer is required in the target Worker.
  // Finish by six seconds so the room's two-second status cadence still has
  // margin to broadcast and render recovery inside the ten-second acceptance gate.
  const progress = Math.min(1, Math.max(0, (nowMs - state.appliedAt) / 6_000));
  return {
    errorRate: Number(interpolate(FAULTY_STATUS.errorRate, HEALTHY_STATUS.errorRate, progress).toFixed(4)),
    p99ms: Math.round(interpolate(FAULTY_STATUS.p99ms, HEALTHY_STATUS.p99ms, progress)),
    currentDeploy: HEALTHY_STATUS.currentDeploy,
    flagStates: { ...HEALTHY_STATUS.flagStates },
    pool: {
      inUse: Math.round(interpolate(FAULTY_STATUS.pool.inUse, HEALTHY_STATUS.pool.inUse, progress)),
      max: HEALTHY_STATUS.pool.max,
    },
  };
}

export function checkAt(state: PersistedScenario, checkId: CheckId, nowMs: number): CheckResult {
  const status = snapshotAt(state, nowMs);
  switch (checkId) {
    case "pool_in_use":
      return { checkId, ...status.pool };
    case "flag_states":
      return { checkId, flags: { ...status.flagStates } };
    case "deploy_diff":
      {
        const canonical = CHECK_RESULTS.deploy_diff as Extract<CheckResult, { checkId: "deploy_diff" }>;
      return {
        checkId,
        deploy: status.currentDeploy,
        changes: state.actionId === "scale_pool:default" ? ["DB_POOL_MAX: 1 -> 50"] : [...canonical.changes],
      };
      }
    case "error_timeline":
      {
        const canonical = CHECK_RESULTS.error_timeline as Extract<CheckResult, { checkId: "error_timeline" }>;
      return {
        checkId,
        points: canonical.points.map((point) => ({ ...point })),
      };
      }
  }
}

export function selectLogs(window: LogWindow, filter?: string): string[] {
  const start = window === "5m" ? Math.max(0, SYNTHETIC_LOGS.length - 3) : 0;
  const selected = SYNTHETIC_LOGS.slice(start);
  const needle = filter?.trim().toLocaleLowerCase();
  if (!needle) return [...selected];
  return selected.filter((line) => line.toLocaleLowerCase().includes(needle));
}
