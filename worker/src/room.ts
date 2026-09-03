import { DurableObject } from "cloudflare:workers";
import { ACTION_LIBRARY, ACTION_SUMMARIES, type ActionId, type CheckId } from "../../shared/tools";
import { ROOM_ID, SERVICE_NAME } from "../../shared/scenario";
import { isMintedRoomId, isRoomId } from "../../shared/tenancy";
import type {
  CheckResult,
  ClientMessage,
  Member,
  RoomState,
  ServerMessage,
  ServiceStatus,
  ToolResultData,
} from "../../shared/ws-messages";
import { activeMemberIds, mitigationTally, recomputeMitigations, tally, truncate } from "./domain";
import { parseClientMessage, ProtocolError } from "./protocol";
import { targetRequestHeaders } from "./target-request";

export interface RoomEnv {
  TARGET?: Fetcher;
  TARGET_ORIGIN?: string;
  TARGET_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  COMMANDER_TOKEN?: string;
}

interface ConnectionAttachment {
  connectionId: string;
  memberId?: string;
  demo: boolean;
  canCommand: boolean;
}

interface PendingConfirmation {
  confirmationId: string;
  mitigationId: string;
  actionId: ActionId;
  requestId: string;
  requesterMemberId: string;
  expiresAt: number;
}

interface Approval {
  confirmationId: string;
  mitigationId: string;
  actionId: ActionId;
  commanderMemberId: string;
  approvedAt: number;
  expiresAt: number;
}

interface BotState {
  enabled: boolean;
  humanJoinedAt: number | null;
  memberId: string | null;
  hypothesisId: string | null;
  realEvidenceSeen: boolean;
  countered: boolean;
}

interface RequestRecord {
  fingerprint: string;
  response?: ServerMessage;
  updatedAt: number;
}

interface StoredRoom {
  /**
   * The room id this object serves. `ctx.id.name` supplies it when the stub was
   * built with `idFromName`, but it is persisted as well so the tenant a target
   * call is scoped to never depends on a runtime property being populated.
   */
  roomId?: string;
  /**
   * True for a room the lobby provisioned for one visitor. The first connection
   * to claim `commander` in such a room gets the seat with no shared secret.
   * Set by the server only — never read from a query string or client message.
   */
  selfServe?: boolean;
  state: RoomState;
  nextMember: number;
  nextHypothesis: number;
  nextMitigation: number;
  nextConfirmation: number;
  pending: Record<string, PendingConfirmation>;
  approvals: Record<string, Approval>;
  requestLog: Record<string, Record<string, RequestRecord>>;
  bot: BotState;
}

interface Session {
  memberId: string | undefined;
  readonly demo: boolean;
  readonly isBot: boolean;
  canCommand: boolean;
  send(message: ServerMessage): void;
  bindMember(memberId: string): void;
  /**
   * Grant this connection the commander capability. Only reachable when the
   * server has already decided the claim is legitimate: a self-serve room with
   * no commander seated yet.
   */
  grantCommand(): void;
}

// A target that answers 403 is a misconfigured room, not an unreachable
// service. Reporting both as "did not respond" sends an operator hunting for a
// network problem: it cost real debugging time on the first deployment, where
// the room Worker simply had no TARGET_TOKEN.
class TargetError extends Error {
  constructor(readonly status: number) {
    super(`Target returned ${status}.`);
  }
}

interface TargetLogs {
  lines: string[];
  untrustedContentHint: true;
}

const STORE_KEY = "room";
export const INIT_PATH = "/__multicom/init";
const MAX_MEMBERS = 6;
const MAX_HYPOTHESES = 5;
const MAX_MITIGATIONS = 3;
const MAX_REBUTTALS = 10;
const MAX_RATIONALE = 240;
const MAX_ACTIVITY = 60;
const TOOL_RESULT_BUDGET = 2_048;
const APPROVAL_TTL_MS = 60_000;
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1_000;
// A demo room that nobody finished still goes stale: its MTTR keeps climbing,
// so a visitor days later would meet an incident that has been open for days.
const DEMO_STALE_MS = 30 * 60 * 1_000;
const BOT_JOIN_DELAY_MS = 1_000;
const BOT_HYPOTHESIS_DELAY_MS = 9_500;
const MAX_REQUEST_RECORDS_PER_MEMBER = 64;
const MUTATING_REQUESTS = new Set<ClientMessage["type"]>([
  "propose_hypothesis",
  "counter",
  "revise",
  "propose_mitigation",
  "vote",
  "explain_vote",
  "request_confirm",
  "apply",
]);

const isActionId = (value: string): value is ActionId =>
  (ACTION_LIBRARY as readonly string[]).includes(value);

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const constantTimeEqual = (left: string, right: string): boolean => {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};

const emptyRoom = (id: string, selfServe = isMintedRoomId(id)): StoredRoom => ({
  roomId: id,
  selfServe,
  state: {
    id,
    phase: "triage",
    incidentStartedAt: nowSeconds(),
    resolvedAt: null,
    members: [],
    hypotheses: [],
    mitigations: [],
    appliedActions: [],
    log: [],
  },
  nextMember: 1,
  nextHypothesis: 1,
  nextMitigation: 1,
  nextConfirmation: 1,
  pending: {},
  approvals: {},
  requestLog: {},
  bot: {
    enabled: false,
    humanJoinedAt: null,
    memberId: null,
    hypothesisId: null,
    realEvidenceSeen: false,
    countered: false,
  },
});

const encodeSize = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const cloneState = (state: RoomState): RoomState => structuredClone(state);

