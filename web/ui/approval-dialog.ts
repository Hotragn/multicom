import { ACTION_SUMMARIES } from "../../shared/tools";
import type { RoomState, VoteRationales } from "../../shared/ws-messages";
import { button, clear, element, setText, svg, textElement } from "./dom";
import { icon } from "./icons";
import { initials, memberAccent } from "./presence";
import type { Confirmation } from "./types";

export interface ApprovalDialog {
  root: HTMLDialogElement;
  render(input: {
    confirmation: Confirmation | null;
    room: RoomState | null;
    pending: boolean;
    error: string | null;
    nowMs: number;
  }): void;
  destroy(): void;
}

export interface ApprovalCallbacks {
  onDecide(approved: boolean): void;
}

const RING_RADIUS = 22;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const APPROVAL_WINDOW_SECONDS = 60;

/**
 * The commander's approve/reject overlay.
 *
 * This is the one moment in the product where a human decision is load-bearing,
 * so it takes the whole screen and states exactly what the server will do: the
 * action id the room derived from the passed mitigation, the blast radius the
 * proposer declared, who voted and why, and how long the approval lasts.
 * Nothing here is free text from the requesting agent.
 */
export function createApprovalDialog(callbacks: ApprovalCallbacks): ApprovalDialog {
  const root = element("dialog", "mc-approval");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "mc-approval-title");
  root.setAttribute("aria-describedby", "mc-approval-summary");
  root.dataset.testid = "confirm-dialog";

  const content = element("div", "mc-approval__content");

  const badge = element("p", "mc-approval__badge");
  badge.append(icon("shield"));
  badge.append(document.createTextNode("Human approval required"));

  const title = textElement("h2", "mc-approval__title", "Approve this production write?");
  title.id = "mc-approval-title";

  const action = element("div", "mc-approval__action");
  const actionId = textElement("code", "mc-approval__action-id", "");
  actionId.dataset.testid = "approval-action";
  const summary = textElement("p", "mc-approval__summary", "");
  summary.id = "mc-approval-summary";
  action.append(actionId, summary);

  const facts = element("dl", "mc-approval__facts");
  const fact = (label: string): HTMLElement => {
    const row = element("div", "mc-approval__fact");
    row.append(textElement("dt", "", label));
    const value = textElement("dd", "", "--");
    row.append(value);
    facts.append(row);
    return value;
  };
  const blastRadius = fact("Blast radius");
  const tallyValue = fact("Vote");
  const proposedBy = fact("Proposed by");

  const voters = element("div", "mc-approval__voters");
  const votersLabel = textElement("p", "mc-approval__voters-label", "Who voted, and why");
  const votersList = element("ul", "mc-approval__voters-list");
  votersList.dataset.testid = "approval-voters";
  voters.append(votersLabel, votersList);

  const expiry = element("div", "mc-approval__expiry");
  const ring = svg("svg", { class: "mc-approval__ring", viewBox: "0 0 52 52", "aria-hidden": "true" });
  const ringTrack = svg("circle", { class: "mc-approval__ring-track", cx: "26", cy: "26", r: String(RING_RADIUS) });
  const ringArc = svg("circle", {
    class: "mc-approval__ring-arc",
    cx: "26",
    cy: "26",
    r: String(RING_RADIUS),
    "stroke-dasharray": String(RING_CIRCUMFERENCE),
    "stroke-dashoffset": "0",
  });
  ring.append(ringTrack, ringArc);
  const expiryText = textElement("p", "mc-approval__expiry-text", "");
  expiryText.setAttribute("role", "timer");
  expiryText.setAttribute("aria-live", "off");
  expiry.append(ring, expiryText);

  const error = textElement("p", "mc-approval__error", "");
  error.setAttribute("role", "alert");
  error.hidden = true;

  const actions = element("div", "mc-approval__actions");
  const reject = button("mc-button mc-button--secondary", "Reject", () => callbacks.onDecide(false));
  reject.dataset.testid = "reject-mitigation";
  const approve = button("mc-button mc-button--approve", "Approve mitigation", () =>
    callbacks.onDecide(true),
  );
  approve.dataset.testid = "approve-mitigation";
  actions.append(reject, approve);

  const note = textElement(
    "p",
    "mc-approval__note",
    "One approval, one apply, sixty seconds. The room derived this action from the passed mitigation; the requesting agent cannot change it.",
  );

  content.append(badge, title, action, facts, voters, expiry, error, actions, note);
  root.append(content);

  const onCancel = (event: Event): void => {
    // Escape must not count as a decision on a production write.
    event.preventDefault();
    reject.focus();
  };
  root.addEventListener("cancel", onCancel);

  const renderVoters = (room: RoomState | null, mitigationId: string): void => {
    clear(votersList);
    const mitigation = room?.mitigations.find((candidate) => candidate.id === mitigationId);
    if (!room || !mitigation) return;
    const rationales: VoteRationales = mitigation.rationales ?? {};
    const entries = Object.entries(mitigation.votes);
    if (entries.length === 0) {
      votersList.append(
        textElement("li", "mc-approval__voter mc-approval__voter--empty", "No votes recorded"),
      );
      return;
    }
    for (const [memberId, choice] of entries) {
      const member = room.members.find((candidate) => candidate.id === memberId);
      const name = member?.name ?? "Unknown responder";
      const row = element("li", "mc-approval__voter");
      row.dataset.choice = choice;
      const avatar = textElement("span", "mc-avatar mc-avatar--small", initials(name));
      avatar.style.setProperty("--mc-avatar-accent", memberAccent(room, memberId));
      avatar.setAttribute("aria-hidden", "true");
      const body = element("div", "mc-approval__voter-body");
      body.append(textElement("p", "mc-approval__voter-name", `${name} voted ${choice}`));
      const reason = rationales[memberId];
      if (reason) body.append(textElement("p", "mc-approval__voter-reason", reason));
      row.append(avatar, body);
      votersList.append(row);
    }
  };

  return {
    root,
    render({ confirmation, room, pending, error: errorMessage, nowMs }) {
      if (!confirmation) {
        if (root.open) root.close();
        return;
      }
      const remaining = Math.max(0, confirmation.expiresAt - Math.floor(nowMs / 1_000));
      const expired = remaining === 0;

      setText(actionId, confirmation.actionId);
      setText(summary, ACTION_SUMMARIES[confirmation.actionId] ?? confirmation.actionSummary);

      const mitigation = room?.mitigations.find(
        (candidate) => candidate.id === confirmation.mitigationId,
      );
      setText(blastRadius, mitigation?.blastRadius ?? "Not stated");
      if (room && mitigation) {
        const active = new Set(
          room.members.filter((member) => member.agentActive).map((member) => member.id),
        );
        let yes = 0;
        let no = 0;
        for (const [memberId, choice] of Object.entries(mitigation.votes)) {
          if (!active.has(memberId)) continue;
          if (choice === "yes") yes += 1;
          else no += 1;
        }
        setText(tallyValue, `${yes} yes, ${no} no of ${active.size} active`);
        const proposer = room.hypotheses.find(
          (hypothesis) => hypothesis.id === mitigation.hypothesisId,
        )?.by;
        setText(
          proposedBy,
          room.members.find((member) => member.id === proposer)?.name ?? "Unknown responder",
        );
      } else {
        setText(tallyValue, "Unavailable");
        setText(proposedBy, "Unknown responder");
      }
      renderVoters(room, confirmation.mitigationId);

      const fraction = Math.min(1, remaining / APPROVAL_WINDOW_SECONDS);
      ringArc.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - fraction)));
      root.dataset.expiring = String(!expired && remaining <= 15);
      setText(
        expiryText,
        expired
          ? "This approval request has expired."
          : `Approval expires in ${remaining} ${remaining === 1 ? "second" : "seconds"}.`,
      );

      approve.disabled = pending || expired;
      reject.disabled = pending;
      setText(approve, pending ? "Sending decision..." : "Approve mitigation");
      setText(reject, expired ? "Close" : "Reject");
      setText(error, errorMessage ?? "");
      error.hidden = !errorMessage;

      if (!root.open) {
        try {
          root.showModal();
        } catch {
          root.setAttribute("open", "");
        }
        approve.focus();
      }
    },
    destroy() {
      root.removeEventListener("cancel", onCancel);
      if (root.open) root.close();
      root.remove();
    },
  };
}
