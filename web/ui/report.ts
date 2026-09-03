import { ACTION_SUMMARIES } from "../../shared/tools";
import { SERVICE_NAME } from "../../shared/scenario";
import type { RoomState, ServiceStatus } from "../../shared/ws-messages";
import { formatElapsed, formatErrorRate, formatLatency, isoTimestamp } from "./format";
import type { RubricRow } from "./rubric";

export interface RunSummaryInput {
  room: RoomState | null;
  status: ServiceStatus | null;
  rubric: RubricRow[];
  roomCode: string;
  /** Room link with any commander secret already stripped. */
  shareUrl: string;
  generatedAtMs: number;
  /** When this page saw recovery, so approval-to-recovery can be measured. */
  approvedAt: number | null;
  recoveryAt: number | null;
}

export interface ContributionLine {
  memberId: string;
  name: string;
  role: string;
  active: boolean;
  hypotheses: number;
  rebuttals: number;
  votes: number;
  rationales: number;
}

export interface RunReport {
  markdown: string;
  json: string;
  contributions: ContributionLine[];
  mttrSeconds: number | null;
  approvalToRecoverySeconds: number | null;
}

function contributions(room: RoomState | null): ContributionLine[] {
  if (!room) return [];
  return room.members.map((member) => {
    let votes = 0;
    let rationales = 0;
    let rebuttals = 0;
    for (const target of [...room.hypotheses, ...room.mitigations]) {
      if (target.votes[member.id]) votes += 1;
      if (target.rationales?.[member.id]) rationales += 1;
    }
    for (const hypothesis of room.hypotheses) {
      rebuttals += hypothesis.rebuttals.filter((rebuttal) => rebuttal.by === member.id).length;
    }
    return {
      memberId: member.id,
      name: member.name,
      role: member.role,
      active: member.agentActive,
      hypotheses: room.hypotheses.filter((hypothesis) => hypothesis.by === member.id).length,
      rebuttals,
      votes,
      rationales,
    };
  });
}

const bullet = (line: string): string => `- ${line}`;

/**
 * The artefact a judge takes away.
 *
 * Everything in it comes from this room's own state, the server-authored
 * activity log, and the rubric this page evaluated. It carries no secret: the
 * share link is built without the commander capability, and no other room's
 * data is reachable from here.
 */
