import type { Mitigation, RoomState } from "../../shared/ws-messages";

export const activeMemberIds = (state: RoomState): Set<string> =>
  new Set(state.members.filter((member) => member.agentActive).map((member) => member.id));

export function tally(votes: Record<string, "yes" | "no">, present: Set<string>): { yes: number; no: number } {
  let yes = 0;
  let no = 0;
  for (const [memberId, choice] of Object.entries(votes)) {
    if (!present.has(memberId)) continue;
    if (choice === "yes") yes += 1;
    else no += 1;
  }
  return { yes, no };
}

export function recomputeMitigations(state: RoomState): void {
  const present = activeMemberIds(state);
  for (const mitigation of state.mitigations) {
    mitigation.passed = tally(mitigation.votes, present).yes > present.size / 2;
  }
}

export function mitigationTally(state: RoomState, mitigation: Mitigation): { yes: number; no: number; passed: boolean } {
  const result = tally(mitigation.votes, activeMemberIds(state));
  return { ...result, passed: result.yes > activeMemberIds(state).size / 2 };
}

export const truncate = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
