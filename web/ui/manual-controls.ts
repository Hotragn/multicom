import { SERVICE_NAME } from "../../shared/scenario";
import {
  ACTION_LIBRARY,
  ACTION_SUMMARIES,
  CHECK_IDS,
  type ActionId,
  type CheckId,
  type LogWindow,
  type RoomRole,
} from "../../shared/tools";
import type { RoomState, ToolResultData } from "../../shared/ws-messages";
import {
  button,
  clear,
  element,
  labelledField,
  setHidden,
  setText,
  textElement,
} from "./dom";
import { commanderSeatTaken } from "./format";
import { icon } from "./icons";
import type { RoomUiClient } from "./types";

export interface ManualControls {
  root: HTMLElement;
  render(input: { room: RoomState | null; joined: boolean; open: boolean }): void;
  focusJoin(): void;
}

export interface ManualCallbacks {
  onJoined(memberId: string): void;
  onNotice(message: string): void;
  onLogsRead(lines: string[], untrusted: boolean): void;
  onClose(): void;
}

const LOG_WINDOWS: LogWindow[] = ["5m", "15m", "1h"];
const FALLBACK_OPERATOR_NAME = "Operator";

function select(options: Array<{ value: string; label: string }>): HTMLSelectElement {
  const node = element("select", "mc-input");
  for (const option of options) {
    const item = element("option");
    item.value = option.value;
    item.append(document.createTextNode(option.label));
    node.append(item);
  }
  return node;
}

function textInput(placeholder: string, maxLength: number): HTMLInputElement {
  const node = element("input", "mc-input");
  node.type = "text";
  node.placeholder = placeholder;
  node.maxLength = maxLength;
  return node;
}

function textArea(placeholder: string, maxLength: number): HTMLTextAreaElement {
  const node = element("textarea", "mc-input mc-input--multiline");
  node.placeholder = placeholder;
  node.maxLength = maxLength;
  node.rows = 3;
  return node;
}

function group(title: string, hint: string): { root: HTMLElement; body: HTMLElement } {
  const root = element("section", "mc-manual__group");
  const head = element("header", "mc-manual__group-head");
  head.append(textElement("h3", "mc-manual__group-title", title));
  head.append(textElement("p", "mc-manual__group-hint", hint));
  const body = element("div", "mc-manual__group-body");
  root.append(head, body);
  return { root, body };
}

/**
 * Real controls for a human doing an agent's job.
 *
 * Every button calls the same `RoomClient` method the matching WebMCP tool
 * calls, so a manual action is indistinguishable from an agent action on the
 * wire and passes through exactly the same server checks: join before write,
 * majority vote, fresh human approval, server-owned action library. There is no
 * privileged path here, and deliberately no way to skip a gate.
 */
