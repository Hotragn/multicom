import { ACTION_SUMMARIES, type VoteChoice } from "../../shared/tools";
import { FEATURE_FLAG } from "../../shared/scenario";
import type {
  Hypothesis,
  Mitigation,
  RoomState,
  VoteRationales,
} from "../../shared/ws-messages";
import { button, clear, element, setHidden, setText, textElement } from "./dom";
import { clamp, formatConfidence } from "./format";
import { icon, type IconName } from "./icons";
import { initials, memberAccent } from "./presence";
import type { Confirmation } from "./types";

export interface InvestigationSection {
  root: HTMLElement;
  render(input: {
    room: RoomState | null;
    pendingVotes: Set<string>;
    canVote: boolean;
    confirmation: Confirmation | null;
  }): void;
}

export interface InvestigationCallbacks {
  onVote?: (targetId: string, choice: VoteChoice) => void;
}

/**
 * Which disclosures the reader has opened.
 *
 * The board re-renders on every state broadcast, which is every two seconds
 * while the incident is live. Without this, a rebuttal or a stated reason
 * snapped shut under anyone trying to read it.
 */
class Disclosures {
  private readonly open = new Set<string>();

  bind(node: HTMLDetailsElement, key: string): void {
    node.open = this.open.has(key);
    node.addEventListener("toggle", () => {
      if (node.open) this.open.add(key);
      else this.open.delete(key);
    });
  }
}

/** The chain a judge is being asked to follow, in order. */
const STAGES: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "evidence", label: "Evidence", icon: "evidence" },
  { id: "hypothesis", label: "Hypothesis", icon: "hypothesis" },
  { id: "rebuttal", label: "Rebuttal", icon: "rebuttal" },
  { id: "mitigation", label: "Mitigation", icon: "mitigation" },
  { id: "vote", label: "Vote", icon: "vote" },
  { id: "approval", label: "Human approval", icon: "approval" },
  { id: "applied", label: "Applied", icon: "applied" },
  { id: "verified", label: "Verified", icon: "recovered" },
];

interface Tally {
  yes: number;
  no: number;
}

function countVotes(room: RoomState, votes: Record<string, VoteChoice>): Tally {
  const active = new Set(
    room.members.filter((member) => member.agentActive).map((member) => member.id),
  );
  return Object.entries(votes).reduce<Tally>(
    (result, [memberId, choice]) => {
      if (!active.has(memberId)) return result;
      result[choice] += 1;
      return result;
    },
    { yes: 0, no: 0 },
  );
}

function memberName(room: RoomState, memberId: string): string {
  return room.members.find((member) => member.id === memberId)?.name ?? "Unknown responder";
}

function stateChip(className: string, label: string, iconName?: IconName): HTMLSpanElement {
  const chip = element("span", `mc-state-label ${className}`);
  if (iconName) chip.append(icon(iconName));
  chip.append(document.createTextNode(label));
  return chip;
}

function authorBadge(room: RoomState, memberId: string): HTMLElement {
  const wrapper = element("span", "mc-byline");
  const avatar = textElement("span", "mc-avatar mc-avatar--small", initials(memberName(room, memberId)));
  avatar.style.setProperty("--mc-avatar-accent", memberAccent(room, memberId));
  avatar.setAttribute("aria-hidden", "true");
  wrapper.append(avatar, textElement("span", "mc-byline__name", memberName(room, memberId)));
  return wrapper;
}

/**
 * The stated reasons behind votes.
 *
 * Every word here is peer-authored, so it is appended as text and nothing else.
 */
function renderRationales(
  room: RoomState,
  votes: Record<string, VoteChoice>,
  rationales: VoteRationales | undefined,
  label: string,
  disclosures: Disclosures,
  key: string,
): HTMLElement | null {
  const entries = Object.entries(rationales ?? {}).filter(([memberId]) => votes[memberId]);
  if (entries.length === 0) return null;
  const block = element("details", "mc-rationales");
  block.dataset.testid = "vote-rationales";
  const summary = textElement(
    "summary",
    "mc-rationales__summary",
    entries.length === 1 ? "Read 1 stated reason" : `Read ${entries.length} stated reasons`,
  );
  summary.setAttribute("aria-label", `${entries.length} stated reasons on ${label}`);
  const list = element("ul", "mc-rationales__list");
  for (const [memberId, text] of entries) {
    const row = element("li", "mc-rationale");
    row.append(
      textElement(
        "p",
        "mc-rationale__author",
        `${memberName(room, memberId)} voted ${votes[memberId]}`,
      ),
    );
    row.append(textElement("p", "mc-rationale__text", text));
    list.append(row);
  }
  block.append(summary, list);
  disclosures.bind(block, key);
  return block;
}

