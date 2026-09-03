import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "../../shared/scenario";
import { TENANT_HEADER, mintRoomId } from "../../shared/tenancy";
import { scenarioTenantFor } from "../src/tenant";

const requestWith = (tenant?: string): Request =>
  new Request("https://storefront-api.test/status", {
    headers: tenant === undefined ? {} : { [TENANT_HEADER]: tenant },
  });

describe("scenario tenant routing", () => {
  it("gives two rooms two different scenario objects", () => {
    const roomA = mintRoomId();
    const roomB = mintRoomId();
    const a = scenarioTenantFor(requestWith(roomA));
    const b = scenarioTenantFor(requestWith(roomB));
    expect(a).toEqual({ ok: true, tenant: roomA });
    expect(b).toEqual({ ok: true, tenant: roomB });
    expect(a.ok && b.ok && a.tenant === b.tenant).toBe(false);
  });

  it("keeps the original single-tenant object when no room is named", () => {
    expect(scenarioTenantFor(requestWith())).toEqual({ ok: true, tenant: SERVICE_NAME });
  });

  it("refuses a header that is not a room id", () => {
    // The value becomes a Durable Object name, so it is validated, not escaped.
    expect(scenarioTenantFor(requestWith("../p1-storefront"))).toEqual({
      ok: false,
      code: "invalid_tenant",
    });
    expect(scenarioTenantFor(requestWith("a".repeat(81)))).toEqual({
      ok: false,
      code: "invalid_tenant",
    });
  });
});
