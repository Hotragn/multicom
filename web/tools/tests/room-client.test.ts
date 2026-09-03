import assert from "node:assert/strict";
import test from "node:test";
import { FAULTY_STATUS } from "../../../shared/scenario.ts";
import type { RoomState } from "../../../shared/ws-messages.ts";
import { RoomClient } from "../room-client.ts";
import { FakeSocket } from "./fake-socket.ts";

const EMPTY_STATE: RoomState = {
  id: "p1-storefront",
  phase: "triage",
  incidentStartedAt: 1,
  resolvedAt: null,
  members: [],
  hypotheses: [],
  mitigations: [],
  appliedActions: [],
  log: [],
};

function setupClient(): { client: RoomClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  let nextId = 0;
  const client = new RoomClient({
    url: "ws://example.test/rooms/p1-storefront/ws",
    socketFactory: () => socket,
    autoReconnect: false,
    requestTimeoutMs: 500,
    idFactory: () => `request-${++nextId}`,
  });
  return { client, socket };
}

async function waitForSent(socket: FakeSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && socket.sent.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(socket.sent.length >= count, `Expected ${count} outbound messages`);
}

async function join(client: RoomClient, socket: FakeSocket): Promise<void> {
  const promise = client.join("Priya", "commander");
  socket.open();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(socket.sent[0] ?? "null"), {
    type: "join",
    name: "Priya",
    role: "commander",
  });
  socket.receive({ type: "joined", memberId: "member-1", state: EMPTY_STATE });
  await promise;
}

test("requires join_room before post-join tool requests", async () => {
  const { client, socket } = setupClient();
  const request = client.getRoomState();
  socket.open();
  await assert.rejects(request, (error: unknown) => {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "not_joined"
    );
  });
});

test("correlates concurrent responses by requestId even when reversed", async () => {
  const { client, socket } = setupClient();
  await join(client, socket);

  const statusPromise = client.getServiceStatus();
  const checkPromise = client.runCheck("pool_in_use");
  await waitForSent(socket, 3);
  const statusRequest = JSON.parse(socket.sent[1] ?? "null") as { requestId: string };
  const checkRequest = JSON.parse(socket.sent[2] ?? "null") as { requestId: string };

  socket.receive({
    type: "tool_result",
    requestId: checkRequest.requestId,
    data: { kind: "check", result: { checkId: "pool_in_use", inUse: 1, max: 1 } },
  });
  socket.receive({
    type: "tool_result",
    requestId: statusRequest.requestId,
    data: { kind: "service_status", status: FAULTY_STATUS },
  });

  assert.equal((await checkPromise).kind, "check");
  assert.equal((await statusPromise).kind, "service_status");
});

test("rejects a mismatched result kind instead of confusing tool calls", async () => {
  const { client, socket } = setupClient();
  await join(client, socket);
  const request = client.getServiceStatus();
  await waitForSent(socket, 2);
  const outbound = JSON.parse(socket.sent[1] ?? "null") as { requestId: string };
  socket.receive({
    type: "tool_result",
    requestId: outbound.requestId,
    data: { kind: "vote", yes: 1, no: 0, passed: true },
  });
  await assert.rejects(request, /Expected service_status, received vote/);
});

test("honors AbortSignal and ignores the eventual stale response", async () => {
  const { client, socket } = setupClient();
  await join(client, socket);
  const controller = new AbortController();
  const request = client.getRoomState(controller.signal);
  await waitForSent(socket, 2);
  const outbound = JSON.parse(socket.sent[1] ?? "null") as { requestId: string };
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === "AbortError");
  socket.receive({
    type: "tool_result",
    requestId: outbound.requestId,
    data: { kind: "room_state", state: EMPTY_STATE },
  });
});

test("shares broadcasts with UI subscribers and sends human confirmation", async () => {
  const { client, socket } = setupClient();
  await join(client, socket);
  const seen: string[] = [];
  client.subscribe((message) => seen.push(message.type));

  socket.receive({ type: "status", ...FAULTY_STATUS });
  socket.receive({
    type: "confirm_request",
    confirmationId: "confirmation-1",
    mitigationId: "mitigation-1",
    actionId: "scale_pool:default",
    actionSummary: "Restore the DB pool to 50 connections.",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  });
  await client.confirm("confirmation-1", true);

  assert.deepEqual(seen, ["state", "status", "confirm_request"]);
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? "null"), {
    type: "confirm",
    confirmationId: "confirmation-1",
    approved: true,
  });
});
