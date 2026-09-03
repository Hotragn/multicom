import { DurableObject } from "cloudflare:workers";
import { ACTION_LIBRARY, ACTION_SUMMARIES, type ActionId, type CheckId } from "../../shared/tools";
import { ROOM_ID, SERVICE_NAME } from "../../shared/scenario";
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
  readonly canCommand: boolean;
  send(message: ServerMessage): void;
  bindMember(memberId: string): void;
}

interface TargetLogs {
  lines: string[];
  untrustedContentHint: true;
}

const STORE_KEY = "room";
const MAX_MEMBERS = 6;
const MAX_HYPOTHESES = 5;
const MAX_MITIGATIONS = 3;
const MAX_REBUTTALS = 10;
const MAX_ACTIVITY = 60;
const TOOL_RESULT_BUDGET = 2_048;
const APPROVAL_TTL_MS = 60_000;
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1_000;
const BOT_JOIN_DELAY_MS = 1_000;
const BOT_HYPOTHESIS_DELAY_MS = 9_500;
const MAX_REQUEST_RECORDS_PER_MEMBER = 64;
const MUTATING_REQUESTS = new Set<ClientMessage["type"]>([
  "propose_hypothesis",
  "counter",
  "propose_mitigation",
  "vote",
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

const emptyRoom = (id: string): StoredRoom => ({
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
      await this.reconcileConnections();
      this.restoreConfirmationTimers();
      this.scheduleBot();
      if (this.hasActiveViewer() && this.room.state.phase !== "resolved") this.startStatusTimer();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }

    const url = new URL(request.url);
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
    this.room = emptyRoom(this.room.state.id);
  }

  private async dispatch(session: Session, message: ClientMessage): Promise<void> {
    if (message.type === "join") {
      await this.join(session, message.name, message.role);
      return;
    }
    if (!session.memberId || !this.member(session.memberId)?.agentActive) {
      // Reading the board is the only thing a spectator may do before joining.
      // Joining is unauthenticated anyway, so this grants no new visibility.
      if (message.type === "get_room_state" && !session.isBot) {
        if (session.demo) await this.beginDemoSpectating();
        this.sendToolResult(session, message.requestId, { kind: "room_state", state: cloneState(this.room.state) });
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
        case "propose_mitigation":
          await this.proposeMitigation(session, message.hypothesisId, String(message.actionId), message.blastRadius, requestId);
          return;
        case "vote":
          await this.vote(session, message.targetId, message.choice, requestId);
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
      this.fail(session, "target_unavailable", "The scripted target did not respond. Try again.", requestId);
    }
  }

  private async join(session: Session, name: string, role: Member["role"]): Promise<void> {
    if (session.memberId) {
      this.fail(session, "already_joined", "This connection already joined the room.");
      return;
    }
    if (this.room.state.members.filter((member) => member.agentActive).length >= MAX_MEMBERS) {
      this.fail(session, "room_full", "This room already has six active members.");
      return;
    }
    if (role === "commander" && this.room.state.members.some((member) => member.agentActive && member.role === "commander")) {
      this.fail(session, "commander_taken", "This room already has an active commander.");
      return;
    }
    if (role === "commander" && !session.canCommand) {
      this.fail(session, "commander_forbidden", "This connection does not have the commander capability.");
      return;
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

  private async requestConfirm(session: Session, mitigationId: string, requestId: string): Promise<void> {
    if (!this.ensureMutable(session, requestId)) return;
    const mitigation = this.room.state.mitigations.find((candidate) => candidate.id === mitigationId);
    if (!mitigation?.passed) {
      this.fail(session, "not_passed", "That mitigation has not won a majority vote.", requestId);
      return;
    }
    if (!this.activeCommanderSockets().length) {
      this.fail(session, "commander_unavailable", "An active human commander is required.", requestId);
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
      data: { kind: "confirm", approved },
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

  // A judge can open the demo link in a browser with no agent attached. Arm the
  // house bot and the status feed for that connection so the room shows the live
  // incident instead of an empty board while it waits for someone to join.
  private async beginDemoSpectating(): Promise<void> {
    if (this.room.state.phase === "resolved") return;
    const alreadyArmed = this.room.bot.enabled && this.room.bot.humanJoinedAt !== null;
    this.room.bot.enabled = true;
    this.room.bot.humanJoinedAt ??= Date.now();
    await this.ctx.storage.deleteAlarm();
    if (!alreadyArmed) await this.persist();
    this.startStatusTimer();
    this.scheduleBot();
    await this.broadcastStatus();
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
      data: { kind: "confirm", approved: false },
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
        data: { kind: "confirm", approved: false },
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
      }
      if (encodeSize(message) > TOOL_RESULT_BUDGET) {
        state.log = [];
        state.members = state.members.map((member) => ({ ...member, name: truncate(member.name, 8) }));
        state.hypotheses = state.hypotheses.map((hypothesis) => ({
          ...hypothesis,
          title: truncate(hypothesis.title, 20),
          evidence: "",
          rebuttals: [],
        }));
        state.mitigations = state.mitigations.map((mitigation) => ({ ...mitigation, blastRadius: "" }));
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
    return this.targetFetch<T>(path, { method: "GET" });
  }

  private async targetPost<T>(path: string): Promise<T> {
    const headers = new Headers();
    if (this.env.TARGET_TOKEN) headers.set("authorization", `Bearer ${this.env.TARGET_TOKEN}`);
    return this.targetFetch<T>(path, { method: "POST", headers });
  }

  private async targetFetch<T>(path: string, init: RequestInit): Promise<T> {
    const base = this.env.TARGET_ORIGIN ?? "https://storefront-api.invalid";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("target_timeout"), 3_000);
    try {
      const request = new Request(new URL(path, base), { ...init, signal: controller.signal });
      const response = this.env.TARGET ? await this.env.TARGET.fetch(request) : await fetch(request);
      if (!response.ok) throw new Error(`Target returned ${response.status}.`);
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