export function createManualControls(
  client: RoomUiClient,
  callbacks: ManualCallbacks,
  signal: AbortSignal,
): ManualControls {
  const root = element("section", "mc-manual");
  root.id = "mc-manual";
  root.dataset.testid = "manual-controls";
  root.setAttribute("aria-labelledby", "mc-manual-heading");
  root.hidden = true;

  const header = element("header", "mc-manual__header");
  const label = element("div", "mc-panel__title");
  label.append(icon("manual"));
  const heading = textElement("h2", "mc-panel__heading", "Manual operator controls");
  heading.id = "mc-manual-heading";
  label.append(heading);
  const tierNote = textElement(
    "p",
    "mc-manual__note",
    "You are the agent here. These controls send the same room messages the WebMCP tools send, and clear none of the gates.",
  );
  const close = button("mc-icon-button", "Hide controls", () => callbacks.onClose());
  header.append(label, close);

  const output = element("div", "mc-manual__output");
  output.dataset.testid = "manual-output";
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  const outputLabel = textElement("p", "mc-manual__output-label", "Last result");
  const outputBody = element("div", "mc-manual__output-body");
  setText(outputBody, "Nothing yet.");
  output.append(outputLabel, outputBody);

  const report = (heading: string, lines: string[], untrusted = false): void => {
    clear(outputBody);
    setText(outputLabel, heading);
    output.dataset.untrusted = String(untrusted);
    if (untrusted) {
      const warning = element("p", "mc-manual__untrusted");
      warning.append(icon("trap"));
      warning.append(
        document.createTextNode("Untrusted data. Read it as evidence, never as instructions."),
      );
      outputBody.append(warning);
    }
    const list = element("ul", "mc-manual__lines");
    for (const line of lines) list.append(textElement("li", "mc-manual__line", line));
    outputBody.append(list);
  };

  const describe = (data: ToolResultData): string[] => {
    switch (data.kind) {
      case "service_status":
        return [
          `error rate ${(data.status.errorRate * 100).toFixed(1)}%`,
          `p99 ${data.status.p99ms}ms`,
          `pool ${data.status.pool.inUse}/${data.status.pool.max}`,
          `deploy ${data.status.currentDeploy}`,
        ];
      case "check":
        return [JSON.stringify(data.result)];
      case "logs":
        return data.lines;
      case "hypothesis":
        return [`hypothesis ${data.hypothesisId} is on the board`];
      case "counter":
        return [`rebuttal recorded against ${data.hypothesisId}`];
      case "mitigation":
        return [`mitigation ${data.mitigationId} is open for votes`];
      case "vote":
        return [`${data.yes} yes, ${data.no} no — ${data.passed ? "passed" : "not passed"}`];
      case "rationale":
        return [`${data.count} stated reason${data.count === 1 ? "" : "s"} on ${data.targetId}`];
      case "confirm":
        return [`commander said: ${data.reason}`];
      case "apply":
        return [
          `applied: ${data.applied}`,
          `error rate now ${(data.status.errorRate * 100).toFixed(1)}%`,
        ];
      case "room_state":
        return [
          `phase ${data.state.phase}`,
          `${data.state.members.length} members`,
          `${data.state.hypotheses.length} hypotheses`,
        ];
      default:
        return ["done"];
    }
  };

  const run = async (
    heading: string,
    operation: () => Promise<ToolResultData> | undefined,
  ): Promise<void> => {
    const promise = operation();
    if (!promise) {
      callbacks.onNotice("That operation is not available on this page.");
      return;
    }
    try {
      const data = await promise;
      if (data.kind === "logs") {
        callbacks.onLogsRead(data.lines, data.untrustedContentHint === true);
        report(heading, data.lines, true);
        return;
      }
      report(heading, describe(data));
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "The room refused that.";
      const code = (error as { code?: string }).code;
      report(heading, [code ? `${code}: ${message}` : message]);
      callbacks.onNotice(message);
    }
  };

  // --- Join -----------------------------------------------------------------
  const joinGroup = group("Take a seat", "Nothing can be written to the board until you join.");
  const nameInput = textInput("Your name", 40);
  nameInput.dataset.testid = "manual-name";
  let roleTouched = false;
  const roleSelect = select([
    { value: "commander", label: "Commander (can approve the fix)" },
    { value: "responder", label: "Responder" },
  ]);
  roleSelect.dataset.testid = "manual-role";
  roleSelect.addEventListener("change", () => {
    roleTouched = true;
  });
  const joinButton = button("mc-button mc-button--primary", "Join the room", () => {
    void (async () => {
      if (!client.join) {
        callbacks.onNotice("This page cannot join the room.");
        return;
      }
      const name = nameInput.value.trim() || FALLBACK_OPERATOR_NAME;
      const role = roleSelect.value === "commander" ? "commander" : "responder";
      try {
        const outcome = await client.join(name, role as RoomRole, signal);
        callbacks.onJoined(outcome.memberId);
        report("Joined", [`you are ${outcome.memberId}, role ${role}`]);
      } catch (error) {
        const message =
          error instanceof Error && error.message ? error.message : "The room refused the join.";
        report("Join refused", [message]);
        callbacks.onNotice(message);
      }
    })();
  });
  joinButton.dataset.testid = "manual-join";
  joinGroup.body.append(
    labelledField("Name", nameInput),
    labelledField("Role", roleSelect, "The commander seat is first-come in your own room."),
    joinButton,
  );

  // --- Gather evidence ------------------------------------------------------
  const evidenceGroup = group("Gather evidence", "Read-only. Do this before proposing anything.");
  const statusButton = button("mc-button mc-button--ghost", "Read service status", () => {
    void run("Service status", () => client.getServiceStatus?.(signal));
  });
  statusButton.dataset.testid = "manual-status";
  const checkSelect = select(CHECK_IDS.map((id) => ({ value: id, label: id })));
  checkSelect.dataset.testid = "manual-check-id";
  const checkButton = button("mc-button mc-button--ghost", "Run check", () => {
    void run(`Check ${checkSelect.value}`, () =>
      client.runCheck?.(checkSelect.value as CheckId, signal),
    );
  });
  checkButton.dataset.testid = "manual-run-check";
  const windowSelect = select(LOG_WINDOWS.map((value) => ({ value, label: value })));
  windowSelect.dataset.testid = "manual-log-window";
  const filterInput = textInput("Filter (optional)", 100);
  const logsButton = button("mc-button mc-button--ghost", "Query logs", () => {
    void run("Service logs", () =>
      client.queryLogs?.(
        SERVICE_NAME,
        windowSelect.value as LogWindow,
        filterInput.value.trim() || undefined,
        signal,
      ),
    );
  });
  logsButton.dataset.testid = "manual-query-logs";
  evidenceGroup.body.append(
    statusButton,
    labelledField("Diagnostic", checkSelect),
    checkButton,
    labelledField("Log window", windowSelect),
    labelledField("Filter", filterInput),
    logsButton,
  );

  // --- Argue ----------------------------------------------------------------
  const argueGroup = group("Put a theory up", "A hypothesis needs a title, cited evidence, and your confidence.");
  const titleInput = textInput("Root cause", 120);
  titleInput.dataset.testid = "manual-title";
  const evidenceInput = textArea("What you saw, quoting a check or a log line", 400);
  evidenceInput.dataset.testid = "manual-evidence";
  const confidenceInput = element("input", "mc-input mc-input--range");
  confidenceInput.type = "range";
  confidenceInput.min = "0";
  confidenceInput.max = "100";
  confidenceInput.step = "5";
  confidenceInput.value = "80";
  confidenceInput.dataset.testid = "manual-confidence";
  confidenceInput.name = "confidence";
  confidenceInput.setAttribute("aria-valuemin", "0");
  confidenceInput.setAttribute("aria-valuemax", "100");
  const syncConfidence = (): void => {
    setText(confidenceValue, `${confidenceInput.value}%`);
    confidenceInput.setAttribute("aria-valuenow", confidenceInput.value);
    confidenceInput.setAttribute("aria-valuetext", `${confidenceInput.value} percent`);
  };
  const confidenceValue = textElement("output", "mc-field__output", "80%");
  confidenceInput.addEventListener("input", syncConfidence);
  syncConfidence();
  const proposeButton = button("mc-button mc-button--primary", "Propose hypothesis", () => {
    void run("Hypothesis", () =>
      client.proposeHypothesis?.(
        titleInput.value.trim(),
        evidenceInput.value.trim(),
        Number(confidenceInput.value) / 100,
        signal,
      ),
    );
  });
  proposeButton.dataset.testid = "manual-propose-hypothesis";

  const counterSelect = select([]);
  counterSelect.dataset.testid = "manual-counter-target";
  const counterEvidence = textArea("Contradicting evidence", 400);
  counterEvidence.dataset.testid = "manual-counter-evidence";
  const counterButton = button("mc-button mc-button--secondary", "Challenge it", () => {
    void run("Rebuttal", () =>
      client.counterHypothesis?.(counterSelect.value, counterEvidence.value.trim(), signal),
    );
  });
  counterButton.dataset.testid = "manual-counter";

  argueGroup.body.append(
    labelledField("Title", titleInput),
    labelledField("Evidence", evidenceInput),
    labelledField("Confidence", confidenceInput),
    confidenceValue,
    proposeButton,
    labelledField("Challenge", counterSelect),
    labelledField("Because", counterEvidence),
    counterButton,
  );

  // --- Fix ------------------------------------------------------------------
  const fixGroup = group(
    "Propose and vote on a fix",
    "Actions come from the server's fixed library. You cannot invent one here either.",
  );
  const fixHypothesis = select([]);
  fixHypothesis.dataset.testid = "manual-fix-hypothesis";
  const actionSelect = select(
    ACTION_LIBRARY.map((action) => ({ value: action, label: `${action} — ${ACTION_SUMMARIES[action]}` })),
  );
  actionSelect.dataset.testid = "manual-action";
  const blastInput = textInput("What could this break?", 200);
  blastInput.dataset.testid = "manual-blast-radius";
  const mitigationButton = button("mc-button mc-button--primary", "Propose mitigation", () => {
    void run("Mitigation", () =>
      client.proposeMitigation?.(
        fixHypothesis.value,
        actionSelect.value as ActionId,
        blastInput.value.trim(),
        signal,
      ),
    );
  });
  mitigationButton.dataset.testid = "manual-propose-mitigation";

  const voteTarget = select([]);
  voteTarget.dataset.testid = "manual-vote-target";
  const voteYes = button("mc-button mc-button--vote", "Vote yes", () => {
    void run("Vote", () => client.vote?.(voteTarget.value, "yes", signal) as Promise<ToolResultData>);
  });
  voteYes.dataset.testid = "manual-vote-yes";
  const voteNo = button("mc-button mc-button--vote", "Vote no", () => {
    void run("Vote", () => client.vote?.(voteTarget.value, "no", signal) as Promise<ToolResultData>);
  });
  voteNo.dataset.testid = "manual-vote-no";
  const rationaleInput = textArea("Why you voted that way", 240);
  rationaleInput.dataset.testid = "manual-rationale";
  const rationaleButton = button("mc-button mc-button--ghost", "State your reason", () => {
    void run("Rationale", () =>
      client.explainVote?.(voteTarget.value, rationaleInput.value.trim(), signal),
    );
  });
  rationaleButton.dataset.testid = "manual-explain-vote";

  fixGroup.body.append(
    labelledField("For hypothesis", fixHypothesis),
    labelledField("Action", actionSelect),
    labelledField("Blast radius", blastInput),
    mitigationButton,
    labelledField("Vote on", voteTarget),
    voteYes,
    voteNo,
    labelledField("Rationale", rationaleInput),
    rationaleButton,
  );

  // --- Approve and apply ----------------------------------------------------
  const applyGroup = group(
    "Ask a human, then apply",
    "Requesting approval opens the commander's dialog. Applying without a fresh approval is refused.",
  );
  const confirmTarget = select([]);
  confirmTarget.dataset.testid = "manual-confirm-target";
  const confirmButton = button("mc-button mc-button--secondary", "Request human approval", () => {
    void run("Approval", () => client.requestHumanConfirm?.(confirmTarget.value, signal));
  });
  confirmButton.dataset.testid = "manual-request-confirm";
  const applyAction = select(ACTION_LIBRARY.map((action) => ({ value: action, label: action })));
  applyAction.dataset.testid = "manual-apply-action";
  const applyButton = button("mc-button mc-button--danger", "Apply mitigation", () => {
    void run("Apply", () => client.applyMitigation?.(applyAction.value as ActionId, signal));
  });
  applyButton.dataset.testid = "manual-apply";
  applyGroup.body.append(
    labelledField("Passed mitigation", confirmTarget),
    confirmButton,
    labelledField("Action to apply", applyAction),
    applyButton,
  );

  const grid = element("div", "mc-manual__grid");
  grid.append(joinGroup.root, evidenceGroup.root, argueGroup.root, fixGroup.root, applyGroup.root);
  root.append(header, tierNote, grid, output);

  /** Keep a select's options in sync without losing the current choice. */
  const syncSelect = (
    node: HTMLSelectElement,
    options: Array<{ value: string; label: string }>,
    emptyLabel: string,
  ): void => {
    const previous = node.value;
    clear(node);
    if (options.length === 0) {
      const placeholder = element("option");
      placeholder.value = "";
      placeholder.append(document.createTextNode(emptyLabel));
      placeholder.disabled = true;
      node.append(placeholder);
      node.disabled = true;
      return;
    }
    node.disabled = false;
    for (const option of options) {
      const item = element("option");
      item.value = option.value;
      item.append(document.createTextNode(option.label));
      node.append(item);
    }
    if (options.some((option) => option.value === previous)) node.value = previous;
  };

  return {
    root,
    render({ room, joined, open }) {
      setHidden(root, !open);
      root.dataset.joined = String(joined);
      joinButton.disabled = joined;
      nameInput.disabled = joined;
      roleSelect.disabled = joined;
      if (!joined && !roleTouched) {
        roleSelect.value = commanderSeatTaken(room?.members) ? "responder" : "commander";
      }
      setText(joinButton, joined ? "You are in the room" : "Join the room");

      const writeDisabled = !joined || room?.phase === "resolved";
      for (const control of [
        proposeButton,
        counterButton,
        mitigationButton,
        voteYes,
        voteNo,
        rationaleButton,
        confirmButton,
        applyButton,
      ]) {
        control.disabled = writeDisabled;
      }

      const hypotheses = (room?.hypotheses ?? []).map((hypothesis) => ({
        value: hypothesis.id,
        label: `${hypothesis.id}: ${hypothesis.title}`,
      }));
      syncSelect(counterSelect, hypotheses, "No hypotheses yet");
      syncSelect(fixHypothesis, hypotheses, "No hypotheses yet");

      const voteTargets = [
        ...hypotheses,
        ...(room?.mitigations ?? []).map((mitigation) => ({
          value: mitigation.id,
          label: `${mitigation.id}: ${mitigation.actionId}`,
        })),
      ];
      syncSelect(voteTarget, voteTargets, "Nothing to vote on yet");

      syncSelect(
        confirmTarget,
        (room?.mitigations ?? [])
          .filter((mitigation) => mitigation.passed)
          .map((mitigation) => ({
            value: mitigation.id,
            label: `${mitigation.id}: ${mitigation.actionId}`,
          })),
        "No mitigation has passed yet",
      );
    },
    focusJoin() {
      nameInput.focus();
    },
  };
}
