import { describe, expect, it } from "vitest";
import { ProtocolError, parseClientMessage } from "../src/protocol";

describe("WebSocket protocol validation", () => {
  it("parses correlated requests", () => {
    expect(parseClientMessage(JSON.stringify({ type: "run_check", requestId: "r1", checkId: "pool_in_use" }))).toEqual({
      type: "run_check",
      requestId: "r1",
      checkId: "pool_in_use",
    });
  });

  it("preserves invented actions for the required unknown_action response", () => {
    expect(parseClientMessage(JSON.stringify({ type: "apply", requestId: "r2", actionId: "shell:anything" }))).toMatchObject({
      type: "apply",
      actionId: "shell:anything",
    });
  });

  it("rejects control characters and oversized values", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "join", name: "bad\u0000name", role: "responder" }))).toThrow(ProtocolError);
    expect(() => parseClientMessage(JSON.stringify({ type: "join", name: "x".repeat(41), role: "responder" }))).toThrow(ProtocolError);
  });
});
