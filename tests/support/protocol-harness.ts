import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { ACTION_LIBRARY, ACTION_SUMMARIES, type ActionId } from "../../shared/tools";
import { FAULTY_STATUS, ROOM_ID, SERVICE_NAME } from "../../shared/scenario";
import type {
  ClientMessage,
  Member,
  RoomState,
  ServerMessage,
  ServiceStatus,
  ToolResultData,
} from "../../shared/ws-messages";
import { activeMemberIds, recomputeMitigations, tally } from "../../worker/src/domain";
import { parseClientMessage, ProtocolError } from "../../worker/src/protocol";
import {
  checkAt,
  selectLogs,
  snapshotAt,
  type PersistedScenario,
} from "../../target/src/scenario-state";

interface Peer {
  socket: WebSocket;
  memberId?: string;
  demo: boolean;
  isBot: boolean;
  commanderAuthorized: boolean;
  requests: Map<string, { fingerprint: string; response?: ServerMessage }>;
}

interface PendingConfirmation {
  id: string;
  requestId: string;
  requester: Peer;
  mitigationId: string;
  actionId: ActionId;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Approval {
  mitigationId: string;
  actionId: ActionId;
  expiresAt: number;
}

interface BotState {
  peer: Peer | undefined;
  hypothesisId: string | undefined;
  evidenceSeen: boolean;
  countered: boolean;
  joinTimer: ReturnType<typeof setTimeout> | undefined;
  hypothesisTimer: ReturnType<typeof setTimeout> | undefined;
}

const clone = <T>(value: T): T => structuredClone(value);
const nowSeconds = (): number => Math.floor(Date.now() / 1_000);
const allowedAction = (value: string): value is ActionId =>
  (ACTION_LIBRARY as readonly string[]).includes(value);

class HarnessRoom {
  readonly state: RoomState;
  readonly peers = new Set<Peer>();
  scenario: PersistedScenario = { armed: true, armedAt: Date.now(), actionId: null, appliedAt: null };
  approvalTtlMs: number;

  private nextMember = 1;
  private nextHypothesis = 1;
  private nextMitigation = 1;
  private nextConfirmation = 1;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly approvals = new Map<ActionId, Approval>();
  private readonly bot: BotState = {
    peer: undefined,
    hypothesisId: undefined,
    evidenceSeen: false,
    countered: false,
    joinTimer: undefined,
    hypothesisTimer: undefined,
  };
  private statusTimer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly id: string, approvalTtlMs: number) {
    this.approvalTtlMs = approvalTtlMs;
    this.state = {
      id,
      phase: "triage",
      incidentStartedAt: nowSeconds(),
      resolvedAt: null,
      members: [],
      hypotheses: [],
      mitigations: [],
      appliedActions: [],
      log: [],
    };
  }