function mitigationStage(
  room: RoomState,
  mitigation: Mitigation,
  confirmation: Confirmation | null,
): { className: string; label: string; icon: IconName; stage: string } {
  if (room.appliedActions.includes(mitigation.actionId)) {
    return room.phase === "resolved"
      ? { className: "mc-state-label--resolved", label: "Applied and verified", icon: "recovered", stage: "verified" }
      : { className: "mc-state-label--resolved", label: "Applied", icon: "applied", stage: "applied" };
  }
  if (confirmation?.mitigationId === mitigation.id) {
    return { className: "mc-state-label--warning", label: "Commander deciding", icon: "approval", stage: "approval" };
  }
  if (mitigation.passed) {
    return { className: "mc-state-label--warning", label: "Awaiting commander", icon: "approval", stage: "approval" };
  }
  return { className: "mc-state-label--neutral", label: "Voting open", icon: "vote", stage: "vote" };
}

function renderMitigation(
  room: RoomState,
  mitigation: Mitigation,
  pendingVotes: Set<string>,
  canVote: boolean,
  confirmation: Confirmation | null,
  callbacks: InvestigationCallbacks,
  disclosures: Disclosures,
): HTMLLIElement {
  const tally = countVotes(room, mitigation.votes);
  const stage = mitigationStage(room, mitigation, confirmation);
  const item = element("li", "mc-step mc-step--mitigation");
  const card = element("article", "mc-card mc-mitigation");
  card.dataset.mitigationId = mitigation.id;
  card.dataset.actionId = mitigation.actionId;
  card.dataset.passed = String(mitigation.passed);
  card.dataset.stage = stage.stage;
  card.dataset.testid = "mitigation-card";

  const header = element("header", "mc-card__header");
  const identity = element("div", "mc-card__identity");
  identity.append(textElement("p", "mc-card__eyebrow", "Proposed mitigation"));
  identity.append(
    textElement("h4", "mc-card__title mc-card__title--action", mitigation.actionId),
  );
  header.append(identity, stateChip(stage.className, stage.label, stage.icon));

  const summary = textElement("p", "mc-mitigation__summary", ACTION_SUMMARIES[mitigation.actionId]);

  const blastRadius = element("div", "mc-blast-radius");
  const blastLabel = element("div", "mc-blast-radius__label");
  blastLabel.append(icon("trap"));
  blastLabel.append(document.createTextNode("Possible impact"));
  blastRadius.append(blastLabel, textElement("p", "", mitigation.blastRadius));

  const voteArea = element("div", "mc-vote-area");
  const meter = element("div", "mc-vote-meter");
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", `${tally.yes} yes, ${tally.no} no`);
  const total = Math.max(1, tally.yes + tally.no);
  const yesBar = element("span", "mc-vote-meter__yes");
  yesBar.style.setProperty("--mc-share", `${(tally.yes / total) * 100}%`);
  const noBar = element("span", "mc-vote-meter__no");
  noBar.style.setProperty("--mc-share", `${(tally.no / total) * 100}%`);
  meter.append(yesBar, noBar);
  const voteSummary = textElement("p", "mc-vote-area__summary", `${tally.yes} yes, ${tally.no} no`);
  voteSummary.setAttribute("aria-live", "polite");

  const actions = element("div", "mc-vote-actions");
  const pending = pendingVotes.has(mitigation.id);
  const disabled = !canVote || pending || room.phase === "resolved";
  for (const choice of ["yes", "no"] as const) {
    const label = choice === "yes" ? (pending ? "Voting..." : "Vote yes") : "Vote no";
    const control = button(
      `mc-button mc-button--vote mc-button--vote-${choice}`,
      label,
      () => callbacks.onVote?.(mitigation.id, choice),
    );
    control.disabled = disabled;
    control.dataset.choice = choice;
    control.setAttribute("aria-label", `Vote ${choice} on ${mitigation.actionId}`);
    actions.append(control);
  }
  voteArea.append(meter, voteSummary, actions);
  if (!canVote) {
    voteArea.append(
      textElement(
        "p",
        "mc-vote-area__hint",
        "Voting runs through your agent, or through manual control below.",
      ),
    );
  }

  card.append(header, summary, blastRadius, voteArea);
  const reasons = renderRationales(
    room,
    mitigation.votes,
    mitigation.rationales,
    mitigation.actionId,
    disclosures,
    `rationales:${mitigation.id}`,
  );
  if (reasons) card.append(reasons);
  item.append(card);
  return item;
}

