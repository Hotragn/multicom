import { Room, type RoomEnv } from "./room";

interface Env extends RoomEnv {
  ROOMS: DurableObjectNamespace<Room>;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "multicom-room" });
    }

    const match = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    const localRequest = isLoopback(url.hostname);
    if (!env.ALLOWED_ORIGINS && !localRequest) {
      return json({ error: "server_not_configured", missing: "ALLOWED_ORIGINS" }, 503);
    }
    if (!env.COMMANDER_TOKEN && !localRequest) {
      return json({ error: "server_not_configured", missing: "COMMANDER_TOKEN" }, 503);
    }
    if (env.ALLOWED_ORIGINS) {
      const allowed = new Set(env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
      const origin = request.headers.get("origin");
      if (!origin || !allowed.has(origin)) return json({ error: "origin_forbidden" }, 403);
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
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) return json({ error: "invalid_room" }, 400);
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
