import { ROOM_ID } from "../shared/scenario";
import { isRoomId, shortRoomCode } from "../shared/tenancy";
import { TOOL_NAMES } from "../shared/tools";
import {
  buildRoomWebSocketUrl,
  getRoomClient,
  provisionRoom,
  registerWarRoomToolsOnce,
} from "./tools";
import { mountLobby, mountWarRoom, type ToolRegistrationSummary } from "./ui";

/**
 * Whether this browser exposes WebMCP itself.
 *
 * Read before the MCP-B polyfill installs its own `document.modelContext`,
 * because afterwards the two are indistinguishable — and a judge deciding
 * whether they are looking at native support deserves the honest answer.
 */
const NATIVE_WEBMCP = (() => {
  try {
    return (
      typeof document.modelContext?.registerTool === "function" ||
      typeof navigator.modelContext?.registerTool === "function"
    );
  } catch {
    return false;
  }
})();

const params = new URLSearchParams(location.search);

function requestedRoomId(): string | null {
  const requested = params.get("room");
  if (requested && isRoomId(requested)) return requested;
  // `?demo=1` with no room is the curated public demo, and always has been.
  if (params.get("demo") === "1") return ROOM_ID;
  return null;
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

/** A link a judge can hand to a colleague. Never carries the commander secret. */
function shareUrlFor(roomId: string, demo: boolean): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", roomId);
  if (demo) url.searchParams.set("demo", "1");
  return url.toString();
}

function navigateTo(search: URLSearchParams): void {
  const url = new URL(location.href);
  url.search = search.toString();
  url.hash = "";
  location.assign(url.toString());
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The application root is missing.");

function fail(message: string): never {
  root!.setAttribute("role", "alert");
  root!.replaceChildren(document.createTextNode(message));
  throw new Error(message);
}

const roomId = requestedRoomId();

if (roomId === null) {
  document.title = "multicom · Start an incident";
  // --- Lobby ----------------------------------------------------------------
  let origin: string | null = null;
  try {
    origin = roomServerOrigin();
  } catch {
    // A lobby without a room server can still offer the curated demo link.
    origin = null;
  }

  mountLobby(root, {
    async startOwnIncident() {
      if (!origin) {
        throw new Error("The room server is not configured, so a new room cannot be provisioned.");
      }
      const provisioned = await provisionRoom(origin);
      const next = new URLSearchParams({ room: provisioned.roomId });
      if (provisioned.degraded === "capacity") next.set("demo", "1");
      navigateTo(next);
    },
    watchCuratedDemo() {
      navigateTo(new URLSearchParams({ demo: "1" }));
    },
  });
} else {
  document.title = `${shortRoomCode(roomId)} · multicom`;
  // --- Room -----------------------------------------------------------------
  const demo = params.get("demo") === "1";
  const commanderToken = params.get("commander") ?? undefined;

  let roomUrl: string;
  let origin: string;
  try {
    origin = roomServerOrigin();
    roomUrl = buildRoomWebSocketUrl(origin, roomId, demo, commanderToken);
  } catch (error) {
    fail(error instanceof Error ? error.message : "The room server is not configured.");
  }

  const client = getRoomClient({ url: roomUrl });

  // Registration is kicked off here so the page can report what actually
  // happened — the count and whether it was native — rather than guessing.
  const registration: Promise<ToolRegistrationSummary> = registerWarRoomToolsOnce({ client }).then(
    (result) => {
      if (result.status === "failed") {
        console.error("WebMCP tool registration failed", result.message);
      }
      return {
        status: result.status,
        count: result.status === "registered" ? result.count : 0,
        native: NATIVE_WEBMCP,
        ...(result.message ? { message: result.message } : {}),
      };
    },
    (error: unknown) => ({
      status: "failed" as const,
      count: 0,
      native: NATIVE_WEBMCP,
      message: error instanceof Error ? error.message : "Tool registration failed.",
    }),
  );

  mountWarRoom(root, client, {
    environment: {
      roomId,
      shortCode: shortRoomCode(roomId),
      shareUrl: shareUrlFor(roomId, demo),
      // The server owns this decision; the page only needs it to set expectations.
      selfServe: roomId !== ROOM_ID && /^r[a-z2-7]{20}$/.test(roomId),
      demo,
      judgeConsoleOpen: params.get("judge") === "1",
      registration,
      async startOwnRoom() {
        const provisioned = await provisionRoom(origin);
        const next = new URLSearchParams({ room: provisioned.roomId });
        if (provisioned.degraded === "capacity") next.set("demo", "1");
        navigateTo(next);
      },
      runScriptedDrill() {
        const next = new URLSearchParams({ room: roomId, demo: "1" });
        if (params.get("judge") === "1") next.set("judge", "1");
        // The house bot is armed by the `demo` flag on the socket, so the
        // scripted path reconnects rather than adding a second control channel.
        navigateTo(next);
      },
    },
  });

  void client.watch().catch(() => {
    // Connection state is reported through the UI subscription.
  });

  if (TOOL_NAMES.length !== 12) {
    console.error("The room tool surface changed size unexpectedly.");
  }
}