  connect(socket: WebSocket, demo: boolean, commanderAuthorized: boolean): Peer {
    const peer: Peer = { socket, demo, isBot: false, commanderAuthorized, requests: new Map() };
    this.peers.add(peer);
    socket.on("message", (raw) => {
      void this.receive(peer, raw.toString());
    });
    socket.on("close", () => this.disconnect(peer));
    if (demo) {
      // Mirror the room Worker: a resolved demo room restarts for the next
      // visitor, unless somebody else is still watching it.
      const watchers = [...this.peers].filter((item) => !item.isBot).length;
      if (this.state.phase === "resolved" && watchers <= 1) this.restartIncident();
      this.ensureStatusTimer();
      this.armBot();
    }
    return peer;
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.bot.joinTimer) clearTimeout(this.bot.joinTimer);
    if (this.bot.hypothesisTimer) clearTimeout(this.bot.hypothesisTimer);
    for (const item of this.pending.values()) clearTimeout(item.timer);
    for (const peer of this.peers) peer.socket.close();
    this.peers.clear();
  }

  private async receive(peer: Peer, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      const issue = error instanceof ProtocolError ? error : new ProtocolError("invalid_request", "Invalid request.");
      this.send(peer, { type: "error", ...(issue.requestId ? { requestId: issue.requestId } : {}), code: issue.code, message: issue.message });
      return;
    }
    if ("requestId" in message && this.isMutation(message)) {
      const fingerprint = JSON.stringify(message);
      const existing = peer.requests.get(message.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          this.error(peer, message.requestId, "request_id_reused", "A mutation requestId cannot be reused for different input.");
        } else if (existing.response) {
          this.send(peer, existing.response);
        }
        return;
      }
      peer.requests.set(message.requestId, { fingerprint });
      if (peer.requests.size > 64) peer.requests.delete(peer.requests.keys().next().value!);
    }
    await this.dispatch(peer, message);
  }

  private isMutation(message: ClientMessage): boolean {
    return message.type === "propose_hypothesis" ||
      message.type === "counter" ||
      message.type === "propose_mitigation" ||
      message.type === "vote" ||
      message.type === "request_confirm" ||
      message.type === "apply";
  }

  private async dispatch(peer: Peer, message: ClientMessage): Promise<void> {
    if (message.type === "join") {
      this.join(peer, message.name, message.role);
      return;
    }
    if (!peer.memberId || !this.member(peer.memberId)?.agentActive) {
      if (message.type === "get_room_state" && !peer.isBot) {
        if (peer.demo) {
          this.ensureStatusTimer();
          this.armBot();
        }
        this.result(peer, message.requestId, { kind: "room_state", state: clone(this.state) });
        return;
      }
      this.error(peer, "requestId" in message ? message.requestId : undefined, "join_required", "Join the room first.");
      return;
    }
    if (message.type === "confirm") {
      this.confirm(peer, message.confirmationId, message.approved);
      return;
    }

    switch (message.type) {
      case "get_room_state":
        this.result(peer, message.requestId, { kind: "room_state", state: clone(this.state) });
        return;
      case "get_service_status":
        this.result(peer, message.requestId, { kind: "service_status", status: snapshotAt(this.scenario, Date.now()) });
        return;
      case "query_logs":
        if (message.service !== SERVICE_NAME) {
          this.error(peer, message.requestId, "unknown_service", "Only storefront-api is available.");
          return;
        }
        this.result(peer, message.requestId, {
          kind: "logs",
          lines: selectLogs(message.window, message.filter),
          untrustedContentHint: true,
        });
        return;
      case "run_check":
        this.result(peer, message.requestId, { kind: "check", result: checkAt(this.scenario, message.checkId, Date.now()) });
        if (message.checkId === "error_timeline" || message.checkId === "pool_in_use") {
          this.bot.evidenceSeen = true;
          this.botCounter();
        }
        return;
      case "propose_hypothesis":
        this.proposeHypothesis(peer, message);
        return;
      case "counter":
        this.counter(peer, message.requestId, message.hypothesisId, message.evidence);
        return;
      case "propose_mitigation":
        this.proposeMitigation(peer, message.requestId, message.hypothesisId, String(message.actionId), message.blastRadius);
        return;
      case "vote":
        this.vote(peer, message.requestId, message.targetId, message.choice);
        return;
      case "request_confirm":
        this.requestConfirm(peer, message.requestId, message.mitigationId);
        return;
      case "apply":
        this.apply(peer, message.requestId, String(message.actionId));
        return;
    }
  }

  private join(peer: Peer, name: string, role: Member["role"]): void {
    if (peer.memberId) return this.error(peer, undefined, "already_joined", "Already joined.");
    if (this.state.members.filter((member) => member.agentActive).length >= 6) {
      return this.error(peer, undefined, "room_full", "The room already has six active members.");
    }
    if (role === "commander" && !peer.commanderAuthorized) {
      return this.error(peer, undefined, "commander_forbidden", "A commander capability is required.");
    }
    if (role === "commander" && this.state.members.some((member) => member.agentActive && member.role === "commander")) {
      return this.error(peer, undefined, "commander_taken", "The commander role is already occupied.");
    }
    const member: Member = { id: `u${this.nextMember++}`, name, role, agentActive: true };
    peer.memberId = member.id;
    this.state.members.push(member);
    recomputeMitigations(this.state);
    this.activity(`${name} joined as ${role}.`);
    this.send(peer, { type: "joined", memberId: member.id, state: clone(this.state) });
    this.broadcastState();
    this.ensureStatusTimer();
    if (peer.demo && !peer.isBot) this.armBot();
  }

  private proposeHypothesis(peer: Peer, message: Extract<ClientMessage, { type: "propose_hypothesis" }>): void {
    if (!this.mutable(peer, message.requestId)) return;
    if (this.state.hypotheses.length >= 5) return this.error(peer, message.requestId, "board_full", "Vote on the existing hypotheses.");
    const id = `h${this.nextHypothesis++}`;
    this.state.hypotheses.push({
      id,
      by: peer.memberId!,
      title: message.title,
      evidence: message.evidence,
      confidence: message.confidence,
      rebuttals: [],
      votes: {},
    });
    if (this.state.phase === "triage") this.state.phase = "diagnosing";
    this.activity(`${this.name(peer)} proposed ${message.title}.`);
    this.broadcastState();
    this.result(peer, message.requestId, { kind: "hypothesis", hypothesisId: id });
  }

  private counter(peer: Peer, requestId: string, hypothesisId: string, evidence: string): void {
    if (!this.mutable(peer, requestId)) return;
    const hypothesis = this.state.hypotheses.find((item) => item.id === hypothesisId);
    if (!hypothesis) return this.error(peer, requestId, "not_found", "Hypothesis not found.");
    hypothesis.rebuttals.push({ by: peer.memberId!, evidence });
    this.activity(`${this.name(peer)} challenged ${hypothesis.title}.`);
    this.broadcastState();
    this.result(peer, requestId, { kind: "counter", hypothesisId });
  }

  private proposeMitigation(peer: Peer, requestId: string, hypothesisId: string, rawActionId: string, blastRadius: string): void {
    if (!this.mutable(peer, requestId)) return;
    if (!allowedAction(rawActionId)) return this.error(peer, requestId, "unknown_action", "Unknown action.");
    if (!this.state.hypotheses.some((item) => item.id === hypothesisId)) return this.error(peer, requestId, "not_found", "Hypothesis not found.");
    if (this.state.mitigations.length >= 3) return this.error(peer, requestId, "board_full", "Vote on the existing mitigations.");
    if (this.state.mitigations.some((item) => item.actionId === rawActionId)) return this.error(peer, requestId, "duplicate_action", "Action already proposed.");
    const id = `fix${this.nextMitigation++}`;
    this.state.mitigations.push({ id, hypothesisId, actionId: rawActionId, blastRadius, votes: {}, passed: false });
    this.state.phase = "mitigating";
    this.activity(`${this.name(peer)} proposed ${rawActionId}.`);
    this.broadcastState();
    this.result(peer, requestId, { kind: "mitigation", mitigationId: id });
    if (rawActionId === "scale_pool:default") this.botVote(id);
  }

  private vote(peer: Peer, requestId: string, targetId: string, choice: "yes" | "no"): void {
    if (!this.mutable(peer, requestId)) return;
    const hypothesis = this.state.hypotheses.find((item) => item.id === targetId);
    if (hypothesis) {
      hypothesis.votes[peer.memberId!] = choice;
      const counts = tally(hypothesis.votes, activeMemberIds(this.state));
      this.broadcastState();
      this.result(peer, requestId, { kind: "vote", ...counts, passed: counts.yes > activeMemberIds(this.state).size / 2 });
      return;
    }
    const mitigation = this.state.mitigations.find((item) => item.id === targetId);
    if (!mitigation) return this.error(peer, requestId, "not_found", "Vote target not found.");
    mitigation.votes[peer.memberId!] = choice;
    recomputeMitigations(this.state);
    const counts = tally(mitigation.votes, activeMemberIds(this.state));
    this.broadcastState();
    this.result(peer, requestId, { kind: "vote", ...counts, passed: mitigation.passed });
  }

  private requestConfirm(peer: Peer, requestId: string, mitigationId: string): void {
    if (!this.mutable(peer, requestId)) return;
    const mitigation = this.state.mitigations.find((item) => item.id === mitigationId);
    if (!mitigation?.passed) return this.error(peer, requestId, "not_passed", "Mitigation has not passed.");
    const commanders = [...this.peers].filter((candidate) => this.member(candidate.memberId)?.role === "commander");
    if (!commanders.length) return this.error(peer, requestId, "commander_unavailable", "No commander is active.");
    const id = `c${this.nextConfirmation++}`;
    const expiresAt = Date.now() + this.approvalTtlMs;
    const pending: PendingConfirmation = {
      id,
      requestId,
      requester: peer,
      mitigationId,
      actionId: mitigation.actionId,
      expiresAt,
      timer: setTimeout(() => this.expire(id), this.approvalTtlMs),
    };
    this.pending.set(id, pending);
    const prompt: ServerMessage = {
      type: "confirm_request",
      confirmationId: id,
      mitigationId,
      actionId: mitigation.actionId,
      actionSummary: ACTION_SUMMARIES[mitigation.actionId],
      expiresAt: Math.floor(expiresAt / 1_000),
    };
    for (const commander of commanders) this.send(commander, prompt);
  }

  private confirm(peer: Peer, id: string, approved: boolean): void {
    if (this.member(peer.memberId)?.role !== "commander") return this.error(peer, undefined, "forbidden", "Commander only.");
    const pending = this.pending.get(id);
    if (!pending) return this.error(peer, undefined, "confirmation_not_found", "Confirmation is no longer pending.");
    if (pending.expiresAt <= Date.now()) return this.expire(id);
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (approved) this.approvals.set(pending.actionId, { mitigationId: pending.mitigationId, actionId: pending.actionId, expiresAt: Date.now() + this.approvalTtlMs });
    this.result(pending.requester, pending.requestId, { kind: "confirm", approved });
  }

  private expire(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.result(pending.requester, pending.requestId, { kind: "confirm", approved: false });
  }

  private apply(peer: Peer, requestId: string, rawActionId: string): void {
    if (!this.mutable(peer, requestId)) return;
    if (!allowedAction(rawActionId)) return this.error(peer, requestId, "unknown_action", "Unknown action.");
    const mitigation = this.state.mitigations.find((item) => item.actionId === rawActionId);
    if (!mitigation?.passed) return this.error(peer, requestId, "not_passed", "Mitigation has not passed.");
    const approval = this.approvals.get(rawActionId);
    if (!approval || approval.mitigationId !== mitigation.id || approval.expiresAt <= Date.now()) {
      this.approvals.delete(rawActionId);
      return this.error(peer, requestId, "needs_human_confirm", "Fresh commander approval is required.");
    }
    this.approvals.delete(rawActionId);
    this.scenario = { ...this.scenario, actionId: rawActionId, appliedAt: Date.now() };
    if (!this.state.appliedActions.includes(rawActionId)) this.state.appliedActions.push(rawActionId);
    const status = snapshotAt(this.scenario, Date.now());
    this.broadcastState();
    this.broadcast({ type: "status", ...status });
    this.result(peer, requestId, { kind: "apply", applied: true, status });
  }

  private mutable(peer: Peer, requestId: string): boolean {
    if (this.state.phase !== "resolved") return true;
    this.error(peer, requestId, "room_resolved", "The room is resolved.");
    return false;
  }

  private ensureStatusTimer(): void {
    if (this.statusTimer) return;
    this.broadcast({ type: "status", ...FAULTY_STATUS });
    this.statusTimer = setInterval(() => {
      const status = snapshotAt(this.scenario, Date.now());
      this.broadcast({ type: "status", ...status });
      if (this.state.appliedActions.includes("scale_pool:default") && status.errorRate < 0.02) {
        this.state.phase = "resolved";
        this.state.resolvedAt = nowSeconds();
        this.activity("storefront-api recovered after the pool was restored.");
        this.broadcastState();
        clearInterval(this.statusTimer);
        this.statusTimer = undefined;
      }
    }, 2_000);
  }

  private restartIncident(): void {
    this.scenario = { armed: true, armedAt: Date.now(), actionId: null, appliedAt: null };
    if (this.bot.joinTimer) clearTimeout(this.bot.joinTimer);
    if (this.bot.hypothesisTimer) clearTimeout(this.bot.hypothesisTimer);
    this.bot.peer = undefined;
    this.bot.hypothesisId = undefined;
    this.bot.evidenceSeen = false;
    this.bot.countered = false;
    this.bot.joinTimer = undefined;
    this.bot.hypothesisTimer = undefined;
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
    this.approvals.clear();
    this.state.phase = "triage";
    this.state.incidentStartedAt = nowSeconds();
    this.state.resolvedAt = null;
    this.state.members = [];
    this.state.hypotheses = [];
    this.state.mitigations = [];
    this.state.appliedActions = [];
    this.state.log = [];
    for (const item of [...this.peers]) {
      if (item.isBot) this.peers.delete(item);
      else delete item.memberId;
    }
    this.broadcastState();
  }

  private armBot(): void {
    if (this.bot.peer || this.bot.joinTimer) return;
    this.bot.joinTimer = setTimeout(() => {
      const fakeSocket = { readyState: WebSocket.OPEN, send() {}, close() {} } as unknown as WebSocket;
      const peer: Peer = {
        socket: fakeSocket,
        demo: true,
        isBot: true,
        commanderAuthorized: false,
        requests: new Map(),
      };
      this.bot.peer = peer;
      this.peers.add(peer);
      this.join(peer, "Responder 2", "responder");
    }, 1_000);
    this.bot.hypothesisTimer = setTimeout(() => {
      const peer = this.bot.peer;
      if (!peer) return;
      this.proposeHypothesis(peer, {
        type: "propose_hypothesis",
        requestId: "bot-hypothesis",
        title: "The new-checkout flag caused the errors",
        evidence: "The flag changed this morning and checkout is failing.",
        confidence: 0.35,
      });
      this.bot.hypothesisId = this.state.hypotheses.at(-1)?.id;
      this.botCounter();
    }, 9_500);
  }

  private botCounter(): void {
    if (!this.bot.peer || !this.bot.hypothesisId || !this.bot.evidenceSeen || this.bot.countered) return;
    this.bot.countered = true;
    this.counter(this.bot.peer, "bot-counter", this.bot.hypothesisId, "The error timeline starts before new-checkout was enabled; the flag is not causal.");
  }

  private botVote(mitigationId: string): void {
    if (!this.bot.peer?.memberId) return;
    this.vote(this.bot.peer, `bot-vote-${mitigationId}`, mitigationId, "yes");
  }

  private disconnect(peer: Peer): void {
    this.peers.delete(peer);
    const member = this.member(peer.memberId);
    if (member) member.agentActive = false;
    recomputeMitigations(this.state);
    this.broadcastState();
  }

  private member(id?: string): Member | undefined {
    return id ? this.state.members.find((member) => member.id === id) : undefined;
  }

  private name(peer: Peer): string {
    return this.member(peer.memberId)?.name ?? "Unknown member";
  }

  private activity(text: string): void {
    this.state.log.push({ t: nowSeconds(), text });
  }

  private result(peer: Peer, requestId: string, data: ToolResultData): void {
    const message: ServerMessage = { type: "tool_result", requestId, data };
    const tracked = peer.requests.get(requestId);
    if (tracked) tracked.response = message;
    this.send(peer, message);
  }

  private error(peer: Peer, requestId: string | undefined, code: string, message: string): void {
    const response: ServerMessage = { type: "error", ...(requestId ? { requestId } : {}), code, message };
    if (requestId && code !== "request_id_reused") {
      const tracked = peer.requests.get(requestId);
      if (tracked) tracked.response = response;
    }
    this.send(peer, response);
  }

  private broadcastState(): void {
    this.broadcast({ type: "state", state: clone(this.state) });
  }

  private broadcast(message: ServerMessage): void {
    for (const peer of this.peers) this.send(peer, message);
  }

  private send(peer: Peer, message: ServerMessage): void {
    if (peer.isBot) return;
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
  }
}

