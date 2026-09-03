import { describe, expect, it } from "vitest";
import {
  clamp,
  formatConfidence,
  formatElapsed,
  formatErrorRate,
  formatLatency,
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
});
