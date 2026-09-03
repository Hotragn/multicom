import { ROOM_ID } from "../../shared/scenario.ts";
import type {
  ClientMessage,
  RoomState,
  ServerMessage,
  ServiceStatus,
  ToolResultData,
} from "../../shared/ws-messages.ts";
import type {
  ActionId,
  CheckId,
  LogWindow,
  RoomRole,
  VoteChoice,
} from "../../shared/tools.ts";
import { abortError, RoomClientError } from "./errors.ts";

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const MAX_PENDING_REQUESTS = 64;
const CONFIRM_TIMEOUT_MS = 65_000;

export type RoomConnectionPhase =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export interface RoomConnectionState {
  state: RoomConnectionPhase;
  message?: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface RoomClientOptions {
  url: string;
  socketFactory?: (url: string) => WebSocketLike;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  idFactory?: () => string;
}

interface PendingRequest {
  expectedKind: ToolResultData["kind"];
  resolve: (data: ToolResultData) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface JoinResult {
  memberId: string;
  state: RoomState;
}

interface JoinSettler {
  resolve: (result: JoinResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JoinCredentials {
  name: string;
  role: RoomRole;
}

type MessageListener = (message: ServerMessage) => void;
type ConnectionListener = (state: RoomConnectionState) => void;

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function randomRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string" || raw.length > 256_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

    switch (parsed.type) {
      case "joined":
        return typeof parsed.memberId === "string" && isRecord(parsed.state)
          ? (parsed as unknown as ServerMessage)
          : null;
      case "state":
        return isRecord(parsed.state) ? (parsed as unknown as ServerMessage) : null;
      case "event":
        return typeof parsed.text === "string" ? (parsed as unknown as ServerMessage) : null;
      case "status":
        return typeof parsed.errorRate === "number" && typeof parsed.p99ms === "number"
          ? (parsed as unknown as ServerMessage)
          : null;
      case "confirm_request":
        return typeof parsed.confirmationId === "string" &&
          typeof parsed.mitigationId === "string" &&
          typeof parsed.actionId === "string" &&
          typeof parsed.actionSummary === "string" &&
          typeof parsed.expiresAt === "number"
          ? (parsed as unknown as ServerMessage)
          : null;
      case "tool_result":
        return typeof parsed.requestId === "string" &&
          isRecord(parsed.data) &&
          typeof parsed.data.kind === "string"
          ? (parsed as unknown as ServerMessage)
          : null;
      case "error":
        return (parsed.requestId === undefined || typeof parsed.requestId === "string") &&
          typeof parsed.code === "string" &&
          typeof parsed.message === "string"
          ? (parsed as unknown as ServerMessage)
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function eventData(event: unknown): unknown {
  return isRecord(event) && "data" in event ? event.data : undefined;
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const abortListener = () => reject(abortError());
    signal.addEventListener("abort", abortListener, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abortListener);
    });
  });
}

export class RoomClient {
  readonly url: string;

  private readonly socketFactory: (url: string) => WebSocketLike;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly idFactory: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();

  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private joinPromise: Promise<JoinResult> | null = null;
  private joinSettler: JoinSettler | null = null;
  private credentials: JoinCredentials | null = null;
  private memberId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private currentConnectionState: RoomConnectionState = { state: "closed" };
  private latestState: RoomState | null = null;
  private latestStatus: ServiceStatus | null = null;
  private latestConfirmation: Extract<ServerMessage, { type: "confirm_request" }> | null = null;

  constructor(options: RoomClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new TypeError("RoomClient URL must use ws: or wss:.");
    }
    this.url = parsed.toString();
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.idFactory = options.idFactory ?? randomRequestId;
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    if (this.latestState) listener({ type: "state", state: this.latestState });
    if (this.latestStatus) listener({ type: "status", ...this.latestStatus });
    if (
      this.latestConfirmation &&
      this.latestConfirmation.expiresAt > Math.floor(Date.now() / 1_000)
    ) {
      listener(this.latestConfirmation);
    }
    return () => this.listeners.delete(listener);
  }

  subscribeConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.currentConnectionState);
    return () => this.connectionListeners.delete(listener);
  }

  async connect(): Promise<void> {
    await this.ensureOpen(false);
  }

  async join(name: string, role: RoomRole, signal?: AbortSignal): Promise<JoinResult> {
    const nextCredentials = { name, role };
    if (
      this.memberId &&
      this.latestState &&
      this.credentials?.name === name &&
      this.credentials.role === role
    ) {
      return { memberId: this.memberId, state: this.latestState };
    }
    if (
      this.memberId &&
      this.credentials &&
      (this.credentials.name !== name || this.credentials.role !== role)
    ) {
      throw new RoomClientError("already_joined", "This page has already joined the room.");
    }

    this.credentials = nextCredentials;
    await raceWithSignal(this.ensureOpen(false), signal);
    return raceWithSignal(this.sendJoin(nextCredentials), signal);
  }

  async getRoomState(signal?: AbortSignal): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "get_room_state", requestId }),
      "room_state",
      signal,
    );
  }

  async getServiceStatus(signal?: AbortSignal): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "get_service_status", requestId }),
      "service_status",
      signal,
    );
  }

  async queryLogs(
    service: string,
    window: LogWindow,
    filter: string | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({
        type: "query_logs",
        requestId,
        service,
        window,
        ...(filter === undefined ? {} : { filter }),
      }),
      "logs",
      signal,
    );
  }

  async runCheck(checkId: CheckId, signal?: AbortSignal): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "run_check", requestId, checkId }),
      "check",
      signal,
    );
  }

  async proposeHypothesis(
    title: string,
    evidence: string,
    confidence: number,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({
        type: "propose_hypothesis",
        requestId,
        title,
        evidence,
        confidence,
      }),
      "hypothesis",
      signal,
    );
  }

  async counterHypothesis(
    hypothesisId: string,
    evidence: string,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "counter", requestId, hypothesisId, evidence }),
      "counter",
      signal,
    );
  }

  async proposeMitigation(
    hypothesisId: string,
    actionId: ActionId,
    blastRadius: string,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({
        type: "propose_mitigation",
        requestId,
        hypothesisId,
        actionId,
        blastRadius,
      }),
      "mitigation",
      signal,
    );
  }

  async vote(
    targetId: string,
    choice: VoteChoice,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "vote", requestId, targetId, choice }),
      "vote",
      signal,
    );
  }

  async requestHumanConfirm(
    mitigationId: string,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "request_confirm", requestId, mitigationId }),
      "confirm",
      signal,
      CONFIRM_TIMEOUT_MS,
    );
  }

  async applyMitigation(actionId: ActionId, signal?: AbortSignal): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "apply", requestId, actionId }),
      "apply",
      signal,
    );
  }

  async confirm(confirmationId: string, approved: boolean): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(confirmationId) || typeof approved !== "boolean") {
      throw new RoomClientError("invalid_confirmation", "The confirmation response is invalid.");
    }
    await this.ensureSession();
    this.send({ type: "confirm", confirmationId, approved });
    if (this.latestConfirmation?.confirmationId === confirmationId) {
      this.latestConfirmation = null;
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failAll(new RoomClientError("connection_closed", "The room connection was closed."));
    this.rejectJoin(new RoomClientError("connection_closed", "The room connection was closed."));
    if (this.socket && this.socket.readyState < SOCKET_CLOSING) {
      this.socket.close(1000, "Client closed");
    }
    this.socket = null;
    this.memberId = null;
    this.emitConnection({ state: "closed" });
  }

  private async request(
    createMessage: (requestId: string) => ClientMessage,
    expectedKind: ToolResultData["kind"],
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<ToolResultData> {
    await this.ensureSession(signal);
    if (signal?.aborted) throw abortError();
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new RoomClientError("too_many_requests", "Too many tool calls are still pending.");
    }

    let requestId = this.idFactory();
    for (let attempt = 0; this.pending.has(requestId) && attempt < 8; attempt += 1) {
      requestId = this.idFactory();
    }
    if (this.pending.has(requestId)) {
      throw new RoomClientError("request_id_collision", "Could not allocate a unique request id.");
    }

    return new Promise<ToolResultData>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.settlePending(
          requestId,
          new RoomClientError("request_timeout", "The room did not answer this tool call in time."),
        );
      }, timeoutMs);
      const pending: PendingRequest = {
        expectedKind,
        resolve,
        reject,
        timeout,
        ...(signal ? { signal } : {}),
      };

      if (signal) {
        pending.abortListener = () => this.settlePending(requestId, abortError());
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }

      this.pending.set(requestId, pending);
      try {
        this.send(createMessage(requestId));
      } catch (error) {
        this.settlePending(
          requestId,
          error instanceof Error ? error : new RoomClientError("send_failed", "Tool request failed."),
        );
      }
    });
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    await raceWithSignal(this.ensureOpen(this.reconnectAttempts > 0), signal);
    if (this.memberId) return;
    if (!this.credentials) {
      throw new RoomClientError("not_joined", "Call join_room before using other room tools.");
    }
    await raceWithSignal(this.sendJoin(this.credentials), signal);
  }

  private ensureOpen(reconnecting: boolean): Promise<void> {
    if (this.socket?.readyState === SOCKET_OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.intentionallyClosed = false;
    this.emitConnection({ state: reconnecting ? "reconnecting" : "connecting" });

    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.handleMessage(event);
    });
    socket.addEventListener("close", () => this.handleClose(socket));

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onCloseBeforeOpen);
      };
      const onOpen = () => {
        cleanup();
        this.reconnectAttempts = 0;
        this.emitConnection({ state: "open" });
        resolve();
      };
      const onError = () => {
        cleanup();
        const error = new RoomClientError("connection_failed", "Could not connect to the incident room.");
        this.emitConnection({ state: "error", message: error.message });
        if (socket.readyState < SOCKET_CLOSING) socket.close(1011, "Connection failed");
        reject(error);
      };
      const onCloseBeforeOpen = () => {
        cleanup();
        reject(new RoomClientError("connection_failed", "The room connection closed before opening."));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onCloseBeforeOpen);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private sendJoin(credentials: JoinCredentials): Promise<JoinResult> {
    if (this.memberId && this.latestState) {
      return Promise.resolve({ memberId: this.memberId, state: this.latestState });
    }
    if (this.joinPromise) return this.joinPromise;

    this.joinPromise = new Promise<JoinResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectJoin(new RoomClientError("join_timeout", "The room did not accept the join in time."));
      }, this.requestTimeoutMs);
      this.joinSettler = { resolve, reject, timeout };
      try {
        this.send({ type: "join", ...credentials });
      } catch (error) {
        this.rejectJoin(
          error instanceof Error ? error : new RoomClientError("send_failed", "Join request failed."),
        );
      }
    }).finally(() => {
      this.joinPromise = null;
    });

    return this.joinPromise;
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new RoomClientError("connection_closed", "The room connection is not open.");
    }
    this.socket.send(JSON.stringify(message));
  }

  private readonly handleMessage = (event: unknown): void => {
    const message = parseServerMessage(eventData(event));
    if (!message) return;

    if (message.type === "joined") {
      this.memberId = message.memberId;
      this.latestState = message.state;
      if (this.joinSettler) {
        const settler = this.joinSettler;
        this.joinSettler = null;
        clearTimeout(settler.timeout);
        settler.resolve({ memberId: message.memberId, state: message.state });
      }
    } else if (message.type === "state") {
      this.latestState = message.state;
    } else if (message.type === "status") {
      const { type: _type, ...status } = message;
      this.latestStatus = status;
    } else if (message.type === "confirm_request") {
      this.latestConfirmation = message;
    } else if (message.type === "tool_result") {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        if (message.data.kind !== pending.expectedKind) {
          this.settlePending(
            message.requestId,
            new RoomClientError(
              "unexpected_result",
              `Expected ${pending.expectedKind}, received ${message.data.kind}.`,
            ),
          );
        } else {
          this.settlePending(message.requestId, null, message.data);
        }
      }
    } else if (message.type === "error") {
      const error = new RoomClientError(message.code, message.message);
      if (message.requestId) this.settlePending(message.requestId, error);
      else if (this.joinSettler) this.rejectJoin(error);
    }

    this.emitMessage(message);
  };

  private handleClose(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.memberId = null;
    this.failAll(new RoomClientError("connection_lost", "The room connection was interrupted."));
    this.rejectJoin(new RoomClientError("connection_lost", "The room connection was interrupted."));
    if (this.intentionallyClosed || !this.autoReconnect || !this.credentials) {
      this.emitConnection({ state: "closed" });
      return;
    }
    this.scheduleReconnect();
  }

  private settlePending(
    requestId: string,
    error: Error | null,
    data?: ToolResultData,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (error) pending.reject(error);
    else if (data) pending.resolve(data);
    else pending.reject(new RoomClientError("empty_result", "The room returned no result."));
  }

  private failAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settlePending(requestId, error);
    }
  }

  private rejectJoin(error: Error): void {
    if (!this.joinSettler) return;
    const settler = this.joinSettler;
    this.joinSettler = null;
    clearTimeout(settler.timeout);
    settler.reject(error);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(250 * 2 ** (this.reconnectAttempts - 1), 5_000);
    this.emitConnection({ state: "reconnecting" });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.ensureOpen(true);
        if (this.credentials) await this.sendJoin(this.credentials);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private emitMessage(message: ServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Room message listener failed", error);
      }
    }
  }

  private emitConnection(state: RoomConnectionState): void {
    this.currentConnectionState = state;
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch (error) {
        console.error("Room connection listener failed", error);
      }
    }
  }
}

