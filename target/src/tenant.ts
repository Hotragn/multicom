import { SERVICE_NAME } from "../../shared/scenario";
import { TENANT_HEADER, resolveTenant, type TenantResolution } from "../../shared/tenancy";

/**
 * Which scenario object a target request belongs to.
 *
 * Kept out of `index.ts` so it can be tested without loading `cloudflare:workers`.
 * An absent header keeps the original single-tenant name, so `/health` and any
 * caller that predates room scoping still work.
 */
export function scenarioTenantFor(request: Request): TenantResolution {
  return resolveTenant(request.headers.get(TENANT_HEADER), SERVICE_NAME);
}
