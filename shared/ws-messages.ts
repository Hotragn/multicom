import type { ActionId, CheckId, LogWindow, RoomRole, VoteChoice } from "./tools";

// A bare approved:false cannot tell "the commander said no" from "nobody
// answered in time", so an agent may abandon a correct fix. Both drill agents
// hit this.
export type ConfirmOutcome = "granted" | "rejected" | "expired";

export type RoomPhase = "triage" | "diagnosing" | "mitigating" | "resolved";

export interface Member {
  id: string;
  name: string;
  role: RoomRole;
  agentActive: boolean;
}

export interface Rebuttal {
  by: string;
  evidence: string;
}

export interface Hypothesis {
  id: string;
  by: string;
  title: string;
  evidence: string;
  confidence: number;
  rebuttals: Rebuttal[];
  votes: Record<string, VoteChoice>;
}

export interface Mitigation {
  id: string;
  hypothesisId: string;
  actionId: ActionId;
  blastRadius: string;
  votes: Record<string, VoteChoice>;
  passed: boolean;
}

export interface ActivityEntry {
  t: number;
  text: string;
}

export interface RoomState {
  id: string;
  phase: RoomPhase;
  incidentStartedAt: number;
  resolvedAt: number | null;
  members: Member[];
  hypotheses: Hypothesis[];
  mitigations: Mitigation[];
  appliedActions: ActionId[];
  log: ActivityEntry[];
}

export interface ServiceStatus {
  errorRate: number;
  p99ms: number;
  currentDeploy: string;
  flagStates: Record<string, boolean>;
  pool: { inUse: number; max: number };
}

export type ClientMessage =
  | { type: "join"; name: string; role: RoomRole }
  | { type: "get_room_state"; requestId: string }
  | { type: "get_service_status"; requestId: string }
  | { type: "query_logs"; requestId: string; service: string; window: LogWindow; filter?: string }
  | { type: "run_check"; requestId: string; checkId: CheckId }
  | { type: "propose_hypothesis"; requestId: string; title: string; evidence: string; confidence: number }
  | { type: "counter"; requestId: string; hypothesisId: string; evidence: string }
  | { type: "propose_mitigation"; requestId: string; hypothesisId: string; actionId: ActionId; blastRadius: string }
  | { type: "vote"; requestId: string; targetId: string; choice: VoteChoice }
  | { type: "request_confirm"; requestId: string; mitigationId: string }
  | { type: "confirm"; confirmationId: string; approved: boolean }
  | { type: "apply"; requestId: string; actionId: ActionId };

export type CheckResult =
  | { checkId: "pool_in_use"; inUse: number; max: number }
  | { checkId: "flag_states"; flags: Record<string, boolean> }
  | { checkId: "deploy_diff"; deploy: string; changes: string[] }
  | { checkId: "error_timeline"; points: Array<{ t: number; errorRate: number }> };

export type ToolResultData =
  | { kind: "room_state"; state: RoomState }
  | { kind: "service_status"; status: ServiceStatus }
  | { kind: "logs"; lines: string[]; untrustedContentHint: true }
  | { kind: "check"; result: CheckResult }
  | { kind: "hypothesis"; hypothesisId: string }
  | { kind: "counter"; hypothesisId: string }
  | { kind: "mitigation"; mitigationId: string }
  | { kind: "vote"; yes: number; no: number; passed: boolean }
  | { kind: "confirm"; approved: boolean; reason: ConfirmOutcome }
  | { kind: "apply"; applied: boolean; status: ServiceStatus };

export type ServerMessage =
  | { type: "joined"; memberId: string; state: RoomState }
  | { type: "state"; state: RoomState }
  | { type: "event"; text: string }
  | ({ type: "status" } & ServiceStatus)
  | { type: "confirm_request"; confirmationId: string; mitigationId: string; actionId: ActionId; actionSummary: string; expiresAt: number }
  | { type: "tool_result"; requestId: string; data: ToolResultData }
  | { type: "error"; requestId?: string; code: string; message: string };
