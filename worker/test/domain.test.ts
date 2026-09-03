import { describe, expect, it } from "vitest";
import type { RoomState } from "../../shared/ws-messages";
import { recomputeMitigations, tally } from "../src/domain";

const state = (): RoomState => ({
  id: "room",
  phase: "mitigating",
  incidentStartedAt: 1,
  resolvedAt: null,
  members: [
    { id: "m1", name: "A", role: "commander", agentActive: true },
    { id: "m2", name: "B", role: "responder", agentActive: true },
    { id: "m3", name: "C", role: "responder", agentActive: false },
  ],
  hypotheses: [],
  mitigations: [{ id: "fix1", hypothesisId: "h1", actionId: "scale_pool:default", blastRadius: "none", votes: {}, passed: false }],
  appliedActions: [],
  log: [],
});

describe("room voting", () => {
  it("excludes inactive members and fails ties", () => {
    expect(tally({ m1: "yes", m2: "no", m3: "yes" }, new Set(["m1", "m2"]))).toEqual({ yes: 1, no: 1 });
  });

  it("recomputes passage as presence changes", () => {
    const room = state();
    room.mitigations[0]!.votes = { m1: "yes" };
    recomputeMitigations(room);
    expect(room.mitigations[0]!.passed).toBe(false);
    room.members[1]!.agentActive = false;
    recomputeMitigations(room);
    expect(room.mitigations[0]!.passed).toBe(true);
  });
});
