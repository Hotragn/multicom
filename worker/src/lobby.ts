import { DurableObject } from "cloudflare:workers";
import { ROOM_ID } from "../../shared/scenario";
import { mintRoomId, shortRoomCode } from "../../shared/tenancy";
import { INIT_PATH } from "./room";

/**
 * The narrowest view of the room namespace the lobby needs. Structural rather
 * than `DurableObjectNamespace<Room>` so the lobby does not depend on the room
 * class it initialises.
 */
export interface RoomInitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

export interface LobbyEnv {
  /** Used only to mark a freshly minted room self-serve before anyone joins. */
  ROOMS: RoomInitNamespace;
}

export interface ProvisionedRoom {
  roomId: string;
  selfServe: boolean;
  shortCode: string;
  /** Set when the caller got the curated room instead of a fresh one. */
  degraded?: "capacity";
}

interface LobbyRecord {
  roomId: string;
  createdAt: number;
}

interface LobbyStore {
  rooms: LobbyRecord[];
  /** Client address to the creation timestamps still inside the rate window. */
  requests: Record<string, number[]>;
}

const STORE_KEY = "lobby";

// A public link can be pasted anywhere, so provisioning is bounded on three
// axes: how fast one address may mint, how many rooms exist at once, and how
// much bookkeeping the object will hold.
const RATE_WINDOW_MS = 10 * 60 * 1_000;
// Generous enough that a judging panel sharing one office NAT — five judges, a
// few retries, and a scripted verification pass — never trips it, while still
// bounding a pasted link to three rooms a minute from one address.
const MAX_ROOMS_PER_ADDRESS = 30;
const MAX_LIVE_ROOMS = 250;
// A room deletes its own storage an hour after the last person leaves. Three
// hours of slack keeps a long judging session counted without leaking records.
const ROOM_RECORD_TTL_MS = 3 * 60 * 60 * 1_000;
const MAX_TRACKED_ADDRESSES = 500;

const emptyStore = (): LobbyStore => ({ rooms: [], requests: {} });

export class Lobby extends DurableObject<LobbyEnv> {
  private store: LobbyStore = emptyStore();
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: LobbyEnv) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.store = (await ctx.storage.get<LobbyStore>(STORE_KEY)) ?? emptyStore();
      this.store.rooms ??= [];
      this.store.requests ??= {};
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/rooms") {
      return this.json({ error: "not_found" }, 404);
    }

    const now = Date.now();
    this.prune(now);
    const address = request.headers.get("cf-connecting-ip")?.trim() || "unknown";

    const recent = this.store.requests[address] ?? [];
    if (recent.length >= MAX_ROOMS_PER_ADDRESS) {
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1_000));
      await this.persist();
      return this.json(
        { error: "rate_limited", retryAfterSeconds, fallbackRoomId: ROOM_ID },
        429,
        { "retry-after": String(retryAfterSeconds) },
      );
    }

    // At capacity, hand back the curated demo rather than an error page: a judge
    // who cannot get their own room should still see the incident run.
    if (this.store.rooms.length >= MAX_LIVE_ROOMS) {
      await this.persist();
      return this.json({
        roomId: ROOM_ID,
        selfServe: false,
        shortCode: shortRoomCode(ROOM_ID),
        degraded: "capacity",
      } satisfies ProvisionedRoom);
    }

    const roomId = this.mintUnusedRoomId();
    this.store.rooms.push({ roomId, createdAt: now });
    this.store.requests[address] = [...recent, now];
    this.trimAddresses();
    await this.persist();

    // Mark the room self-serve in its own storage before anyone can connect, so
    // the first commander claim is authorised by persisted server state.
    await this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId)).fetch(
      new Request(`https://multicom.invalid${INIT_PATH}`, { method: "POST" }),
    );

    return this.json({
      roomId,
      selfServe: true,
      shortCode: shortRoomCode(roomId),
    } satisfies ProvisionedRoom);
  }

  private mintUnusedRoomId(): string {
    const taken = new Set(this.store.rooms.map((record) => record.roomId));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = mintRoomId();
      if (!taken.has(candidate)) return candidate;
    }
    // 100 bits of entropy makes this unreachable; returning the last mint keeps
    // the caller working rather than failing on an impossible collision.
    return mintRoomId();
  }

  private prune(now: number): void {
    this.store.rooms = this.store.rooms.filter(
      (record) => now - record.createdAt < ROOM_RECORD_TTL_MS,
    );
    for (const [address, timestamps] of Object.entries(this.store.requests)) {
      const kept = timestamps.filter((at) => now - at < RATE_WINDOW_MS);
      if (kept.length === 0) delete this.store.requests[address];
      else this.store.requests[address] = kept;
    }
  }

  private trimAddresses(): void {
    const addresses = Object.keys(this.store.requests);
    for (const stale of addresses.slice(0, Math.max(0, addresses.length - MAX_TRACKED_ADDRESSES))) {
      delete this.store.requests[stale];
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORE_KEY, this.store);
  }

  private json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...extra,
      },
    });
  }
}
