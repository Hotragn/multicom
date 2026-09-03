import { ROOM_ID } from "../shared/scenario";
import {
  buildRoomWebSocketUrl,
  getRoomClient,
  registerWarRoomToolsOnce,
} from "./tools";
import { mountWarRoom } from "./ui";

function roomIdFromLocation(): string {
  const requested = new URLSearchParams(location.search).get("room");
  return requested && /^[A-Za-z0-9_-]{1,80}$/.test(requested) ? requested : ROOM_ID;
}

function roomServerOrigin(): string {
  const configured = import.meta.env.VITE_ROOM_WS_URL?.trim();
  if (configured) return configured;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:8787";
  }
  return location.origin;
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The application root is missing.");

const client = getRoomClient({
  url: buildRoomWebSocketUrl(
    roomServerOrigin(),
    roomIdFromLocation(),
    new URLSearchParams(location.search).get("demo") === "1",
  ),
});

mountWarRoom(root, client);

void client.connect().catch(() => {
  // Connection state is reported through the UI subscription.
});

void registerWarRoomToolsOnce({ client }).then((result) => {
  if (result.status === "failed") {
    console.error("WebMCP tool registration failed", result.message);
  }
});
