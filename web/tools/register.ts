import { TOOL_NAMES } from "../../shared/tools.ts";
import { initializeStrictWebMcpPolyfill } from "./polyfill.ts";
import { getRoomClient, type RoomClient } from "./room-client.ts";
import { createToolDefinitions } from "./tool-definitions.ts";
import type { ModelContextLike } from "./webmcp-types.ts";

export interface RegistrationResult {
  status: "registered" | "unavailable" | "failed";
  count: number;
  message?: string;
}

export interface RegisterWarRoomToolsOptions {
  client?: RoomClient;
  document?: Document;
  navigator?: Navigator;
  window?: Window;
  initializePolyfill?: () => void;
}

interface RegistrationState {
  promise: Promise<RegistrationResult>;
  controller: AbortController;
}

type GlobalRegistrationState = typeof globalThis & {
  __MULTICOM_WEBMCP_REGISTRATION__?: RegistrationState;
};

function safeModelContext(
  documentObject: Document | undefined,
  navigatorObject: Navigator | undefined,
): ModelContextLike | null {
  try {
    const documentContext = documentObject?.modelContext;
    if (documentContext && typeof documentContext.registerTool === "function") {
      return documentContext;
    }
  } catch {
    // A browser may expose a guarded getter. The legacy surface is still worth trying.
  }

  try {
    const navigatorContext = navigatorObject?.modelContext;
    if (navigatorContext && typeof navigatorContext.registerTool === "function") {
      return navigatorContext;
    }
  } catch {
    // Absence or a guarded legacy getter must not break the room page.
  }

  return null;
}

function afterPageLoad(documentObject: Document, windowObject: Window): Promise<void> {
  if (documentObject.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    windowObject.addEventListener("load", () => resolve(), { once: true });
  });
}

async function performRegistration(
  controller: AbortController,
  options: RegisterWarRoomToolsOptions,
): Promise<RegistrationResult> {
  const documentObject = options.document ?? globalThis.document;
  const navigatorObject = options.navigator ?? globalThis.navigator;
  const windowObject = options.window ?? globalThis.window;

  if (!documentObject || !windowObject) {
    return { status: "unavailable", count: 0, message: "WebMCP requires a browser page." };
  }

  await afterPageLoad(documentObject, windowObject);

  try {
    (options.initializePolyfill ?? initializeStrictWebMcpPolyfill)();
  } catch (error) {
    return {
      status: "failed",
      count: 0,
      message: error instanceof Error ? error.message : "The WebMCP polyfill failed to initialize.",
    };
  }

  const context = safeModelContext(documentObject, navigatorObject);
  if (!context) {
    return {
      status: "unavailable",
      count: 0,
      message: "This browser does not expose WebMCP tools.",
    };
  }

  const client = options.client ?? getRoomClient();
  const tools = createToolDefinitions(client);
  if (tools.length !== TOOL_NAMES.length) {
    return { status: "failed", count: 0, message: "The WebMCP tool set is incomplete." };
  }

  try {
    await Promise.all(
      tools.map((tool) =>
        Promise.resolve(context.registerTool(tool, { signal: controller.signal })),
      ),
    );
    windowObject.addEventListener("pagehide", () => controller.abort(), { once: true });
    return { status: "registered", count: tools.length };
  } catch (error) {
    controller.abort();
    return {
      status: "failed",
      count: 0,
      message: error instanceof Error ? error.message : "Tool registration failed.",
    };
  }
}

export function registerWarRoomToolsOnce(
  options: RegisterWarRoomToolsOptions = {},
): Promise<RegistrationResult> {
  const root = globalThis as GlobalRegistrationState;
  if (root.__MULTICOM_WEBMCP_REGISTRATION__) {
    return root.__MULTICOM_WEBMCP_REGISTRATION__.promise;
  }

  const controller = new AbortController();
  const promise = performRegistration(controller, options);
  root.__MULTICOM_WEBMCP_REGISTRATION__ = { controller, promise };
  void promise.then((result) => {
    if (
      result.status !== "registered" &&
      root.__MULTICOM_WEBMCP_REGISTRATION__?.promise === promise
    ) {
      delete root.__MULTICOM_WEBMCP_REGISTRATION__;
    }
  });
  return promise;
}

export { safeModelContext as detectModelContext };
