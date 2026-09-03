import { TENANT_HEADER } from "../../shared/tenancy";

export interface TargetRequestOptions {
  /** The room this call belongs to. Becomes the target's scenario tenant. */
  roomId: string;
  targetToken?: string;
  /** Only mutations carry the bearer token; reads are unauthenticated. */
  authorize?: boolean;
}

/**
 * Compose the headers for one target call.
 *
 * Every target request goes through here so no call site can forget the tenant
 * header. A missing header would silently fall back to the shared scenario
 * object, which is the exact bug that made concurrent judging impossible.
 */
export function targetRequestHeaders(options: TargetRequestOptions): Headers {
  const headers = new Headers();
  headers.set(TENANT_HEADER, options.roomId);
  if (options.authorize && options.targetToken) {
    headers.set("authorization", `Bearer ${options.targetToken}`);
  }
  return headers;
}
