import type { RoomState, ServiceStatus } from "../../shared/ws-messages";
import { button, clear, element, setText, textElement } from "./dom";
import { formatElapsed, formatTimestamp } from "./format";
import { icon } from "./icons";
import { buildRunReport, type RunReport } from "./report";
import { latchRubric, type RubricObservations, type RubricRow } from "./rubric";
import { evaluateRubric } from "./rubric";

export interface JudgeConsole {
  root: HTMLElement;
  render(input: {
    room: RoomState | null;
    status: ServiceStatus | null;
    observations: RubricObservations;
    roomCode: string;
    shareUrl: string;
    approvedAt: number | null;
    recoveryAt: number | null;
    nowMs: number;
  }): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

export interface JudgeCallbacks {
  onCopy(text: string, label: string): void;
  onDownload(filename: string, text: string, mimeType: string): void;
}

/**
 * The panel that helps a judge grade the run.
 *
 * It is a pure view over room state, the server-authored activity log, and what
 * this page observed. It holds no server authority, never mutates the room, and
 * cannot see another room: everything it prints came in over this room's socket.
 */
export function createJudgeConsole(callbacks: JudgeCallbacks, initiallyOpen: boolean): JudgeConsole {
  const root = element("aside", "mc-judge");
  root.dataset.testid = "judge-console";
  root.setAttribute("aria-labelledby", "mc-judge-heading");

  const toggle = element("button", "mc-judge__toggle");
  toggle.type = "button";
  toggle.dataset.testid = "judge-console-toggle";
  toggle.setAttribute("aria-controls", "mc-judge-body");
  const toggleLabel = element("span", "mc-drawer__label");
  toggleLabel.append(icon("judge"));
  const heading = textElement("h2", "mc-drawer__heading", "Judge console");
  heading.id = "mc-judge-heading";
  toggleLabel.append(heading);
  const score = textElement("span", "mc-count", "0/10");
  score.dataset.testid = "judge-score";
  toggle.append(toggleLabel, score, icon("collapse", "mc-drawer__chevron"));

  const body = element("div", "mc-judge__body");
  body.id = "mc-judge-body";

  const determinism = element("p", "mc-judge__determinism");
  determinism.append(icon("sparkle"));
  determinism.append(
    document.createTextNode(
      "Every judge gets the same scripted incident in their own isolated room, so runs are directly comparable. Nothing here is randomised.",
    ),
  );

  const rubricList = element("ol", "mc-rubric");
  rubricList.dataset.testid = "judge-rubric";

  const summary = element("section", "mc-run-summary");
  summary.dataset.testid = "run-summary";
  summary.hidden = true;
  const summaryHeading = textElement("h3", "mc-run-summary__heading", "Run summary");
  const summaryFacts = element("dl", "mc-run-summary__facts");
  const summaryPeople = element("ul", "mc-run-summary__people");
  summary.append(summaryHeading, summaryFacts, summaryPeople);

  const exports = element("div", "mc-judge__exports");
  const copyButton = button("mc-button mc-button--ghost", "Copy run report", () => {
    if (report) callbacks.onCopy(report.markdown, "Run report");
  });
  copyButton.dataset.testid = "copy-run-report";
  copyButton.prepend(icon("copy"));
  const downloadButton = button("mc-button mc-button--ghost", "Download JSON", () => {
    if (report) {
      callbacks.onDownload(`multicom-run-${currentRoomCode}.json`, report.json, "application/json");
    }
  });
  downloadButton.dataset.testid = "download-run-report";
  downloadButton.prepend(icon("download"));
  exports.append(copyButton, downloadButton);

  body.append(determinism, rubricList, summary, exports);
  root.append(toggle, body);

  let open = initiallyOpen;
  const apply = (): void => {
    root.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  };
  toggle.addEventListener("click", () => {
    open = !open;
    apply();
  });
  apply();

  let rubric: RubricRow[] = [];
  let report: RunReport | null = null;
  let currentRoomCode = "room";

  const renderRubric = (): void => {
    clear(rubricList);
    for (const entry of rubric) {
      const item = element("li", "mc-rubric__row");
      item.dataset.passed = String(entry.passed);
      item.dataset.rubricId = entry.id;
      const mark = icon(entry.passed ? "check" : "pending", "mc-rubric__mark");
      const content = element("div", "mc-rubric__content");
      content.append(textElement("p", "mc-rubric__label", entry.label));
      content.append(
        textElement(
          "p",
          "mc-rubric__evidence",
          entry.passed ? (entry.evidence ?? "") : entry.requirement,
        ),
      );
      const when = textElement(
        "span",
        "mc-rubric__when",
        entry.at === null ? (entry.passed ? "observed" : "not yet") : formatTimestamp(entry.at),
      );
      item.append(mark, content, when);
      rubricList.append(item);
    }
    const passed = rubric.filter((entry) => entry.passed).length;
    setText(score, `${passed}/${rubric.length}`);
    score.setAttribute("aria-label", `${passed} of ${rubric.length} rubric checks satisfied`);
  };

  const renderSummary = (room: RoomState | null): void => {
    const resolved = room?.phase === "resolved";
    summary.hidden = !resolved || !report;
    if (!resolved || !report) return;

    clear(summaryFacts);
    const fact = (label: string, value: string): void => {
      const wrapper = element("div", "mc-run-summary__fact");
      wrapper.append(textElement("dt", "", label));
      wrapper.append(textElement("dd", "", value));
      summaryFacts.append(wrapper);
    };
    fact("Room", currentRoomCode);
    fact("MTTR", report.mttrSeconds === null ? "not resolved" : formatElapsed(report.mttrSeconds));
    fact(
      "Approval to recovery",
      report.approvalToRecoverySeconds === null
        ? "not observed"
        : `${report.approvalToRecoverySeconds}s`,
    );
    fact("Action applied", (room?.appliedActions ?? []).join(", ") || "none");
    fact(
      "Approved by",
      room?.members.find((member) => member.role === "commander")?.name ?? "unknown",
    );

    clear(summaryPeople);
    const count = (value: number, singular: string, plural = `${singular}s`): string =>
      `${value} ${value === 1 ? singular : plural}`;
    for (const person of report.contributions) {
      const item = element("li", "mc-run-summary__person");
      item.append(textElement("span", "mc-run-summary__name", `${person.name} · ${person.role}`));
      item.append(
        textElement(
          "span",
          "mc-run-summary__deeds",
          [
            count(person.hypotheses, "theory", "theories"),
            count(person.rebuttals, "rebuttal"),
            count(person.votes, "vote"),
            count(person.rationales, "reason"),
          ].join(" · "),
        ),
      );
      summaryPeople.append(item);
    }
  };

  return {
    root,
    render(input) {
      currentRoomCode = input.roomCode;
      rubric = latchRubric(rubric, evaluateRubric(input.room, input.status, input.observations));
      report = buildRunReport({
        room: input.room,
        status: input.status,
        rubric,
        roomCode: input.roomCode,
        shareUrl: input.shareUrl,
        generatedAtMs: input.nowMs,
        approvedAt: input.approvedAt,
        recoveryAt: input.recoveryAt,
      });
      const hasReport = report !== null;
      copyButton.disabled = !hasReport;
      downloadButton.disabled = !hasReport;
      renderRubric();
      renderSummary(input.room);
    },
    setOpen(next) {
      open = next;
      apply();
    },
    isOpen() {
      return open;
    },
  };
}
