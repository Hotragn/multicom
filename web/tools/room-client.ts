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
import { ACTION_LIBRARY, CHECK_IDS } from "../../shared/tools.ts";
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

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBoundedString = (value: unknown, maximum = 1_024): value is string =>
  typeof value === "string" && value.length <= maximum;

const isId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[A-Za-z0-9_-]+$/.test(value);

const isStringArray = (value: unknown, maximumItems: number, maximumLength: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= maximumItems &&
  value.every((item) => isBoundedString(item, maximumLength));

function isVoteRecord(value: unknown): value is Record<string, VoteChoice> {
  if (!isRecord(value) || Object.keys(value).length > 12) return false;
  return Object.entries(value).every(
    ([memberId, choice]) => isId(memberId) && (choice === "yes" || choice === "no"),
  );
}

// Rationales are peer-authored prose, so they get the same bounded treatment
// as every other untrusted string that reaches the page.
function isRationaleRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length > 12) return false;
  return Object.entries(value).every(
    ([memberId, text]) => isId(memberId) && isBoundedString(text, 240),
  );
}

function isServiceStatus(value: unknown): value is ServiceStatus {
  if (!isRecord(value) || !isFiniteNumber(value.errorRate) || !isFiniteNumber(value.p99ms)) return false;
  if (!isBoundedString(value.currentDeploy, 120) || !isRecord(value.flagStates)) return false;
  if (Object.keys(value.flagStates).length > 32 || !Object.values(value.flagStates).every((flag) => typeof flag === "boolean")) return false;
  return isRecord(value.pool) && isFiniteNumber(value.pool.inUse) && isFiniteNumber(value.pool.max);
}

function isRoomState(value: unknown): value is RoomState {
  if (!isRecord(value) || !isId(value.id)) return false;
  if (!["triage", "diagnosing", "mitigating", "resolved"].includes(String(value.phase))) return false;
  if (!isFiniteNumber(value.incidentStartedAt) || !(value.resolvedAt === null || isFiniteNumber(value.resolvedAt))) return false;
  if (!Array.isArray(value.members) || value.members.length > 30 || !value.members.every((member) =>
    isRecord(member) && isId(member.id) && isBoundedString(member.name, 40) &&
    (member.role === "commander" || member.role === "responder") && typeof member.agentActive === "boolean"
  )) return false;
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 5 || !value.hypotheses.every((hypothesis) =>
    isRecord(hypothesis) && isId(hypothesis.id) && isId(hypothesis.by) &&
    isBoundedString(hypothesis.title, 120) && isBoundedString(hypothesis.evidence, 400) &&
    isFiniteNumber(hypothesis.confidence) && hypothesis.confidence >= 0 && hypothesis.confidence <= 1 &&
    (hypothesis.openedAt === undefined ||
      (isFiniteNumber(hypothesis.openedAt) && hypothesis.openedAt >= 0 && hypothesis.openedAt <= 1)) &&
    (hypothesis.revisedBecause === undefined || isBoundedString(hypothesis.revisedBecause, 240)) &&
    Array.isArray(hypothesis.rebuttals) && hypothesis.rebuttals.length <= 10 && hypothesis.rebuttals.every((rebuttal) =>
      isRecord(rebuttal) && isId(rebuttal.by) && isBoundedString(rebuttal.evidence, 400)
    ) && isVoteRecord(hypothesis.votes) && isRationaleRecord(hypothesis.rationales)
  )) return false;
  if (!Array.isArray(value.mitigations) || value.mitigations.length > 3 || !value.mitigations.every((mitigation) =>
    isRecord(mitigation) && isId(mitigation.id) && isId(mitigation.hypothesisId) &&
    typeof mitigation.actionId === "string" && (ACTION_LIBRARY as readonly string[]).includes(mitigation.actionId) &&
    isBoundedString(mitigation.blastRadius, 200) && isVoteRecord(mitigation.votes) &&
    isRationaleRecord(mitigation.rationales) &&
    typeof mitigation.passed === "boolean"
  )) return false;
  if (!Array.isArray(value.appliedActions) || value.appliedActions.length > ACTION_LIBRARY.length || !value.appliedActions.every((action) =>
    typeof action === "string" && (ACTION_LIBRARY as readonly string[]).includes(action)
  )) return false;
  return Array.isArray(value.log) && value.log.length <= 60 && value.log.every((entry) =>
    isRecord(entry) && isFiniteNumber(entry.t) && isBoundedString(entry.text, 180)
  );
}

function isCheckResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.checkId !== "string" || !(CHECK_IDS as readonly string[]).includes(value.checkId)) return false;
  switch (value.checkId) {
    case "pool_in_use":
      return isFiniteNumber(value.inUse) && isFiniteNumber(value.max);
    case "flag_states":
      return isRecord(value.flags) && Object.keys(value.flags).length <= 32 && Object.values(value.flags).every((flag) => typeof flag === "boolean");
    case "deploy_diff":
      return isBoundedString(value.deploy, 120) && isStringArray(value.changes, 40, 500);
    case "error_timeline":
      return Array.isArray(value.points) && value.points.length <= 120 && value.points.every((point) =>
        isRecord(point) && isFiniteNumber(point.t) && isFiniteNumber(point.errorRate)
      );
    default:
      return false;
  }
}

