import { Lobby, type LobbyEnv } from "./lobby";
import { Room, type RoomEnv } from "./room";
import { isRoomId } from "../../shared/tenancy";

interface Env extends RoomEnv, LobbyEnv {
  ROOMS: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const LOBBY_NAME = "provisioning";

const json = (value: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...extra } });

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const allowedOrigins = (env: Env): Set<string> =>
  new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

/**
 * The frontend is on a different origin from the room Worker, so provisioning
 * needs CORS. The allow-list is the same one the WebSocket upgrade uses; an
 * unknown origin gets no header and therefore no readable response.
 */
const corsHeaders = (env: Env, origin: string | null): Record<string, string> => {
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
};

export { Lobby, Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "multicom-room" });
    }

    const localRequest = isLoopback(url.hostname);
    const origin = request.headers.get("origin");

    if (url.pathname === "/rooms") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
      }
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }
      // Fail closed exactly like the WebSocket path: an unconfigured deployment
      // must not hand out rooms to arbitrary origins.
      if (!env.ALLOWED_ORIGINS && !localRequest) {
        return json({ error: "server_not_configured", missing: "ALLOWED_ORIGINS" }, 503);
      }
      if (env.ALLOWED_ORIGINS && (!origin || !allowedOrigins(env).has(origin))) {
        return json({ error: "origin_forbidden" }, 403);
      }
      const lobby = env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
      const response = await lobby.fetch(
        new Request(new URL("/rooms", url.origin), {
          method: "POST",
          headers: request.headers,
        }),
      );
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(env, origin))) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }

    const match = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    if (!env.ALLOWED_ORIGINS && !localRequest) {
      return json({ error: "server_not_configured", missing: "ALLOWED_ORIGINS" }, 503);
    }
    if (!env.COMMANDER_TOKEN && !localRequest) {
      return json({ error: "server_not_configured", missing: "COMMANDER_TOKEN" }, 503);
    }
    if (env.ALLOWED_ORIGINS) {
      if (!origin || !allowedOrigins(env).has(origin)) return json({ error: "origin_forbidden" }, 403);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }

    const encodedRoomId = match[1] ?? "";
    let roomId: string;
    try {
      roomId = decodeURIComponent(encodedRoomId);
    } catch {
      return json({ error: "invalid_room" }, 400);
    }
    if (!isRoomId(roomId)) return json({ error: "invalid_room" }, 400);
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
