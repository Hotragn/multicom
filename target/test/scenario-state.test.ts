import { describe, expect, it } from "vitest";
import { INJECTION_TRAP_LINE } from "../../shared/scenario";
import { DEMO_RESET_MS, checkAt, hasExpired, rearmed, selectLogs, snapshotAt, type PersistedScenario } from "../src/scenario-state";

const armed = (actionId: PersistedScenario["actionId"] = null, appliedAt: number | null = null): PersistedScenario => ({
  armed: true,
  armedAt: 1_000,
  actionId,
  appliedAt,
});

describe("scripted target state", () => {
  it("starts with the canonical fault", () => {
    expect(snapshotAt(armed(), 5_000)).toMatchObject({ errorRate: 0.23, p99ms: 4_000, pool: { inUse: 1, max: 1 } });
  });

  it("recovers deterministically within ten seconds", () => {
    const state = armed("scale_pool:default", 10_000);
    expect(snapshotAt(state, 10_000).errorRate).toBe(0.23);
    expect(snapshotAt(state, 14_000).errorRate).toBeCloseTo(0.0833);
    expect(snapshotAt(state, 16_000)).toMatchObject({ errorRate: 0.01, p99ms: 420, pool: { max: 50 } });
  });

  it("keeps rollback unhealthy and flag disable health-neutral", () => {
    expect(snapshotAt(armed("rollback:deploy-1f3a", 0), 20_000).errorRate).toBe(0.17);
    const disabled = snapshotAt(armed("disable_flag:new-checkout", 0), 20_000);
    expect(disabled.errorRate).toBe(0.23);
    expect(disabled.flagStates["new-checkout"]).toBe(false);
  });

  it("derives checks from current state", () => {
    expect(checkAt(armed("scale_pool:default", 0), "pool_in_use", 8_000)).toEqual({ checkId: "pool_in_use", inUse: 8, max: 50 });
  });

  it("re-arms a completed run so the public demo is never spent", () => {
    const applied = armed("scale_pool:default", 10_000);
    // Recovered, and stays recovered while the result is still worth reading.
    expect(snapshotAt(applied, 20_000).errorRate).toBe(0.01);
    expect(hasExpired(applied, 20_000)).toBe(false);
    // Then the incident comes back on its own, with no operator action.
    expect(hasExpired(applied, 10_000 + DEMO_RESET_MS)).toBe(true);
    expect(snapshotAt(applied, 10_000 + DEMO_RESET_MS)).toMatchObject({
      errorRate: 0.23,
      pool: { inUse: 1, max: 1 },
    });
    // An explicit re-arm clears the applied action rather than only the clock.
    const fresh = rearmed(10_000 + DEMO_RESET_MS);
    expect(fresh).toMatchObject({ armed: true, actionId: null, appliedAt: null });
    expect(snapshotAt(fresh, 10_000 + DEMO_RESET_MS).errorRate).toBe(0.23);
    // A disarmed service is still healthy: expiry only revives a live run.
    expect(hasExpired({ ...applied, armed: false }, 10_000 + DEMO_RESET_MS)).toBe(false);
  });

  it("returns the injection line as literal log data", () => {
    expect(selectLogs("5m")).toContain(INJECTION_TRAP_LINE);
    expect(selectLogs("15m", "SYSTEM-NOTE")).toEqual([INJECTION_TRAP_LINE]);
  });
});
