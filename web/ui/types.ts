import type {
  ActionId,
  CheckId,
  LogWindow,
  RoomRole,
  VoteChoice,
} from "../../shared/tools";
import type {
  RoomState,
  ServerMessage,
  ToolResultData,
} from "../../shared/ws-messages";

export type UiConnectionPhase =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export interface UiConnectionState {
  state: UiConnectionPhase;
  message?: string;
}

export interface JoinOutcome {
  memberId: string;
  state: RoomState;
}

/**
 * The room operations the interface may perform.
 *
 * Every one of these is the same method the matching WebMCP tool calls, so the
 * manual operator controls travel the same WebSocket messages an agent does and
 * hit the same server-side gates. There is deliberately no privileged path.
 * Everything past `subscribe`/`confirm` is optional so a test can mount the
 * page with a narrow stub.
 */
export interface RoomUiClient {
  subscribe(listener: (message: ServerMessage) => void): () => void;
  subscribeConnection?: (listener: (state: UiConnectionState) => void) => () => void;
  confirm(confirmationId: string, approved: boolean): void | Promise<unknown>;
  join?: (name: string, role: RoomRole, signal?: AbortSignal) => Promise<JoinOutcome>;
  getServiceStatus?: (signal?: AbortSignal) => Promise<ToolResultData>;
  queryLogs?: (
    service: string,
    window: LogWindow,
    filter: string | undefined,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  runCheck?: (checkId: CheckId, signal?: AbortSignal) => Promise<ToolResultData>;
  proposeHypothesis?: (
    title: string,
    evidence: string,
    confidence: number,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  counterHypothesis?: (
    hypothesisId: string,
    evidence: string,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  proposeMitigation?: (
    hypothesisId: string,
    actionId: ActionId,
    blastRadius: string,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  vote?: (
    targetId: string,
    choice: VoteChoice,
    signal?: AbortSignal,
  ) => void | Promise<unknown>;
  explainVote?: (
    targetId: string,
    rationale: string,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  requestHumanConfirm?: (
    mitigationId: string,
    signal?: AbortSignal,
  ) => Promise<ToolResultData>;
  applyMitigation?: (actionId: ActionId, signal?: AbortSignal) => Promise<ToolResultData>;
}

/** How the visitor is driving the room. Shown plainly, never inferred loosely. */
export type ParticipationTier = "agent" | "manual" | "scripted" | "spectating";

export interface ToolRegistrationSummary {
  status: "registered" | "unavailable" | "failed" | "pending";
  count: number;
  /** True when the browser exposed WebMCP itself rather than via the polyfill. */
  native: boolean;
  message?: string;
}

export interface WarRoomEnvironment {
  roomId: string;
  /** Short label a judge can use to tell their own sessions apart. */
  shortCode: string;
  /** Link to hand a colleague. Never carries a commander secret. */
  shareUrl: string;
  /** True when this room was provisioned for one visitor by the lobby. */
  selfServe: boolean;
  demo: boolean;
  judgeConsoleOpen: boolean;
  registration: Promise<ToolRegistrationSummary>;
  /** Provision and open a fresh room. Absent when the room server is unknown. */
  startOwnRoom?: () => Promise<void>;
  /** Reload this room with the house bot armed. */
  runScriptedDrill?: () => void;
}

export interface MountWarRoomOptions {
  now?: () => number;
  environment?: Partial<WarRoomEnvironment>;
}

export interface MountedWarRoom {
  destroy(): void;
}

export type Confirmation = Extract<ServerMessage, { type: "confirm_request" }>;
