import { isRoomId, shortRoomCode } from "../../shared/tenancy.ts";
import { RoomClientError } from "./errors.ts";

export interface ProvisionedRoom {
  roomId: string;
  selfServe: boolean;
  shortCode: string;
  /** Set when the lobby handed back the curated room instead of a fresh one. */
  degraded?: "capacity";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ask the room Worker for an isolated room.
 *
 * The response is validated the same way every other server payload is: the
 * room id goes into a URL and a WebSocket path, so a malformed one is refused
 * rather than passed along. At capacity the lobby answers with the curated room
 * and a `degraded` marker, which is a usable answer rather than an error.
 */
export async function provisionRoom(roomServerOrigin: string): Promise<ProvisionedRoom> {
  const url = new URL("/rooms", roomServerOrigin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RoomClientError("bad_room_server", "The room server origin is not an HTTP origin.");
  }

  let response: Response;
  try {
    // No body and no custom headers, so this stays a simple CORS request.
    response = await fetch(url, { method: "POST", mode: "cors", cache: "no-store" });
  } catch {
    throw new RoomClientError(
      "provision_unreachable",
      "Could not reach the room server. Try the live demo instead.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "provision_failed";
    if (code === "rate_limited") {
      const retry =
        isRecord(payload) && typeof payload.retryAfterSeconds === "number"
          ? Math.max(1, Math.round(payload.retryAfterSeconds))
          : 60;
      throw new RoomClientError(
        "rate_limited",
        `Too many rooms from this address. Try again in ${retry}s, or watch the live demo.`,
      );
    }
    throw new RoomClientError(code, "The room server would not provision a room.");
  }

  if (!isRecord(payload) || typeof payload.roomId !== "string" || !isRoomId(payload.roomId)) {
    throw new RoomClientError("provision_invalid", "The room server returned an unusable room id.");
  }

  const degraded = payload.degraded === "capacity" ? ("capacity" as const) : undefined;
  return {
    roomId: payload.roomId,
    selfServe: payload.selfServe === true,
    shortCode:
      typeof payload.shortCode === "string" && payload.shortCode.length <= 24
        ? payload.shortCode
        : shortRoomCode(payload.roomId),
    ...(degraded ? { degraded } : {}),
  };
}