export class Room extends DurableObject<RoomEnv> {
  private room: StoredRoom;
  private readonly ready: Promise<void>;
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private botJoinTimer: ReturnType<typeof setTimeout> | undefined;
  private botHypothesisTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly applying = new Set<ActionId>();

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    this.room = emptyRoom(ctx.id.name ?? ROOM_ID);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<StoredRoom>(STORE_KEY)) ?? this.room;
      this.room.requestLog ??= {};
      if (!this.room.roomId && ctx.id.name) this.room.roomId = ctx.id.name;
      // Derived from the id shape rather than trusted from a caller, so a room
      // whose storage was reclaimed after an hour empty still knows what it is.
      this.room.selfServe ??= isMintedRoomId(this.room.roomId ?? this.room.state.id);
      for (const hypothesis of this.room.state.hypotheses) hypothesis.rationales ??= {};
      for (const mitigation of this.room.state.mitigations) mitigation.rationales ??= {};
      await this.reconcileConnections();
      this.restoreConfirmationTimers();
      this.scheduleBot();
      if (this.hasActiveViewer() && this.room.state.phase !== "resolved") this.startStatusTimer();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    // Internal hook: the lobby marks a freshly provisioned room self-serve. The
    // public router only forwards `/rooms/<id>/ws`, so no browser can reach it.
    if (request.method === "POST" && url.pathname === INIT_PATH) {
      if (!this.room.selfServe) {
        this.room.selfServe = true;
        await this.persist();
      }
      return new Response(JSON.stringify({ ok: true, selfServe: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }

    await this.captureRoomId(url);
    const configuredToken = this.env.COMMANDER_TOKEN?.trim();
    const presentedToken = url.searchParams.get("commander") ?? "";
    const canCommand = configuredToken
      ? constantTimeEqual(presentedToken, configuredToken)
      : isLoopback(url.hostname);
    const pair = new WebSocketPair();
    const sockets = Object.values(pair);
    const client = sockets[0];
    const server = sockets[1];
    if (!client || !server) return new Response("Unable to create WebSocket.", { status: 500 });

    server.serializeAttachment({
      connectionId: crypto.randomUUID(),
      demo: url.searchParams.get("demo") === "1",
      canCommand,
    } satisfies ConnectionAttachment);
    this.ctx.acceptWebSocket(server);
    if (url.searchParams.get("demo") === "1") this.ctx.waitUntil(this.beginDemoSpectating());
    else this.ctx.waitUntil(this.beginLiveViewing());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    await this.ready;
    if (typeof value !== "string") {
      this.send(socket, { type: "error", code: "invalid_request", message: "Binary messages are not supported." });
      return;
    }

    const attachment = (socket.deserializeAttachment() ?? {
      connectionId: crypto.randomUUID(),
      demo: false,
      canCommand: false,
    }) as ConnectionAttachment;
    const session: Session = {
      memberId: attachment.memberId,
      demo: attachment.demo,
      isBot: false,
      canCommand: attachment.canCommand === true,
      send: (message) => this.send(socket, message),
      bindMember: (memberId) => {
        attachment.memberId = memberId;
        session.memberId = memberId;
        socket.serializeAttachment(attachment);
      },
      grantCommand: () => {
        attachment.canCommand = true;
        session.canCommand = true;
        socket.serializeAttachment(attachment);
      },
    };

    let message: ClientMessage;
    try {
      message = parseClientMessage(value);
    } catch (error) {
      const protocol = error instanceof ProtocolError ? error : new ProtocolError("invalid_request", "Invalid message.");
      session.send({ type: "error", ...(protocol.requestId ? { requestId: protocol.requestId } : {}), code: protocol.code, message: protocol.message });
      return;
    }
    await this.dispatch(session, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready;
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment?.memberId) {
      // A spectator left without ever joining. Stop polling the target once the
      // last browser is gone, otherwise the timer outlives its audience.
      await this.handlePresenceChange(socket);
      return;
    }
    const member = this.member(attachment.memberId);
    if (!member?.agentActive) return;
    member.agentActive = false;
    if (member.role === "commander") this.cancelPendingConfirmations();
    else this.cancelPendingConfirmationsFor(member.id);
    recomputeMitigations(this.room.state);
    this.addActivity(`${member.name} left the war room.`);
    await this.handlePresenceChange(socket);
    await this.persistAndBroadcast(true);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (this.hasActiveViewer()) return;
    this.clearTimers();
    await this.ctx.storage.deleteAll();
    this.room = emptyRoom(this.tenantId(), this.room.selfServe === true);
  }

  private async dispatch(session: Session, message: ClientMessage): Promise<void> {
    if (message.type === "join") {
      await this.join(session, message.name, message.role);
      return;
    }
    if (!session.memberId || !this.member(session.memberId)?.agentActive) {
      // The board and live health are readable before a seat is taken. Writes
      // still require join; joining itself is unauthenticated, so this adds no
      // new visibility beyond what the page already shows a human visitor.
      if (!session.isBot && (message.type === "get_room_state" || message.type === "get_service_status")) {
        if (session.demo) await this.beginDemoSpectating();
        else await this.beginLiveViewing();
        if (message.type === "get_room_state") {
          this.sendToolResult(session, message.requestId, { kind: "room_state", state: cloneState(this.room.state) });
          return;
        }
        const status = await this.targetGet<ServiceStatus>("/status");
        this.sendToolResult(session, message.requestId, { kind: "service_status", status });
        return;
      }
      this.fail(session, "join_required", "Join the room before using this operation.", "requestId" in message ? message.requestId : undefined);
      return;
    }

    if (message.type === "confirm") {
      await this.confirm(session, message.confirmationId, message.approved);
      return;
    }

    if (MUTATING_REQUESTS.has(message.type) && !(await this.beginMutationRequest(session, message))) {
      return;
    }

    const requestId = message.requestId;
    try {
      switch (message.type) {
        case "get_room_state":
          this.sendToolResult(session, requestId, { kind: "room_state", state: cloneState(this.room.state) });
          return;
        case "get_service_status": {
          const status = await this.targetGet<ServiceStatus>("/status");
          this.sendToolResult(session, requestId, { kind: "service_status", status });
          return;
        }
        case "query_logs": {
          const query = new URLSearchParams({ service: message.service, window: message.window });
          if (message.filter) query.set("filter", message.filter);
          const result = await this.targetGet<TargetLogs>(`/logs?${query.toString()}`);
          this.addActivity(`${this.memberName(session)} searched ${message.window} of ${truncate(message.service, 40)} logs.`);
          await this.persistAndBroadcast(true);
          this.sendToolResult(session, requestId, { kind: "logs", lines: result.lines, untrustedContentHint: true });
          return;
        }
        case "run_check": {
          const result = await this.targetGet<CheckResult>(`/checks/${encodeURIComponent(message.checkId)}`);
          this.addActivity(`${this.memberName(session)} ran ${message.checkId}.`);
          if (message.checkId === "error_timeline" || message.checkId === "pool_in_use") {
            this.room.bot.realEvidenceSeen = true;
          }
          await this.persistAndBroadcast(true);
          this.sendToolResult(session, requestId, { kind: "check", result });
          if (this.room.bot.realEvidenceSeen) this.ctx.waitUntil(this.maybeBotCounter());
          return;
        }
        case "propose_hypothesis":
          await this.proposeHypothesis(session, message, requestId);
          return;
        case "counter":
          await this.counterHypothesis(session, message.hypothesisId, message.evidence, requestId);
          return;
        case "revise":
          await this.reviseHypothesis(session, message, requestId);
          return;
        case "propose_mitigation":
          await this.proposeMitigation(session, message.hypothesisId, String(message.actionId), message.blastRadius, requestId);
          return;
        case "vote":
          await this.vote(session, message.targetId, message.choice, requestId);
          return;
        case "explain_vote":
          await this.explainVote(session, message.targetId, message.rationale, requestId);
          return;
        case "request_confirm":
          await this.requestConfirm(session, message.mitigationId, requestId);
          return;
        case "apply":
          await this.apply(session, String(message.actionId), requestId);
          return;
      }
    } catch (error) {
      console.error("Room operation failed", error);
      const denied = error instanceof TargetError && (error.status === 401 || error.status === 403);
      // apply consumes the approval before calling the target, so a failed
      // apply always needs a fresh human decision. Saying "try again" here
      // sends the agent into a needs_human_confirm loop instead.
      const consumedApproval = message.type === "apply";
      if (denied) {
        this.fail(
          session,
          "target_forbidden",
          consumedApproval
            ? "The room is not authorized to call the target. Ask an operator to set TARGET_TOKEN, then get a fresh approval."
            : "The room is not authorized to call the target. Ask an operator to set TARGET_TOKEN.",
          requestId,
        );
        return;
      }
      this.fail(
        session,
        "target_unavailable",
        consumedApproval
          ? "The target did not respond, and the approval is spent. Get a fresh approval before retrying."
          : "The scripted target did not respond. Try again.",
        requestId,
      );
    }
  }

  private async join(session: Session, name: string, role: Member["role"]): Promise<void> {
    if (session.memberId) {
      this.fail(session, "already_joined", "This connection already joined the room.");
      return;
    }
    if (this.room.state.members.filter((member) => member.agentActive).length >= MAX_MEMBERS) {
      this.fail(session, "room_full", "This room already has six active members. Start your own room instead.");
      return;
    }
    if (role === "commander" && this.room.state.members.some((member) => member.agentActive && member.role === "commander")) {
      this.fail(session, "commander_taken", "This room already has an active commander.");
      return;
    }
    if (role === "commander" && !session.canCommand) {
      // A judge with no shared secret has to be able to demonstrate the human
      // approval gate, which is the whole safety claim. In a room the lobby
      // provisioned for one visitor, the first claimer takes the seat and the
      // server grants this connection the capability. Curated rooms are
      // unchanged: they still require COMMANDER_TOKEN.
      if (!this.room.selfServe) {
        this.fail(session, "commander_forbidden", "This connection does not have the commander capability.");
        return;
      }
      session.grantCommand();
    }

    const member: Member = {
      id: `u${this.room.nextMember++}`,
      name,
      role,
      agentActive: true,
    };
    this.room.state.members.push(member);
    session.bindMember(member.id);
    await this.ctx.storage.deleteAlarm();

    if (session.demo && !session.isBot) {
      this.room.bot.enabled = true;
      this.room.bot.humanJoinedAt ??= Date.now();
    }

    recomputeMitigations(this.room.state);
    this.addActivity(`${member.name} joined as ${member.role}.`);
    await this.persist();
    session.send({ type: "joined", memberId: member.id, state: cloneState(this.room.state) });
    this.broadcast({ type: "event", text: this.room.state.log.at(-1)?.text ?? `${member.name} joined.` });
    this.broadcast({ type: "state", state: cloneState(this.room.state) });
    if (!session.isBot) {
      this.startStatusTimer();
      this.ctx.waitUntil(this.broadcastStatus());
    }
    this.scheduleBot();
  }

  private async proposeHypothesis(
    session: Session,
    message: Extract<ClientMessage, { type: "propose_hypothesis" }>,
    requestId: string,
  ): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    if (this.room.state.hypotheses.length >= MAX_HYPOTHESES) {
      this.fail(session, "board_full", "The hypothesis board is full. Vote or counter existing ideas.", requestId);
      return;
    }
    const id = `h${this.room.nextHypothesis++}`;
    this.room.state.hypotheses.push({
      id,
      by: session.memberId!,
      title: message.title,
      evidence: message.evidence,
      confidence: message.confidence,
      rebuttals: [],
      votes: {},
      rationales: {},
    });
    if (this.room.state.phase === "triage") this.room.state.phase = "diagnosing";
    this.addActivity(`${this.memberName(session)} proposed ${truncate(message.title, 72)} (${message.confidence.toFixed(2)}).`);
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, { kind: "hypothesis", hypothesisId: id });
  }

  private async counterHypothesis(session: Session, hypothesisId: string, evidence: string, requestId: string): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const hypothesis = this.room.state.hypotheses.find((candidate) => candidate.id === hypothesisId);
    if (!hypothesis) {
      this.fail(session, "not_found", "That hypothesis does not exist.", requestId);
      return;
    }
    if (hypothesis.rebuttals.length >= MAX_REBUTTALS) {
      this.fail(session, "board_full", "That hypothesis already has enough rebuttals. Vote on it.", requestId);
      return;
    }
    hypothesis.rebuttals.push({ by: session.memberId!, evidence });
    this.addActivity(`${this.memberName(session)} challenged ${truncate(hypothesis.title, 64)}.`);
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, { kind: "counter", hypothesisId });
  }

  /**
   * Let an author move their own confidence as the evidence lands.
   *
   * Author-only on purpose. Anyone may contradict a theory with
   * `counter_hypothesis`; only the person who staked a number on it may restate
   * that number, so the board cannot be edited out from under its author. The
   * opening value is kept in `openedAt` rather than overwritten, because "92%,
   * then 20% once the timeline landed" is the visible evidence that a mind
   * changed — a single current number shows nothing.
   */
  private async reviseHypothesis(
    session: Session,
    message: Extract<ClientMessage, { type: "revise" }>,
    requestId: string,
  ): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const hypothesis = this.room.state.hypotheses.find(
      (candidate) => candidate.id === message.hypothesisId,
    );
    if (!hypothesis) {
      this.fail(session, "not_found", "That hypothesis does not exist.", requestId);
      return;
    }
    if (hypothesis.by !== session.memberId) {
      this.fail(
        session,
        "not_author",
        "Only the author may revise a theory. Use counter_hypothesis to challenge it.",
        requestId,
      );
      return;
    }

    const openedAt = hypothesis.openedAt ?? hypothesis.confidence;
    hypothesis.openedAt = openedAt;
    hypothesis.confidence = message.confidence;
    if (message.because) hypothesis.revisedBecause = truncate(message.because, MAX_RATIONALE);
    else delete hypothesis.revisedBecause;

    const direction = message.confidence < openedAt ? "down" : "up";
    this.addActivity(
      `${this.memberName(session)} revised ${truncate(hypothesis.title, 48)} ${direction} to ${message.confidence.toFixed(2)}.`,
    );
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, {
      kind: "revision",
      hypothesisId: hypothesis.id,
      confidence: message.confidence,
      openedAt,
    });
  }

  private async proposeMitigation(
    session: Session,
    hypothesisId: string,
    rawActionId: string,
    blastRadius: string,
    requestId: string,
  ): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    if (!isActionId(rawActionId)) {
      this.fail(session, "unknown_action", "That action is not in the fixed mitigation library.", requestId);
      return;
    }
    if (!this.room.state.hypotheses.some((hypothesis) => hypothesis.id === hypothesisId)) {
      this.fail(session, "not_found", "That hypothesis does not exist.", requestId);
      return;
    }
    if (this.room.state.mitigations.length >= MAX_MITIGATIONS) {
      this.fail(session, "board_full", "The mitigation board is full. Vote on an existing fix.", requestId);
      return;
    }
    if (this.room.state.mitigations.some((mitigation) => mitigation.actionId === rawActionId)) {
      this.fail(session, "duplicate_action", "That action already has a mitigation proposal.", requestId);
      return;
    }
    const id = `fix${this.room.nextMitigation++}`;
    this.room.state.mitigations.push({
      id,
      hypothesisId,
      actionId: rawActionId,
      blastRadius,
      votes: {},
      rationales: {},
      passed: false,
    });
    this.room.state.phase = "mitigating";
    this.addActivity(`${this.memberName(session)} proposed ${rawActionId}.`);
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, { kind: "mitigation", mitigationId: id });
    if (rawActionId === "scale_pool:default") this.ctx.waitUntil(this.botVote(id));
  }

  private async vote(session: Session, targetId: string, choice: "yes" | "no", requestId: string): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const hypothesis = this.room.state.hypotheses.find((candidate) => candidate.id === targetId);
    if (hypothesis) {
      hypothesis.votes[session.memberId!] = choice;
      const counts = tally(hypothesis.votes, activeMemberIds(this.room.state));
      const passed = counts.yes > activeMemberIds(this.room.state).size / 2;
      this.addActivity(`${this.memberName(session)} voted ${choice} on ${truncate(hypothesis.title, 56)}.`);
      await this.persistAndBroadcast(true);
      this.sendToolResult(session, requestId, { kind: "vote", ...counts, passed });
      return;
    }
    const mitigation = this.room.state.mitigations.find((candidate) => candidate.id === targetId);
    if (!mitigation) {
      this.fail(session, "not_found", "That vote target does not exist.", requestId);
      return;
    }
    mitigation.votes[session.memberId!] = choice;
    recomputeMitigations(this.room.state);
    const result = mitigationTally(this.room.state, mitigation);
    this.addActivity(`${this.memberName(session)} voted ${choice} on ${mitigation.actionId}.`);
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, { kind: "vote", ...result });
  }

  // Explaining a vote you never cast would make this a general message channel,
  // and the whole point of the surface is that every tool has one job.
  private async explainVote(
    session: Session,
    targetId: string,
    rationale: string,
    requestId: string,
  ): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const text = rationale.trim();
    if (!text) {
      this.fail(session, "invalid_request", "A rationale cannot be empty.", requestId);
      return;
    }
    const memberId = session.memberId!;
    const target =
      this.room.state.hypotheses.find((candidate) => candidate.id === targetId) ??
      this.room.state.mitigations.find((candidate) => candidate.id === targetId);
    if (!target) {
      this.fail(session, "not_found", "That vote target does not exist.", requestId);
      return;
    }
    if (!target.votes[memberId]) {
      this.fail(session, "no_vote", "Vote on this first, then explain the vote.", requestId);
      return;
    }
    target.rationales ??= {};
    target.rationales[memberId] = truncate(text, MAX_RATIONALE);
    const label = "title" in target ? truncate(target.title, 56) : target.actionId;
    this.addActivity(`${this.memberName(session)} explained a ${target.votes[memberId]} vote on ${label}.`);
    await this.persistAndBroadcast(true);
    this.sendToolResult(session, requestId, {
      kind: "rationale",
      targetId,
      // Every stated reason on this target, from all members — not the
      // caller's own count, which would always be 1. The tool description
      // says so, because an agent reading `count: 1` could otherwise take it
      // for "my rationale was recorded" and never notice the other three.
      count: Object.keys(target.rationales).length,
    });
  }

  private async requestConfirm(session: Session, mitigationId: string, requestId: string): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const mitigation = this.room.state.mitigations.find((candidate) => candidate.id === mitigationId);
    if (!mitigation?.passed) {
      this.fail(session, "not_passed", "That mitigation has not won a majority vote.", requestId);
      return;
    }
    if (!this.activeCommanderSockets().length) {
      this.fail(session, "commander_unavailable", "No human commander is seated. Someone must join with role commander before a fix can be approved.", requestId);
      return;
    }
    if (Object.values(this.room.pending).some((pending) => pending.mitigationId === mitigationId)) {
      this.fail(session, "confirmation_pending", "This mitigation already awaits commander review.", requestId);
      return;
    }
    const confirmationId = `c${this.room.nextConfirmation++}`;
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    const pending: PendingConfirmation = {
      confirmationId,
      mitigationId,
      actionId: mitigation.actionId,
      requestId,
      requesterMemberId: session.memberId!,
      expiresAt,
    };
    this.room.pending[confirmationId] = pending;
    this.addActivity(`${this.memberName(session)} requested commander approval for ${mitigation.actionId}.`);
    await this.persistAndBroadcast(true);
    const prompt: ServerMessage = {
      type: "confirm_request",
      confirmationId,
      mitigationId,
      actionId: mitigation.actionId,
      actionSummary: ACTION_SUMMARIES[mitigation.actionId],
      expiresAt: Math.floor(expiresAt / 1_000),
    };
    for (const socket of this.activeCommanderSockets()) this.send(socket, prompt);
    this.armConfirmationTimer(pending);
  }

  private async confirm(session: Session, confirmationId: string, approved: boolean): Promise<void> {
    const commander = this.member(session.memberId!);
    if (commander?.role !== "commander" || !session.canCommand) {
      this.fail(session, "forbidden", "Only the active commander can answer confirmation requests.");
      return;
    }
    const pending = this.room.pending[confirmationId];
    if (!pending) {
      this.fail(session, "confirmation_not_found", "That confirmation is no longer pending.");
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      await this.expireConfirmation(confirmationId);
      this.fail(session, "confirmation_expired", "That confirmation expired.");
      return;
    }
    this.clearConfirmationTimer(confirmationId);
    delete this.room.pending[confirmationId];
    if (approved) {
      const approvedAt = Date.now();
      this.room.approvals[pending.actionId] = {
        confirmationId,
        mitigationId: pending.mitigationId,
        actionId: pending.actionId,
        commanderMemberId: commander.id,
        approvedAt,
        expiresAt: approvedAt + APPROVAL_TTL_MS,
      };
    }
    this.addActivity(`${commander.name} ${approved ? "approved" : "rejected"} ${pending.actionId}.`);
    await this.persistAndBroadcast(true);
    const response: ServerMessage = {
      type: "tool_result",
      requestId: pending.requestId,
      data: { kind: "confirm", approved, reason: approved ? "granted" : "rejected" },
    };
    this.cacheRequestResponse(pending.requesterMemberId, pending.requestId, response);
    this.sendToMember(pending.requesterMemberId, response);
    this.ctx.waitUntil(this.persist());
  }

  private async apply(session: Session, rawActionId: string, requestId: string): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    if (!isActionId(rawActionId)) {
      this.fail(session, "unknown_action", "That action is not in the fixed mitigation library.", requestId);
      return;
    }
    const mitigation = this.room.state.mitigations.find((candidate) => candidate.actionId === rawActionId);
    if (!mitigation?.passed) {
      this.fail(session, "not_passed", "That mitigation has not won a majority vote.", requestId);
      return;
    }
    const approval = this.room.approvals[rawActionId];
    if (!approval || approval.mitigationId !== mitigation.id || approval.expiresAt <= Date.now()) {
      if (approval) {
        delete this.room.approvals[rawActionId];
        await this.persist();
      }
      this.fail(session, "needs_human_confirm", "A fresh approval from the human commander is required.", requestId);
      return;
    }
    if (this.applying.has(rawActionId)) {
      this.fail(session, "apply_in_progress", "That mitigation is already being applied.", requestId);
      return;
    }

    this.applying.add(rawActionId);
    try {
      delete this.room.approvals[rawActionId];
      await this.persist();
      const response = await this.targetPost<{ applied: boolean; status: ServiceStatus }>(`/actions/${encodeURIComponent(rawActionId)}`);
      if (!this.room.state.appliedActions.includes(rawActionId)) this.room.state.appliedActions.push(rawActionId);
      this.addActivity(`${this.memberName(session)} applied ${rawActionId} after commander approval.`);
      await this.persistAndBroadcast(true);
      this.broadcast({ type: "status", ...response.status });
      this.sendToolResult(session, requestId, { kind: "apply", applied: response.applied, status: response.status });
    } finally {
      this.applying.delete(rawActionId);
    }
  }

  /**
   * The room id every target call is scoped to. `ctx.id.name` is the primary
   * source; the persisted copy and the broadcast state id are fallbacks so a
   * call can never quietly land on the shared default tenant.
   */
  private tenantId(): string {
    return this.ctx.id.name ?? this.room.roomId ?? this.room.state.id;
  }

  /**
   * The room's own id is not in the DO's storage the first time it wakes, so
   * take it from the path the router matched and keep it.
   */
  private async captureRoomId(url: URL): Promise<void> {
    if (this.room.roomId) return;
    const match = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match?.[1]) return;
    let candidate: string;
    try {
      candidate = decodeURIComponent(match[1]);
    } catch {
      return;
    }
    if (!isRoomId(candidate)) return;
    this.room.roomId = candidate;
    this.room.selfServe ??= isMintedRoomId(candidate);
    await this.persist();
  }

  private ensureMutable(session: Session, requestId: string): boolean {
    if (this.room.state.phase !== "resolved") return true;
    this.fail(session, "room_resolved", "This incident is resolved and the room is locked.", requestId);
    return false;
  }

  private async broadcastStatus(): Promise<void> {
    if (!this.hasActiveViewer() || this.room.state.phase === "resolved") return;
    try {
      const status = await this.targetGet<ServiceStatus>("/status");
      this.broadcast({ type: "status", ...status });
      if (
        this.room.state.appliedActions.includes("scale_pool:default") &&
        status.errorRate < 0.02
      ) {
        this.room.state.phase = "resolved";
        this.room.state.resolvedAt = nowSeconds();
        this.addActivity("storefront-api recovered after the pool was restored.");
        await this.persistAndBroadcast(true);
        this.stopStatusTimer();
      }
    } catch (error) {
      console.error("Status broadcast failed", error);
    }
  }

  private startStatusTimer(): void {
    if (this.statusTimer || this.room.state.phase === "resolved") return;
    this.statusTimer = setInterval(() => void this.broadcastStatus(), 2_000);
  }

  private stopStatusTimer(): void {
    if (!this.statusTimer) return;
    clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }

  // A judge can open any room link with no agent attached. Start the status
  // feed for that socket so the page shows live health instead of placeholder
  // dashes. Unlike demo spectating, this does not arm the house bot.
  private async beginLiveViewing(): Promise<void> {
    if (this.room.state.phase === "resolved") return;
    await this.ctx.storage.deleteAlarm();
    this.startStatusTimer();
    await this.broadcastStatus();
  }

  // A judge can open the demo link in a browser with no agent attached. Arm the
  // house bot and the status feed for that connection so the room shows the live
  // incident instead of an empty board while it waits for someone to join.
  private async beginDemoSpectating(): Promise<void> {
    if (this.isSpentDemoRoom()) {
      // A spent demo room is useless to whoever opens the link next, but never
      // pull the room out from under someone who is actually in it. Presence
      // here means a joined member, not an open socket: hibernated sockets from
      // browsers that have gone away still show up in getWebSockets(), and
      // counting those left the public room stuck at an 82 minute incident.
      if (this.hasActiveHuman()) return;
      if (!(await this.restartIncident())) return;
    }
    const alreadyArmed = this.room.bot.enabled && this.room.bot.humanJoinedAt !== null;
    this.room.bot.enabled = true;
    this.room.bot.humanJoinedAt ??= Date.now();
    // Presence is only recomputed when the object wakes, and on wake there may
    // be no sockets yet, which left the house bot marked absent for the rest of
    // the room's life: the board showed its hypothesis under "0 people in room".
    await this.reconcileConnections();
    await this.ctx.storage.deleteAlarm();
    if (!alreadyArmed) await this.persist();
    this.startStatusTimer();
    this.scheduleBot();
    await this.broadcastStatus();
  }

  private isSpentDemoRoom(): boolean {
    if (this.room.state.phase === "resolved") return true;
    const openedFor = Date.now() - this.room.state.incidentStartedAt * 1_000;
    return openedFor > DEMO_STALE_MS;
  }

  // Re-arm the scripted fault and clear the board so the next visitor gets a
  // live incident. Only ever called for a demo room with nobody else watching.
  private async restartIncident(): Promise<boolean> {
    let armedAgain = false;
    try {
      await this.targetPost<{ armed: boolean }>("/scenario/rearm");
      armedAgain = true;
    } catch (error) {
      console.error("Could not re-arm the scripted fault", error);
    }
    if (!armedAgain) {
      // Clearing the board is still right when the service is broken on its
      // own, but never present a fresh incident over a healthy service.
      try {
        const status = await this.targetGet<ServiceStatus>("/status");
        if (status.errorRate < 0.02) return false;
      } catch {
        return false;
      }
    }
    this.clearTimers();
    await this.ctx.storage.deleteAll();
    this.room = emptyRoom(this.tenantId(), this.room.selfServe === true);
    await this.persist();
    this.broadcast({ type: "state", state: cloneState(this.room.state) });
    return true;
  }

  private scheduleBot(): void {
    if (!this.room.bot.enabled || this.room.bot.humanJoinedAt === null || !this.hasActiveViewer()) return;
    if (!this.room.bot.memberId) {
      const delay = Math.max(0, this.room.bot.humanJoinedAt + BOT_JOIN_DELAY_MS - Date.now());
      if (!this.botJoinTimer) this.botJoinTimer = setTimeout(() => void this.botJoin(), delay);
    }
    if (!this.room.bot.hypothesisId) {
      const delay = Math.max(0, this.room.bot.humanJoinedAt + BOT_HYPOTHESIS_DELAY_MS - Date.now());
      if (!this.botHypothesisTimer) this.botHypothesisTimer = setTimeout(() => void this.botHypothesis(), delay);
    }
  }

  private botSession(): Session {
    const session: Session = {
      memberId: this.room.bot.memberId ?? undefined,
      demo: true,
      isBot: true,
      canCommand: false,
      send: (message) => {
        if (message.type === "joined") {
          session.memberId = message.memberId;
          this.room.bot.memberId = message.memberId;
        }
        if (message.type === "tool_result" && message.data.kind === "hypothesis") {
          this.room.bot.hypothesisId = message.data.hypothesisId;
        }
      },
      bindMember: (memberId) => {
        session.memberId = memberId;
        this.room.bot.memberId = memberId;
      },
      // The house bot only ever joins as a responder, so it never reaches the
      // grant path. Keeping it a no-op means the bot cannot become commander
      // even if the scenario changes.
      grantCommand: () => undefined,
    };
    return session;
  }

  private async botJoin(): Promise<void> {
    this.botJoinTimer = undefined;
    if (!this.hasActiveViewer() || this.room.bot.memberId) return;
    await this.dispatch(this.botSession(), { type: "join", name: "Responder 2", role: "responder" });
    await this.persist();
    this.scheduleBot();
  }

  private async botHypothesis(): Promise<void> {
    this.botHypothesisTimer = undefined;
    if (!this.hasActiveViewer() || this.room.bot.hypothesisId) return;
    if (!this.room.bot.memberId) await this.botJoin();
    if (!this.room.bot.memberId) return;
    await this.dispatch(this.botSession(), {
      type: "propose_hypothesis",
      requestId: "bot-hypothesis",
      title: "The new-checkout flag caused the errors",
      evidence: "The flag changed this morning and checkout is failing.",
      confidence: 0.35,
    });
    await this.persist();
    if (this.room.bot.realEvidenceSeen) await this.maybeBotCounter();
  }

  private async maybeBotCounter(): Promise<void> {
    if (!this.room.bot.enabled || !this.room.bot.realEvidenceSeen || !this.room.bot.hypothesisId || this.room.bot.countered) return;
    this.room.bot.countered = true;
    await this.persist();
    await this.dispatch(this.botSession(), {
      type: "counter",
      requestId: "bot-counter",
      hypothesisId: this.room.bot.hypothesisId,
      evidence: "The error timeline starts before new-checkout was enabled; the flag is not causal.",
    });
  }

  private async botVote(mitigationId: string): Promise<void> {
    const member = this.room.bot.memberId ? this.member(this.room.bot.memberId) : undefined;
    if (!member?.agentActive) return;
    await this.dispatch(this.botSession(), {
      type: "vote",
      requestId: `bot-vote-${mitigationId}`,
      targetId: mitigationId,
      choice: "yes",
    });
  }

  private async handlePresenceChange(closing?: WebSocket): Promise<void> {
    if (this.hasActiveViewer(closing)) return;
    const bot = this.room.bot.memberId ? this.member(this.room.bot.memberId) : undefined;
    if (bot) bot.agentActive = false;
    this.cancelPendingConfirmations();
    this.room.approvals = {};
    recomputeMitigations(this.room.state);
    this.stopStatusTimer();
    if (this.botJoinTimer) clearTimeout(this.botJoinTimer);
    if (this.botHypothesisTimer) clearTimeout(this.botHypothesisTimer);
    this.botJoinTimer = undefined;
    this.botHypothesisTimer = undefined;
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
  }

  private async reconcileConnections(): Promise<void> {
    const connected = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.memberId) connected.add(attachment.memberId);
    }
    for (const member of this.room.state.members) {
      const isBot = member.id === this.room.bot.memberId;
      member.agentActive = isBot
        ? this.room.bot.enabled && this.ctx.getWebSockets().length > 0
        : connected.has(member.id);
    }
    recomputeMitigations(this.room.state);
    await this.persist();
  }

  private restoreConfirmationTimers(): void {
    for (const pending of Object.values(this.room.pending)) this.armConfirmationTimer(pending);
  }

  private armConfirmationTimer(pending: PendingConfirmation): void {
    this.clearConfirmationTimer(pending.confirmationId);
    const delay = Math.max(0, pending.expiresAt - Date.now());
    this.confirmationTimers.set(
      pending.confirmationId,
      setTimeout(() => void this.expireConfirmation(pending.confirmationId), delay),
    );
  }

  private clearConfirmationTimer(confirmationId: string): void {
    const timer = this.confirmationTimers.get(confirmationId);
    if (timer) clearTimeout(timer);
    this.confirmationTimers.delete(confirmationId);
  }

  private async expireConfirmation(confirmationId: string): Promise<void> {
    const pending = this.room.pending[confirmationId];
    if (!pending) return;
    this.clearConfirmationTimer(confirmationId);
    delete this.room.pending[confirmationId];
    await this.persist();
    const response: ServerMessage = {
      type: "tool_result",
      requestId: pending.requestId,
      data: { kind: "confirm", approved: false, reason: "expired" },
    };
    this.cacheRequestResponse(pending.requesterMemberId, pending.requestId, response);
    this.sendToMember(pending.requesterMemberId, response);
    this.ctx.waitUntil(this.persist());
  }

  private cancelPendingConfirmations(): void {
    for (const pending of Object.values(this.room.pending)) {
      this.clearConfirmationTimer(pending.confirmationId);
      const response: ServerMessage = {
        type: "tool_result",
        requestId: pending.requestId,
        data: { kind: "confirm", approved: false, reason: "expired" },
      };
      this.cacheRequestResponse(pending.requesterMemberId, pending.requestId, response);
      this.sendToMember(pending.requesterMemberId, response);
    }
    this.room.pending = {};
  }

  private cancelPendingConfirmationsFor(memberId: string): void {
    for (const pending of Object.values(this.room.pending)) {
      if (pending.requesterMemberId !== memberId) continue;
      this.clearConfirmationTimer(pending.confirmationId);
      delete this.room.pending[pending.confirmationId];
    }
  }

  private activeCommanderSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      const member = attachment?.memberId ? this.member(attachment.memberId) : undefined;
      return attachment?.canCommand === true && member?.agentActive === true && member.role === "commander";
    });
  }

  private hasActiveHuman(): boolean {
    return this.room.state.members.some((member) => member.agentActive && member.id !== this.room.bot.memberId);
  }

  // The house bot is a synthetic session that never holds a socket, so every open
  // socket belongs to a person: a joined member, or someone watching before they
  // join. `closing` excludes a socket that is in the middle of going away.
  private hasActiveViewer(closing?: WebSocket): boolean {
    if (this.hasActiveHuman()) return true;
    return this.ctx.getWebSockets().some((socket) => socket !== closing);
  }

  private member(id: string): Member | undefined {
    return this.room.state.members.find((member) => member.id === id);
  }

  private memberName(session: Session): string {
    return session.memberId ? this.member(session.memberId)?.name ?? "Unknown member" : "Unknown member";
  }

  private addActivity(text: string): void {
    this.room.state.log.push({ t: nowSeconds(), text: truncate(text, 180) });
    if (this.room.state.log.length > MAX_ACTIVITY) {
      this.room.state.log.splice(0, this.room.state.log.length - MAX_ACTIVITY);
    }
  }

  private async beginMutationRequest(
    session: Session,
    message: Exclude<ClientMessage, { type: "join" } | { type: "confirm" }>,
  ): Promise<boolean> {
    const memberId = session.memberId!;
    const memberLog = (this.room.requestLog[memberId] ??= {});
    const fingerprint = JSON.stringify(message);
    const existing = memberLog[message.requestId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        session.send({
          type: "error",
          requestId: message.requestId,
          code: "request_id_reused",
          message: "That requestId was already used for a different operation.",
        });
      } else if (existing.response) {
        session.send(existing.response);
      } else {
        session.send({
          type: "error",
          requestId: message.requestId,
          code: "request_in_progress",
          message: "That operation is already in progress.",
        });
      }
      return false;
    }

    memberLog[message.requestId] = { fingerprint, updatedAt: Date.now() };
    const requestIds = Object.keys(memberLog);
    for (const staleId of requestIds.slice(0, Math.max(0, requestIds.length - MAX_REQUEST_RECORDS_PER_MEMBER))) {
      delete memberLog[staleId];
    }
    await this.persist();
    return true;
  }

  private cacheRequestResponse(memberId: string | undefined, requestId: string, response: ServerMessage): void {
    if (!memberId) return;
    const record = this.room.requestLog[memberId]?.[requestId];
    if (!record) return;
    record.response = response;
    record.updatedAt = Date.now();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORE_KEY, this.room);
  }

  private async persistAndBroadcast(event: boolean): Promise<void> {
    await this.persist();
    if (event) {
      const text = this.room.state.log.at(-1)?.text;
      if (text) this.broadcast({ type: "event", text });
    }
    this.broadcast({ type: "state", state: cloneState(this.room.state) });
  }

  private broadcast(message: ServerMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(encoded);
        } catch (error) {
          console.error("WebSocket broadcast failed", error);
        }
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("WebSocket send failed", error);
    }
  }

  private sendToMember(memberId: string, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.memberId === memberId) this.send(socket, message);
    }
  }

  private fail(session: Session, code: string, message: string, requestId?: string): void {
    const response: ServerMessage = { type: "error", ...(requestId ? { requestId } : {}), code, message };
    if (requestId) {
      this.cacheRequestResponse(session.memberId, requestId, response);
      this.ctx.waitUntil(this.persist());
    }
    session.send(response);
  }

  private sendToolResult(session: Session, requestId: string, data: ToolResultData): void {
    let message: ServerMessage = { type: "tool_result", requestId, data };
    if (encodeSize(message) <= TOOL_RESULT_BUDGET) {
      this.cacheRequestResponse(session.memberId, requestId, message);
      this.ctx.waitUntil(this.persist());
      session.send(message);
      return;
    }

    if (data.kind === "room_state") {
      const state = cloneState(data.state);
      state.log = state.log.slice(-3).map((entry) => ({ ...entry, text: truncate(entry.text, 64) }));
      state.members = state.members.map((member) => ({ ...member, name: truncate(member.name, 20) }));
      state.hypotheses = state.hypotheses.map((hypothesis) => ({
        ...hypothesis,
        title: truncate(hypothesis.title, 48),
        evidence: truncate(hypothesis.evidence, 48),
        rebuttals: hypothesis.rebuttals.slice(-1).map((rebuttal) => ({ ...rebuttal, evidence: truncate(rebuttal.evidence, 40) })),
      }));
      state.mitigations = state.mitigations.map((mitigation) => ({ ...mitigation, blastRadius: truncate(mitigation.blastRadius, 48) }));
      const compactData = { kind: "room_state", state, truncated: true } as ToolResultData;
      message = { type: "tool_result", requestId, data: compactData };
      while (encodeSize(message) > TOOL_RESULT_BUDGET && state.log.length) state.log.shift();
      while (encodeSize(message) > TOOL_RESULT_BUDGET) {
        const candidate = state.hypotheses.find((hypothesis) => hypothesis.rebuttals.length);
        if (!candidate) break;
        candidate.rebuttals = [];
        candidate.rationales = {};
      }
      if (encodeSize(message) > TOOL_RESULT_BUDGET) {
        state.log = [];
        state.members = state.members.map((member) => ({ ...member, name: truncate(member.name, 8) }));
        state.hypotheses = state.hypotheses.map((hypothesis) => ({
          ...hypothesis,
          title: truncate(hypothesis.title, 20),
          evidence: "",
          rebuttals: [],
          rationales: {},
        }));
        state.mitigations = state.mitigations.map((mitigation) => ({
          ...mitigation,
          blastRadius: "",
          rationales: {},
        }));
      }
    } else if (data.kind === "logs") {
      const lines = [...data.lines];
      message = { type: "tool_result", requestId, data: { ...data, lines } };
      while (encodeSize(message) > TOOL_RESULT_BUDGET && lines.length > 1) lines.shift();
      if (encodeSize(message) > TOOL_RESULT_BUDGET && lines[0]) lines[0] = truncate(lines[0], 1_500);
    }

    if (encodeSize(message) > TOOL_RESULT_BUDGET) {
      this.fail(session, "result_too_large", "The result could not be represented within the 2 KB limit.", requestId);
      return;
    }
    this.cacheRequestResponse(session.memberId, requestId, message);
    this.ctx.waitUntil(this.persist());
    session.send(message);
  }

  private async targetGet<T>(path: string): Promise<T> {
    return this.targetFetch<T>(path, { method: "GET" }, false);
  }

  private async targetPost<T>(path: string): Promise<T> {
    return this.targetFetch<T>(path, { method: "POST" }, true);
  }

  private async targetFetch<T>(path: string, init: RequestInit, authorize: boolean): Promise<T> {
    const base = this.env.TARGET_ORIGIN ?? "https://storefront-api.invalid";
    // Composed here rather than at the call sites, so every read and every write
    // is scoped to this room's scenario state without anyone remembering to.
    const headers = targetRequestHeaders({
      roomId: this.tenantId(),
      ...(this.env.TARGET_TOKEN ? { targetToken: this.env.TARGET_TOKEN } : {}),
      authorize,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("target_timeout"), 3_000);
    try {
      const request = new Request(new URL(path, base), { ...init, headers, signal: controller.signal });
      const response = this.env.TARGET ? await this.env.TARGET.fetch(request) : await fetch(request);
      if (!response.ok) throw new TargetError(response.status);
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > TOOL_RESULT_BUDGET) throw new Error("Target response exceeded 2 KB.");
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private clearTimers(): void {
    this.stopStatusTimer();
    if (this.botJoinTimer) clearTimeout(this.botJoinTimer);
    if (this.botHypothesisTimer) clearTimeout(this.botHypothesisTimer);
    for (const timer of this.confirmationTimers.values()) clearTimeout(timer);
    this.confirmationTimers.clear();
  }
}
