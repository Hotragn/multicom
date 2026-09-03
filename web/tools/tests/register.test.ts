import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../../../shared/tools.ts";
import { RoomClient } from "../room-client.ts";
import { detectModelContext, registerWarRoomToolsOnce } from "../register.ts";
import type { ModelContextLike, ModelContextTool } from "../webmcp-types.ts";
import { FakeSocket } from "./fake-socket.ts";

function clearRegistration(): void {
  delete (globalThis as typeof globalThis & {
    __MULTICOM_WEBMCP_REGISTRATION__?: unknown;
  }).__MULTICOM_WEBMCP_REGISTRATION__;
}

function fakeClient(): RoomClient {
  return new RoomClient({
    url: "ws://example.test/rooms/p1-storefront/ws",
    socketFactory: () => new FakeSocket(),
    autoReconnect: false,
  });
}

test("prefers document.modelContext and falls back to navigator", () => {
  const documentContext = { registerTool() {} } satisfies ModelContextLike;
  const navigatorContext = { registerTool() {} } satisfies ModelContextLike;
  assert.equal(
    detectModelContext(
      { modelContext: documentContext } as unknown as Document,
      { modelContext: navigatorContext } as unknown as Navigator,
    ),
    documentContext,
  );
  assert.equal(
    detectModelContext(
      {} as Document,
      { modelContext: navigatorContext } as unknown as Navigator,
    ),
    navigatorContext,
  );
  assert.equal(detectModelContext({} as Document, {} as Navigator), null);
});

test("initializes the polyfill before detection and registers once after load", async () => {
  clearRegistration();
  const tools: ModelContextTool[] = [];
  const context: ModelContextLike = {
    registerTool(tool) {
      tools.push(tool);
    },
  };
  const fakeDocument = { readyState: "loading" } as unknown as Document;
  const listeners = new Map<string, (event: unknown) => void>();
  const fakeWindow = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
  } as unknown as Window;
  let initialized = false;

  const first = registerWarRoomToolsOnce({
    client: fakeClient(),
    document: fakeDocument,
    navigator: {} as Navigator,
    window: fakeWindow,
    initializePolyfill: () => {
      initialized = true;
      Object.defineProperty(fakeDocument, "modelContext", { value: context });
    },
  });
  const second = registerWarRoomToolsOnce({
    client: fakeClient(),
    document: fakeDocument,
    navigator: {} as Navigator,
    window: fakeWindow,
    initializePolyfill: () => {
      throw new Error("must not initialize twice");
    },
  });

  assert.equal(first, second);
  assert.equal(initialized, false);
  assert.equal(tools.length, 0);
  listeners.get("load")?.({});
  const result = await first;
  assert.equal(initialized, true);
  assert.deepEqual(result, { status: "registered", count: TOOL_NAMES.length });
  assert.equal(tools.length, TOOL_NAMES.length);
});

test("absence of both modelContext surfaces is a graceful no-op", async () => {
  clearRegistration();
  const result = await registerWarRoomToolsOnce({
    client: fakeClient(),
    document: { readyState: "complete" } as unknown as Document,
    navigator: {} as Navigator,
    window: { addEventListener() {} } as unknown as Window,
    initializePolyfill: () => {},
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.count, 0);
});