function isToolResultData(value: unknown): value is ToolResultData {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "room_state": return isRoomState(value.state);
    case "service_status": return isServiceStatus(value.status);
    case "logs": return value.untrustedContentHint === true && isStringArray(value.lines, 200, 2_000);
    case "check": return isCheckResult(value.result);
    case "hypothesis": return isId(value.hypothesisId);
    case "counter": return isId(value.hypothesisId);
    case "revision":
      return isId(value.hypothesisId) &&
        isFiniteNumber(value.confidence) &&
        isFiniteNumber(value.openedAt);
    case "mitigation": return isId(value.mitigationId);
    case "vote": return isFiniteNumber(value.yes) && isFiniteNumber(value.no) && typeof value.passed === "boolean";
    case "rationale": return isId(value.targetId) && isFiniteNumber(value.count);
    case "confirm": return typeof value.approved === "boolean";
    case "apply": return typeof value.applied === "boolean" && isServiceStatus(value.status);
    default: return false;
  }
}

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string" || raw.length > 256_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

    switch (parsed.type) {
      case "joined":
        return isId(parsed.memberId) && isRoomState(parsed.state)
          ? (parsed as unknown as ServerMessage)
          : null;
      case "state":
        return isRoomState(parsed.state) ? (parsed as unknown as ServerMessage) : null;
      case "event":
        return isBoundedString(parsed.text, 180) ? (parsed as unknown as ServerMessage) : null;
      case "status":
        return isServiceStatus(parsed)
          ? (parsed as unknown as ServerMessage)
          : null;
      case "confirm_request":
        return isId(parsed.confirmationId) &&
          isId(parsed.mitigationId) &&
          typeof parsed.actionId === "string" && (ACTION_LIBRARY as readonly string[]).includes(parsed.actionId) &&
          isBoundedString(parsed.actionSummary, 240) &&
          isFiniteNumber(parsed.expiresAt)
          ? (parsed as unknown as ServerMessage)
          : null;
      case "tool_result":
        return isBoundedString(parsed.requestId, 64) && isToolResultData(parsed.data)
          ? (parsed as unknown as ServerMessage)
          : null;
      case "error":
        return (parsed.requestId === undefined || isBoundedString(parsed.requestId, 64)) &&
          isBoundedString(parsed.code, 80) &&
          isBoundedString(parsed.message, 500)
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
  private watching = false;
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

  // Open the room and read the board and live health without joining, so the
  // page shows the incident to someone who opened the link before any agent
  // attached. Writes still require join_room.
  async watch(): Promise<void> {
    this.watching = true;
    await this.ensureOpen(false);
    await this.hydrate();
  }

  private async hydrate(): Promise<void> {
    if (this.memberId) return;
    try {
      await this.dispatchRequest((requestId) => ({ type: "get_room_state", requestId }), "room_state");
    } catch {
      // Not fatal: the room pushes state on its next broadcast anyway.
    }
    try {
      await this.dispatchRequest((requestId) => ({ type: "get_service_status", requestId }), "service_status");
    } catch {
      // Status also arrives on the push channel once a viewer is connected.
    }
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
    await raceWithSignal(this.ensureOpen(this.reconnectAttempts > 0), signal);
    return this.dispatchRequest(
      (requestId) => ({ type: "get_room_state", requestId }),
      "room_state",
      signal,
    );
  }

  async getServiceStatus(signal?: AbortSignal): Promise<ToolResultData> {
    await raceWithSignal(this.ensureOpen(this.reconnectAttempts > 0), signal);
    return this.dispatchRequest(
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

  async reviseHypothesis(
    hypothesisId: string,
    confidence: number,
    because: string | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({
        type: "revise",
        requestId,
        hypothesisId,
        confidence,
        ...(because === undefined ? {} : { because }),
      }),
      "revision",
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

  async explainVote(
    targetId: string,
    rationale: string,
    signal?: AbortSignal,
  ): Promise<ToolResultData> {
    return this.request(
      (requestId) => ({ type: "explain_vote", requestId, targetId, rationale }),
      "rationale",
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
    return this.dispatchRequest(createMessage, expectedKind, signal, timeoutMs);
  }

  private async dispatchRequest(
    createMessage: (requestId: string) => ClientMessage,
    expectedKind: ToolResultData["kind"],
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<ToolResultData> {
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
      if (message.data.kind === "room_state") this.latestState = message.data.state;
      if (message.data.kind === "service_status") this.latestStatus = message.data.status;
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
    if (this.intentionallyClosed || !this.autoReconnect || (!this.credentials && !this.watching)) {
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
        else if (this.watching) await this.hydrate();
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
  commanderToken?: string,
): string {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("Room server URL must use http:, https:, ws:, or wss:.");
  }
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = "";
  if (demo) url.searchParams.set("demo", "1");
  if (commanderToken) url.searchParams.set("commander", commanderToken);
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
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    throw new RoomClientError(
      "missing_room_url",
      "Set VITE_ROOM_WS_URL to the deployed room Worker origin.",
    );
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
