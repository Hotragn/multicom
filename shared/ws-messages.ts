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

// Keyed by member id, like votes: one standing reason per member per target.
// A bare yes/no is the weakest form of a disagreement, and an agent that
// objects to a mitigation has no other way to say why.
export type VoteRationales = Record<string, string>;

export interface Hypothesis {
  id: string;
  by: string;
  title: string;
  evidence: string;
  confidence: number;
  /**
   * The confidence this hypothesis was first posted at, present only once its
   * author has revised it. Kept alongside the current value rather than
   * replacing it, because "92% then 20% after the rebuttal" is the evidence
   * that deliberation happened; a single number cannot show a mind changing.
   */
  openedAt?: number;
  /** The author's stated reason for the revision, if they gave one. */
  revisedBecause?: string;
  rebuttals: Rebuttal[];
  votes: Record<string, VoteChoice>;
  rationales: VoteRationales;
}

export interface Mitigation {
  id: string;
  hypothesisId: string;
  actionId: ActionId;
  blastRadius: string;
  votes: Record<string, VoteChoice>;
  rationales: VoteRationales;
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
  | {
      type: "revise";
      requestId: string;
      hypothesisId: string;
      confidence: number;
      because?: string;
    }
  | { type: "propose_mitigation"; requestId: string; hypothesisId: string; actionId: ActionId; blastRadius: string }
  | { type: "vote"; requestId: string; targetId: string; choice: VoteChoice }
  | { type: "explain_vote"; requestId: string; targetId: string; rationale: string }
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
  | { kind: "revision"; hypothesisId: string; confidence: number; openedAt: number }
  | { kind: "mitigation"; mitigationId: string }
  | { kind: "vote"; yes: number; no: number; passed: boolean }
  | { kind: "rationale"; targetId: string; count: number }
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
