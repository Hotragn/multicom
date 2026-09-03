// Room identity crosses three boundaries — the browser picks a room, the room
// Worker scopes its target calls to that room, and the target Worker keys its
// scenario state by it — so the header name and the id shapes live in one place.
// Before this existed the target routed every request to one global Durable
// Object, and resolving one judge's incident silently resolved everybody's.

export const TENANT_HEADER = "X-Multicom-Tenant";

/** The room id shape the room Worker has always accepted. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

// A minted room id is the durable carrier of "this room was provisioned for one
// judge". Twenty base32 characters is 100 bits, so it cannot be guessed, and no
// hand-written room name can collide with the shape: the curated
// `p1-storefront` has a hyphen, and every other name in this repo is too short.
const MINTED_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const MINTED_ROOM_ID_LENGTH = 20;
export const MINTED_ROOM_ID_PATTERN = /^r[a-z2-7]{20}$/;

export const isRoomId = (value: string): boolean => ROOM_ID_PATTERN.test(value);

export const isMintedRoomId = (value: string): boolean =>
  MINTED_ROOM_ID_PATTERN.test(value);

/**
 * Mint a self-serve room id. `randomBytes` is injected so the room Worker, the
 * tests, and the drill all mint through the same shape rules.
 */
export function mintRoomId(
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): string {
  const bytes = randomBytes(MINTED_ROOM_ID_LENGTH);
  let id = "r";
  for (let index = 0; index < MINTED_ROOM_ID_LENGTH; index += 1) {
    // Rejection-free: 256 is not a multiple of 32, but every byte maps onto the
    // alphabet by its low five bits, which is uniform over 32 values.
    id += MINTED_ALPHABET[(bytes[index] ?? 0) & 31];
  }
  return id;
}

export type TenantResolution =
  | { ok: true; tenant: string }
  | { ok: false; code: "invalid_tenant" };

/**
 * Resolve the tenant a target request belongs to. An absent header keeps the
 * original single-tenant behaviour, so `/health` and any legacy caller still
 * work; a malformed header is refused rather than coerced, because the value
 * goes straight into `idFromName`.
 */
export function resolveTenant(
  header: string | null | undefined,
  fallback: string,
): TenantResolution {
  if (header === null || header === undefined) return { ok: true, tenant: fallback };
  const trimmed = header.trim();
  if (trimmed.length === 0) return { ok: true, tenant: fallback };
  if (!isRoomId(trimmed)) return { ok: false, code: "invalid_tenant" };
  return { ok: true, tenant: trimmed };
}

/**
 * A short label a judge can read aloud to tell two of their own sessions apart.
 * Minted ids are opaque, so show the first eight characters in two groups; a
 * curated or hand-written name is already legible, so it is returned as is.
 */
export function shortRoomCode(roomId: string): string {
  if (!isMintedRoomId(roomId)) return roomId;
  const body = roomId.slice(1, 9).toUpperCase();
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}
