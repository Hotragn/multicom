import { describe, expect, it } from "vitest";
import { ROOM_ID, SERVICE_NAME } from "../../shared/scenario";
import {
  MINTED_ROOM_ID_PATTERN,
  isMintedRoomId,
  isRoomId,
  mintRoomId,
  resolveTenant,
  shortRoomCode,
} from "../../shared/tenancy";
import { targetRequestHeaders } from "../src/target-request";
import { TENANT_HEADER } from "../../shared/tenancy";

describe("minted room ids", () => {
  it("produces ids the room router already accepts", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = mintRoomId();
      expect(id).toMatch(MINTED_ROOM_ID_PATTERN);
      expect(isRoomId(id)).toBe(true);
      expect(isMintedRoomId(id)).toBe(true);
      expect(id).toHaveLength(21);
    }
  });

  it("does not repeat", () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintRoomId()));
    expect(minted.size).toBe(500);
  });

  it("maps every byte value onto the alphabet", () => {
    const id = mintRoomId((length) =>
      Uint8Array.from({ length }, (_value, index) => index * 13),
    );
    expect(id).toMatch(MINTED_ROOM_ID_PATTERN);
  });

  // The whole self-serve commander model rests on curated rooms not matching.
  it("never classifies a curated or hand-written room as self-serve", () => {
    for (const name of [
      ROOM_ID,
      "p1-storefront",
      "realtime",
      "recovery",
      "rationale",
      "registration",
      "demo-restart",
      "limits",
      "unauthorized",
      "r",
      "R2345678901234567890",
      "rabcdefghijklmnopqrs",
      "rabcdefghijklmnopqrstu",
      "rabcdefghijklmnopqrs1",
    ]) {
      expect(isMintedRoomId(name), name).toBe(false);
    }
  });
});

describe("resolveTenant", () => {
  it("falls back to the single-tenant name when no header is present", () => {
    expect(resolveTenant(null, SERVICE_NAME)).toEqual({ ok: true, tenant: SERVICE_NAME });
    expect(resolveTenant(undefined, SERVICE_NAME)).toEqual({ ok: true, tenant: SERVICE_NAME });
    expect(resolveTenant("   ", SERVICE_NAME)).toEqual({ ok: true, tenant: SERVICE_NAME });
  });

  it("accepts a valid room id and trims it", () => {
    expect(resolveTenant("p1-storefront", SERVICE_NAME)).toEqual({
      ok: true,
      tenant: "p1-storefront",
    });
    expect(resolveTenant(" rabcdefghijklmnopqrst ", SERVICE_NAME)).toEqual({
      ok: true,
      tenant: "rabcdefghijklmnopqrst",
    });
  });

  it("refuses anything that is not a room id rather than coercing it", () => {
    for (const hostile of [
      "../../etc/passwd",
      "room with spaces",
      "room/slash",
      "room\u0000null",
      "a".repeat(81),
      "tenant;drop",
    ]) {
      expect(resolveTenant(hostile, SERVICE_NAME), hostile).toEqual({
        ok: false,
        code: "invalid_tenant",
      });
    }
  });
});

describe("target request headers", () => {
  it("always carries the tenant so no call site can share scenario state", () => {
    const read = targetRequestHeaders({ roomId: "rabcdefghijklmnopqrst" });
    expect(read.get(TENANT_HEADER)).toBe("rabcdefghijklmnopqrst");
    expect(read.get("authorization")).toBeNull();
  });

  it("authorizes only mutations, and only when a token exists", () => {
    expect(
      targetRequestHeaders({ roomId: "room1", targetToken: "secret", authorize: true }).get(
        "authorization",
      ),
    ).toBe("Bearer secret");
    expect(
      targetRequestHeaders({ roomId: "room1", targetToken: "secret" }).get("authorization"),
    ).toBeNull();
    expect(
      targetRequestHeaders({ roomId: "room1", authorize: true }).get("authorization"),
    ).toBeNull();
  });
});

describe("shortRoomCode", () => {
  it("gives a minted room a readable code and leaves names alone", () => {
    expect(shortRoomCode("rabcdefghijklmnopqrst")).toBe("ABCD-EFGH");
    expect(shortRoomCode(ROOM_ID)).toBe(ROOM_ID);
  });
});

// The two Node scripts under tools/ run under a bare `node`, so they cannot
// import the TypeScript contract and keep their own copy of the header name.
describe("tool scripts agree with the contract", () => {
  it("live-acceptance sends the same tenant header the Workers read", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../tools/live-acceptance.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain(`const TENANT_HEADER = "${TENANT_HEADER}"`);
  });
});

// The .mjs tools cannot import the TypeScript contract, so each keeps its own
// copy of the tool count. Same drift hazard as TENANT_HEADER above.
describe("tool scripts agree with the tool count", () => {
  it("every Node script expects exactly as many tools as the contract declares", async () => {
    const { readFile } = await import("node:fs/promises");
    const { TOOL_NAMES } = await import("../../shared/tools");
    for (const script of [
      "agent-drill.mjs",
      "agent-session.mjs",
      "live-acceptance.mjs",
      "prod-smoke.mjs",
    ]) {
      const source = await readFile(new URL(`../../tools/${script}`, import.meta.url), "utf8");
      expect(source, script).toContain(`const EXPECTED_TOOLS = ${TOOL_NAMES.length}`);
    }
  });
});