export interface ProtocolHarness {
  readonly httpOrigin: string;
  readonly wsOrigin: string;
  reset(): void;
  setApprovalTtl(milliseconds: number): void;
  close(): Promise<void>;
}

export async function startProtocolHarness(commanderToken = "test-commander-token"): Promise<ProtocolHarness> {
  const rooms = new Map<string, HarnessRoom>();
  let approvalTtlMs = 60_000;
  const server: Server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/rooms\/([A-Za-z0-9_-]{1,80})\/ws$/.exec(url.pathname);
    if (!match) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      const roomId = match[1] ?? ROOM_ID;
      const room = rooms.get(roomId) ?? new HarnessRoom(roomId, approvalTtlMs);
      rooms.set(roomId, room);
      room.connect(
        webSocket,
        url.searchParams.get("demo") === "1",
        url.searchParams.get("commander") === commanderToken,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Harness did not bind a TCP port.");
  const httpOrigin = `http://127.0.0.1:${address.port}`;
  return {
    httpOrigin,
    wsOrigin: httpOrigin.replace(/^http/, "ws"),
    reset() {
      for (const room of rooms.values()) room.close();
      rooms.clear();
      approvalTtlMs = 60_000;
    },
    setApprovalTtl(milliseconds: number) {
      approvalTtlMs = milliseconds;
      for (const room of rooms.values()) room.approvalTtlMs = milliseconds;
    },
    async close() {
      for (const room of rooms.values()) room.close();
      sockets.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
