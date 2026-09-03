import { describe, expect, it } from "vitest";
import {
  agentInstruction,
  clamp,
  commanderSeatTaken,
  FIRST_AGENT_INSTRUCTION,
  formatConfidence,
  formatElapsed,
  formatErrorRate,
  formatLatency,
  heroHeadline,
  inviteCopy,
  phaseLabel,
} from "./format";

describe("room display formatting", () => {
  it("keeps operational metrics within readable bounds", () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(formatErrorRate(0.487)).toBe("49%");
    expect(formatLatency(840)).toBe("840ms");
    expect(formatLatency(1_240)).toBe("1.2s");
    expect(formatConfidence(1.8)).toBe("100%");
  });

  it("formats elapsed incident time and known phases", () => {
    expect(formatElapsed(125)).toBe("2:05");
    expect(formatElapsed(-1)).toBe("0:00");
    expect(phaseLabel("mitigating")).toBe("Mitigating");
    expect(phaseLabel("unexpected")).toBe("Waiting");
  });

  it("derives agent instruction and hero copy from room state", () => {
    expect(FIRST_AGENT_INSTRUCTION).toContain("under the name Judge");
    expect(agentInstruction(true)).toContain("as a responder");
    expect(agentInstruction(true)).not.toContain("under the name Judge");
    expect(commanderSeatTaken([{ role: "commander", agentActive: true }])).toBe(true);
    expect(commanderSeatTaken([{ role: "commander", agentActive: false }])).toBe(false);
    expect(heroHeadline("diagnosing", 1)).toBe("One theory on the board");
    expect(heroHeadline("diagnosing", 3)).toBe("Three theories, one cause");
    expect(heroHeadline("triage", 0)).toBe("Production is down");
    expect(inviteCopy({ seated: 0, demo: false }).title).toContain("waiting for people");
    expect(inviteCopy({ seated: 2, demo: false }).title).toContain("2 people");
    expect(inviteCopy({ seated: 1, demo: true }).body).toContain("start your own incident");
  });
});