function hypothesisVerdict(
  room: RoomState,
  hypothesis: Hypothesis,
  tally: Tally,
): { className: string; label: string; icon: IconName } {
  const linked = room.mitigations.filter(
    (mitigation) => mitigation.hypothesisId === hypothesis.id,
  );
  if (linked.some((mitigation) => room.appliedActions.includes(mitigation.actionId))) {
    return { className: "mc-state-label--resolved", label: "Acted on", icon: "check" };
  }
  // "Rejected" needs an actual majority against it. A rebuttal with nobody
  // having voted yet is a challenge, not a verdict.
  if (hypothesis.rebuttals.length > 0 && tally.no > tally.yes) {
    return { className: "mc-state-label--negative", label: "Rejected", icon: "refused" };
  }
  if (hypothesis.rebuttals.length > 0) {
    return { className: "mc-state-label--warning", label: "Challenged", icon: "rebuttal" };
  }
  if (tally.yes > tally.no && tally.yes > 0) {
    return { className: "mc-state-label--positive", label: "Leading", icon: "check" };
  }
  return { className: "mc-state-label--neutral", label: "Open", icon: "pending" };
}

function renderHypothesisThread(
  room: RoomState,
  hypothesis: Hypothesis,
  pendingVotes: Set<string>,
  canVote: boolean,
  confirmation: Confirmation | null,
  callbacks: InvestigationCallbacks,
  disclosures: Disclosures,
): HTMLLIElement {
  const tally = countVotes(room, hypothesis.votes);
  const verdict = hypothesisVerdict(room, hypothesis, tally);
  const item = element("li", "mc-thread");
  const card = element("article", "mc-card mc-hypothesis");
  card.dataset.hypothesisId = hypothesis.id;
  card.dataset.testid = "hypothesis-card";
  card.dataset.verdict = verdict.label.toLowerCase().replace(/\s+/g, "-");
  // The red herring is worth calling out visually, but only from the fixed
  // scenario's own flag name — never from anything a peer typed.
  const mentionsRedHerring = hypothesis.title.toLowerCase().includes(FEATURE_FLAG);
  if (mentionsRedHerring) card.dataset.redHerring = "true";
  if (hypothesis.rebuttals.length > 0) card.classList.add("mc-card--challenged");

  const header = element("header", "mc-card__header");
  const identity = element("div", "mc-card__identity");
  identity.append(authorBadge(room, hypothesis.by));
  identity.append(textElement("h3", "mc-card__title", hypothesis.title));
  header.append(identity, stateChip(verdict.className, verdict.label, verdict.icon));

  const confidence = element("div", "mc-confidence");
  const confidenceHeader = element("div", "mc-confidence__header");
  confidenceHeader.append(textElement("span", "", "Stated confidence"));
  // A single number cannot show a mind changing. When the author has revised,
  // render the opening value struck through beside the current one, so the
  // movement is the thing a reader sees.
  const revised = hypothesis.openedAt !== undefined && hypothesis.openedAt !== hypothesis.confidence;
  if (revised) {
    const movement = element("strong", "mc-confidence__movement");
    const from = textElement("s", "mc-confidence__from", formatConfidence(hypothesis.openedAt!));
    movement.append(from);
    movement.append(document.createTextNode(` ${formatConfidence(hypothesis.confidence)}`));
    confidenceHeader.append(movement);
  } else {
    confidenceHeader.append(textElement("strong", "", formatConfidence(hypothesis.confidence)));
  }
  const meter = element("meter", "mc-confidence__meter");
  meter.min = 0;
  meter.max = 1;
  meter.low = 0.4;
  meter.high = 0.7;
  meter.optimum = 1;
  meter.value = clamp(hypothesis.confidence, 0, 1);
  meter.setAttribute("aria-label", `Confidence ${formatConfidence(hypothesis.confidence)}`);
  confidence.append(confidenceHeader, meter);
  if (revised) {
    const note = element("p", "mc-confidence__revision");
    note.append(icon("rebuttal"));
    const direction = hypothesis.confidence < hypothesis.openedAt! ? "down" : "up";
    note.append(
      document.createTextNode(
        hypothesis.revisedBecause
          ? `${memberName(room, hypothesis.by)} revised ${direction}: ${hypothesis.revisedBecause}`
          : `${memberName(room, hypothesis.by)} revised ${direction} after the evidence landed.`,
      ),
    );
    confidence.append(note);
  }

  const steps = element("ol", "mc-steps");

  const evidenceStep = element("li", "mc-step mc-step--evidence");
  const evidence = element("div", "mc-evidence");
  const evidenceLabel = element("div", "mc-evidence__label");
  evidenceLabel.append(icon("evidence"));
  evidenceLabel.append(document.createTextNode("Cited evidence"));
  evidence.append(evidenceLabel, textElement("p", "mc-evidence__text", hypothesis.evidence));
  evidenceStep.append(evidence);
  steps.append(evidenceStep);

  for (const rebuttal of hypothesis.rebuttals) {
    const rebuttalStep = element("li", "mc-step mc-step--rebuttal");
    const block = element("div", "mc-rebuttal");
    const label = element("div", "mc-rebuttal__label");
    label.append(icon("rebuttal"));
    label.append(document.createTextNode("Rebuttal"));
    block.append(label, authorBadge(room, rebuttal.by));
    block.append(textElement("p", "mc-rebuttal__text", rebuttal.evidence));
    rebuttalStep.append(block);
    steps.append(rebuttalStep);
  }

  const voteRow = element("div", "mc-card__footer");
  const votes = element("div", "mc-vote-tally");
  votes.setAttribute("aria-label", `${tally.yes} agree, ${tally.no} disagree`);
  votes.append(stateChip("mc-state-label--positive", `${tally.yes} agree`));
  votes.append(stateChip("mc-state-label--negative", `${tally.no} disagree`));
  const rebuttalCount = element("span", "mc-rebuttal-summary");
  rebuttalCount.append(icon("rebuttal"));
  rebuttalCount.append(
    document.createTextNode(
      `${hypothesis.rebuttals.length} ${hypothesis.rebuttals.length === 1 ? "rebuttal" : "rebuttals"}`,
    ),
  );
  voteRow.append(votes, rebuttalCount);

  card.append(header, confidence, steps, voteRow);

  // Kept as a details element so the older "Review rebuttal" affordance still
  // exists for anyone reading the transcript of a long debate.
  if (hypothesis.rebuttals.length > 0) {
    const details = element("details", "mc-rebuttals");
    const summary = textElement(
      "summary",
      "mc-rebuttals__summary",
      `Review ${hypothesis.rebuttals.length === 1 ? "rebuttal" : "rebuttals"}`,
    );
    const list = element("ul", "mc-rebuttals__list");
    for (const rebuttal of hypothesis.rebuttals) {
      const row = element("li", "mc-rebuttal");
      row.append(textElement("p", "mc-rebuttal__author", memberName(room, rebuttal.by)));
      row.append(textElement("p", "mc-rebuttal__text", rebuttal.evidence));
      list.append(row);
    }
    details.append(summary, list);
    disclosures.bind(details, `rebuttals:${hypothesis.id}`);
    card.append(details);
  }

  const reasons = renderRationales(
    room,
    hypothesis.votes,
    hypothesis.rationales,
    hypothesis.title,
    disclosures,
    `rationales:${hypothesis.id}`,
  );
  if (reasons) card.append(reasons);

  const linked = room.mitigations.filter(
    (mitigation) => mitigation.hypothesisId === hypothesis.id,
  );
  if (linked.length > 0) {
    const fixes = element("ul", "mc-thread__fixes");
    fixes.dataset.testid = "thread-mitigations";
    for (const mitigation of linked) {
      fixes.append(
        renderMitigation(room, mitigation, pendingVotes, canVote, confirmation, callbacks, disclosures),
      );
    }
    card.append(fixes);
  }

  item.append(card);
  return item;
}

