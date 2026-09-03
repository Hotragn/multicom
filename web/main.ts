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
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    return "http://127.0.0.1:8787";
  }
  throw new Error(
    "The room server is not configured. Set VITE_ROOM_WS_URL to the deployed room Worker origin.",
  );
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The application root is missing.");

let roomUrl: string;
try {
  roomUrl = buildRoomWebSocketUrl(
    roomServerOrigin(),
    roomIdFromLocation(),
    new URLSearchParams(location.search).get("demo") === "1",
    new URLSearchParams(location.search).get("commander") ?? undefined,
  );
} catch (error) {
  root.setAttribute("role", "alert");
  root.replaceChildren(
    document.createTextNode(
      error instanceof Error ? error.message : "The room server is not configured.",
    ),
  );
  throw error;
}

const client = getRoomClient({ url: roomUrl });

mountWarRoom(root, client);

void client.connect().catch(() => {
  // Connection state is reported through the UI subscription.
});

void registerWarRoomToolsOnce({ client }).then((result) => {
  if (result.status === "failed") {
    console.error("WebMCP tool registration failed", result.message);
  }
});