export function buildRoomWebSocketUrl(
  baseUrl: string,
  roomId: string = ROOM_ID,
  demo = typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1",
): string {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("Room server URL must use http:, https:, ws:, or wss:.");
  }
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = demo ? "?demo=1" : "";
  url.hash = "";
  return url.toString();
}

export function defaultRoomWebSocketUrl(): string {
  if (globalThis.__MULTICOM_ROOM_WS_URL__) {
    const configured = new URL(globalThis.__MULTICOM_ROOM_WS_URL__);
    if (/\/rooms\/[^/]+\/ws$/.test(configured.pathname)) return configured.toString();
    return buildRoomWebSocketUrl(configured.toString());
  }
  if (typeof location === "undefined") {
    throw new RoomClientError("missing_room_url", "A room WebSocket URL is required.");
  }
  return buildRoomWebSocketUrl(location.origin);
}

const SHARED_CLIENT_KEY = Symbol.for("multicom.room-client");
type GlobalWithRoomClient = typeof globalThis & { [SHARED_CLIENT_KEY]?: RoomClient };

export function getRoomClient(options?: RoomClientOptions): RoomClient {
  const root = globalThis as GlobalWithRoomClient;
  const url = options?.url ?? defaultRoomWebSocketUrl();
  if (root[SHARED_CLIENT_KEY]) {
    const normalized = new URL(url).toString();
    if (root[SHARED_CLIENT_KEY].url !== normalized) {
      throw new RoomClientError(
        "room_client_conflict",
        "The shared room client is already configured for another URL.",
      );
    }
    return root[SHARED_CLIENT_KEY];
  }
  root[SHARED_CLIENT_KEY] = new RoomClient({ ...options, url });
  return root[SHARED_CLIENT_KEY];
}