export function createInvestigation(callbacks: InvestigationCallbacks): InvestigationSection {
  const disclosures = new Disclosures();
  const root = element("section", "mc-investigation");
  root.id = "mc-investigation";
  root.dataset.testid = "investigation";
  root.setAttribute("aria-labelledby", "mc-investigation-heading");

  const header = element("header", "mc-panel__header");
  const label = element("div", "mc-panel__title");
  label.append(icon("flow"));
  const heading = textElement("h2", "mc-panel__heading", "Investigation");
  heading.id = "mc-investigation-heading";
  label.append(heading);
  const count = textElement("span", "mc-count", "0");
  count.dataset.testid = "hypothesis-count";
  count.setAttribute("aria-label", "Hypotheses count");
  header.append(label, count);

  const flow = element("ol", "mc-flow");
  flow.setAttribute("aria-label", "How a fix reaches production");
  const flowSteps = new Map<string, HTMLElement>();
  for (const stage of STAGES) {
    const step = element("li", "mc-flow__step");
    step.dataset.stage = stage.id;
    step.append(icon(stage.icon));
    step.append(textElement("span", "", stage.label));
    flowSteps.set(stage.id, step);
    flow.append(step);
  }

  const list = element("ul", "mc-thread-list");
  list.dataset.testid = "hypotheses-list";

  const empty = element("div", "mc-empty");
  empty.dataset.testid = "investigation-empty";
  empty.append(icon("hypothesis", "mc-empty__icon"));
  const emptyTitle = textElement("p", "mc-empty__title", "No theories yet");
  const emptyBody = textElement(
    "p",
    "mc-empty__body",
    "Evidence-backed causes appear here as agents gather them, each with its rebuttals and proposed fix.",
  );
  empty.append(emptyTitle, emptyBody);

  root.append(header, flow, empty, list);

  const reachedStage = (room: RoomState | null, confirmation: Confirmation | null): string => {
    if (!room) return "evidence";
    if (room.phase === "resolved") return "verified";
    if (room.appliedActions.length > 0) return "applied";
    if (confirmation) return "approval";
    if (room.mitigations.some((mitigation) => mitigation.passed)) return "approval";
    if (room.mitigations.some((mitigation) => Object.keys(mitigation.votes).length > 0)) return "vote";
    if (room.mitigations.length > 0) return "mitigation";
    if (room.hypotheses.some((hypothesis) => hypothesis.rebuttals.length > 0)) return "rebuttal";
    if (room.hypotheses.length > 0) return "hypothesis";
    return "evidence";
  };

  return {
    root,
    render({ room, pendingVotes, canVote, confirmation }) {
      const reached = reachedStage(room, confirmation);
      const reachedIndex = STAGES.findIndex((stage) => stage.id === reached);
      STAGES.forEach((stage, index) => {
        const step = flowSteps.get(stage.id);
        if (!step) return;
        step.dataset.state = index < reachedIndex ? "done" : index === reachedIndex ? "current" : "ahead";
        step.setAttribute("aria-current", index === reachedIndex ? "step" : "false");
      });

      clear(list);
      const hypotheses = room?.hypotheses ?? [];
      setText(count, hypotheses.length);
      count.setAttribute(
        "aria-label",
        `${hypotheses.length} ${hypotheses.length === 1 ? "hypothesis" : "hypotheses"}`,
      );
      setText(emptyTitle, room ? "No theories yet" : "Loading the board");
      setText(
        emptyBody,
        room
          ? "Evidence-backed causes appear here as agents gather them, each with its rebuttals and proposed fix."
          : "Waiting for the first room update.",
      );
      setHidden(empty, hypotheses.length > 0);
      list.hidden = hypotheses.length === 0;
      if (!room) return;
      for (const hypothesis of hypotheses) {
        list.append(
          renderHypothesisThread(
            room,
            hypothesis,
            pendingVotes,
            canVote,
            confirmation,
            callbacks,
            disclosures,
          ),
        );
      }
    },
  };
}