export function buildRunReport(input: RunSummaryInput): RunReport {
  const { room, status, rubric } = input;
  const people = contributions(room);
  const resolvedAt = room?.resolvedAt ?? null;
  const mttrSeconds =
    room && resolvedAt !== null ? Math.max(0, resolvedAt - room.incidentStartedAt) : null;
  const approvalToRecoverySeconds =
    input.approvedAt !== null && input.recoveryAt !== null
      ? Math.max(0, input.recoveryAt - input.approvedAt)
      : null;

  const rejected = (room?.hypotheses ?? []).filter(
    (hypothesis) => hypothesis.rebuttals.length > 0,
  );
  const appliedActions = room?.appliedActions ?? [];
  const approver = (room?.members ?? []).find((member) => member.role === "commander");

  const lines: string[] = [
    `# multicom run report — room ${input.roomCode}`,
    "",
    `Generated ${new Date(input.generatedAtMs).toISOString()}`,
    "",
    "## Run",
    "",
    bullet(`Service: \`${SERVICE_NAME}\``),
    bullet(`Room: \`${room?.id ?? "unknown"}\` (${input.roomCode})`),
    bullet(`Link: ${input.shareUrl}`),
    bullet(`Phase: ${room?.phase ?? "unknown"}`),
    bullet(
      `Started: ${room ? isoTimestamp(room.incidentStartedAt) : "unknown"}${
        resolvedAt !== null ? ` · Resolved: ${isoTimestamp(resolvedAt)}` : " · not resolved"
      }`,
    ),
    bullet(`MTTR: ${mttrSeconds === null ? "not resolved" : formatElapsed(mttrSeconds)}`),
    bullet(
      `Approval to verified recovery: ${
        approvalToRecoverySeconds === null ? "not observed" : `${approvalToRecoverySeconds}s`
      }`,
    ),
    bullet(
      `Final health: ${
        status
          ? `${formatErrorRate(status.errorRate)} errors, p99 ${formatLatency(status.p99ms)}, pool ${status.pool.inUse}/${status.pool.max}`
          : "unknown"
      }`,
    ),
    "",
    "This is the same deterministic incident for every judge: deploy `1f3a` set the",
    "DB connection pool to one. Runs are therefore comparable across sessions.",
    "",
    "## Participants",
    "",
  ];

  if (people.length === 0) {
    lines.push("No participants recorded.", "");
  } else {
    lines.push("| Name | Role | Hypotheses | Rebuttals | Votes | Stated reasons |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const person of people) {
      lines.push(
        `| ${person.name} | ${person.role}${person.active ? "" : " (away)"} | ${person.hypotheses} | ${person.rebuttals} | ${person.votes} | ${person.rationales} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Hypotheses", "");
  if ((room?.hypotheses ?? []).length === 0) {
    lines.push("None raised.", "");
  } else {
    for (const hypothesis of room!.hypotheses) {
      const author = people.find((person) => person.memberId === hypothesis.by)?.name ?? hypothesis.by;
      lines.push(
        `### ${hypothesis.title}`,
        "",
        bullet(`Raised by ${author} at ${(hypothesis.confidence * 100).toFixed(0)}% confidence`),
        bullet(`Evidence: ${hypothesis.evidence}`),
      );
      if (hypothesis.rebuttals.length === 0) {
        lines.push(bullet("Rebuttals: none"));
      } else {
        for (const rebuttal of hypothesis.rebuttals) {
          const by = people.find((person) => person.memberId === rebuttal.by)?.name ?? rebuttal.by;
          lines.push(bullet(`Rebutted by ${by}: ${rebuttal.evidence}`));
        }
      }
      const linked = (room!.mitigations ?? []).filter(
        (mitigation) => mitigation.hypothesisId === hypothesis.id,
      );
      for (const mitigation of linked) {
        const yes = Object.values(mitigation.votes).filter((choice) => choice === "yes").length;
        const no = Object.values(mitigation.votes).filter((choice) => choice === "no").length;
        lines.push(
          bullet(
            `Mitigation \`${mitigation.actionId}\` — ${yes} yes / ${no} no, ${
              mitigation.passed ? "passed" : "not passed"
            }${appliedActions.includes(mitigation.actionId) ? ", applied" : ""}`,
          ),
        );
        for (const [memberId, rationale] of Object.entries(mitigation.rationales ?? {})) {
          const by = people.find((person) => person.memberId === memberId)?.name ?? memberId;
          lines.push(bullet(`  ${by} said: ${rationale}`));
        }
      }
      lines.push("");
    }
  }

  lines.push(
    "## Rejected theories",
    "",
    rejected.length === 0
      ? "None were challenged."
      : rejected
          .map((hypothesis) =>
            bullet(
              `${hypothesis.title} — ${hypothesis.rebuttals.map((rebuttal) => rebuttal.evidence).join(" ")}`,
            ),
          )
          .join("\n"),
    "",
    "## Action applied",
    "",
  );

  if (appliedActions.length === 0) {
    lines.push("No production action was applied.", "");
  } else {
    for (const action of appliedActions) {
      lines.push(bullet(`\`${action}\` — ${ACTION_SUMMARIES[action]}`));
    }
    lines.push(bullet(`Approved by: ${approver?.name ?? "unknown commander"}`), "");
  }

  lines.push("## Rubric", "");
  lines.push("| Check | Result | When | Evidence |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of rubric) {
    lines.push(
      `| ${entry.label} | ${entry.passed ? "pass" : "not yet"} | ${
        entry.at === null ? "—" : isoTimestamp(entry.at)
      } | ${entry.passed ? (entry.evidence ?? "").replace(/\|/g, "\\|") : entry.requirement.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  lines.push("## Activity log", "");
  for (const entry of room?.log ?? []) {
    lines.push(bullet(`${isoTimestamp(entry.t)} — ${entry.text}`));
  }
  lines.push("");

  const json = JSON.stringify(
    {
      generatedAt: new Date(input.generatedAtMs).toISOString(),
      roomCode: input.roomCode,
      roomId: room?.id ?? null,
      link: input.shareUrl,
      service: SERVICE_NAME,
      deterministicScenario: true,
      phase: room?.phase ?? null,
      incidentStartedAt: room ? isoTimestamp(room.incidentStartedAt) : null,
      resolvedAt: resolvedAt === null ? null : isoTimestamp(resolvedAt),
      mttrSeconds,
      approvalToRecoverySeconds,
      finalStatus: status,
      participants: people,
      hypotheses: (room?.hypotheses ?? []).map((hypothesis) => ({
        id: hypothesis.id,
        title: hypothesis.title,
        by: hypothesis.by,
        confidence: hypothesis.confidence,
        evidence: hypothesis.evidence,
        rebuttals: hypothesis.rebuttals,
        votes: hypothesis.votes,
        rationales: hypothesis.rationales ?? {},
      })),
      mitigations: (room?.mitigations ?? []).map((mitigation) => ({
        ...mitigation,
        summary: ACTION_SUMMARIES[mitigation.actionId],
        applied: appliedActions.includes(mitigation.actionId),
      })),
      appliedActions,
      approvedBy: approver?.name ?? null,
      rubric: rubric.map((entry) => ({
        id: entry.id,
        label: entry.label,
        passed: entry.passed,
        at: entry.at === null ? null : isoTimestamp(entry.at),
        evidence: entry.evidence,
        requirement: entry.requirement,
      })),
      activity: (room?.log ?? []).map((entry) => ({
        at: isoTimestamp(entry.t),
        text: entry.text,
      })),
    },
    null,
    2,
  );

  return {
    markdown: lines.join("\n"),
    json,
    contributions: people,
    mttrSeconds,
    approvalToRecoverySeconds,
  };
}
