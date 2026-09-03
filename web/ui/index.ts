import "./phosphor.css";
import type {
  Hypothesis,
  Mitigation,
  RoomState,
  ServerMessage,
  ServiceStatus,
} from "../../shared/ws-messages";
import type { VoteChoice } from "../../shared/tools";
import { ACTION_SUMMARIES } from "../../shared/tools";
import { SERVICE_NAME } from "../../shared/scenario";
import { appendText, clear, element, setHidden, setText, textElement } from "./dom";
import {
  clamp,
  epochSecondsToDate,
  formatActivityTime,
  formatConfidence,
  formatElapsed,
  formatErrorRate,
  formatLatency,
  phaseLabel,
} from "./format";
import { icon, type IconName } from "./icons";
import "./styles.css";

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

export interface RoomUiClient {
  subscribe(listener: (message: ServerMessage) => void): () => void;
  subscribeConnection?: (listener: (state: UiConnectionState) => void) => () => void;
  confirm(confirmationId: string, approved: boolean): void | Promise<unknown>;
  vote?: (
    targetId: string,
    choice: VoteChoice,
    signal?: AbortSignal,
  ) => void | Promise<unknown>;
}

export interface MountWarRoomOptions {
  now?: () => number;
}

export interface MountedWarRoom {
  destroy(): void;
}

type Confirmation = Extract<ServerMessage, { type: "confirm_request" }>;

interface StatusPoint {
  at: number;
  p99ms: number;
}

interface UiModel {
  room: RoomState | null;
  status: ServiceStatus | null;
  statusHistory: StatusPoint[];
  connection: UiConnectionState;
  confirmation: Confirmation | null;
  confirmPending: boolean;
  confirmationError: string | null;
  pendingVotes: Set<string>;
}

interface ShellRefs {
  app: HTMLDivElement;
  connectionBadge: HTMLSpanElement;
  connectionIcon: HTMLElement;
  connectionText: HTMLSpanElement;
  connectionBanner: HTMLDivElement;
  connectionBannerText: HTMLParagraphElement;
  notice: HTMLDivElement;
  noticeText: HTMLParagraphElement;
  noticeDismiss: HTMLButtonElement;
  statusHeader: HTMLElement;
  serviceName: HTMLHeadingElement;
  errorRate: HTMLParagraphElement;
  latency: HTMLParagraphElement;
  phase: HTMLSpanElement;
  timer: HTMLParagraphElement;
  memberCount: HTMLSpanElement;
  sparkline: SVGPathElement;
  sparklineTitle: SVGTitleElement;
  resolvedSummary: HTMLParagraphElement;
  hypothesesCount: HTMLSpanElement;
  hypothesesList: HTMLUListElement;
  hypothesesEmpty: HTMLDivElement;
  mitigationsCount: HTMLSpanElement;
  mitigationsList: HTMLUListElement;
  mitigationsEmpty: HTMLDivElement;
  activityCount: HTMLSpanElement;
  activityList: HTMLOListElement;
  activityEmpty: HTMLDivElement;
  liveAnnouncement: HTMLParagraphElement;
  dialog: HTMLDialogElement;
  dialogSummary: HTMLParagraphElement;
  dialogAction: HTMLParagraphElement;
  dialogExpiry: HTMLParagraphElement;
  dialogError: HTMLParagraphElement;
  dialogReject: HTMLButtonElement;
  dialogApprove: HTMLButtonElement;
}

const MAX_STATUS_POINTS = 30;

function createPanelHeading(
  title: string,
  iconName: IconName,
): { header: HTMLElement; count: HTMLSpanElement } {
  const header = element("header", "mc-panel__header");
  const label = element("div", "mc-panel__title");
  label.append(icon(iconName));
  label.append(textElement("h2", "mc-panel__heading", title));
  const count = textElement("span", "mc-count", "0");
  count.setAttribute("aria-label", `${title} count`);
  header.append(label, count);
  return { header, count };
}

function createEmptyState(iconName: IconName, title: string, body: string): HTMLDivElement {
  const empty = element("div", "mc-empty");
  empty.append(icon(iconName, "mc-empty__icon"));
  empty.append(textElement("p", "mc-empty__title", title));
  empty.append(textElement("p", "mc-empty__body", body));
  return empty;
}

function createMetric(
  label: string,
  iconName: IconName,
): { wrapper: HTMLDivElement; value: HTMLParagraphElement } {
  const wrapper = element("div", "mc-metric");
  const labelNode = element("div", "mc-metric__label");
  labelNode.append(icon(iconName));
  labelNode.append(textElement("span", "", label));
  const value = textElement("p", "mc-metric__value", "--");
  wrapper.append(labelNode, value);
  return { wrapper, value };
}

function createShell(root: HTMLElement): ShellRefs {
  const app = element("div", "mc-war-room");
  app.dataset.connection = "connecting";
  app.dataset.roomPhase = "triage";

  const skipLink = textElement("a", "mc-skip-link", "Skip to incident boards");
  skipLink.href = "#mc-incident-boards";

  const topbar = element("div", "mc-topbar");
  const brand = element("div", "mc-brand");
  brand.append(icon("broadcast", "mc-brand__icon"));
  brand.append(textElement("span", "mc-brand__name", "multicom"));
  brand.append(textElement("span", "mc-brand__context", "Incident room"));

  const connectionBadge = element("span", "mc-connection-badge");
  const connectionIcon = icon("connectionOff");
  const connectionText = textElement("span", "", "Connecting");
  connectionBadge.append(connectionIcon, connectionText);
  topbar.append(brand, connectionBadge);

  const statusHeader = element("header", "mc-status");
  statusHeader.dataset.health = "unknown";
  statusHeader.setAttribute("aria-labelledby", "mc-service-name");

  const incidentHeading = element("div", "mc-status__identity");
  const severity = textElement("p", "mc-status__eyebrow", "Production incident");
  const serviceName = textElement("h1", "mc-status__service", SERVICE_NAME);
  serviceName.id = "mc-service-name";
  const memberSummary = element("p", "mc-member-summary");
  memberSummary.append(icon("users"));
  const memberCount = textElement("span", "", "No responders yet");
  memberSummary.append(memberCount);
  incidentHeading.append(severity, serviceName, memberSummary);

  const errorMetric = createMetric("Error rate", "alert");
  errorMetric.wrapper.classList.add("mc-metric--primary");
  errorMetric.value.dataset.testid = "error-rate";
  const latencyMetric = createMetric("p99 latency", "gauge");
  latencyMetric.value.dataset.testid = "p99-latency";
  const phaseMetric = createMetric("Phase", "activity");
  const phase = textElement("span", "mc-phase", "Triage");
  phase.dataset.testid = "room-phase";
  phaseMetric.value.replaceWith(phase);
  const timerMetric = createMetric("MTTR", "clock");
  const timer = timerMetric.value;
  timer.dataset.testid = "mttr";

  const sparklineWrap = element("div", "mc-sparkline");
  const sparklineLabel = textElement("p", "mc-sparkline__label", "p99 trend");
  const sparklineSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sparklineSvg.setAttribute("viewBox", "0 0 240 56");
  sparklineSvg.setAttribute("role", "img");
  sparklineSvg.setAttribute("aria-labelledby", "mc-sparkline-title");
  sparklineSvg.setAttribute("preserveAspectRatio", "none");
  const sparklineTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
  sparklineTitle.id = "mc-sparkline-title";
  appendText(sparklineTitle, "Waiting for latency data");
  const sparklineBaseline = document.createElementNS("http://www.w3.org/2000/svg", "line");
  sparklineBaseline.setAttribute("x1", "0");
  sparklineBaseline.setAttribute("x2", "240");
  sparklineBaseline.setAttribute("y1", "55");
  sparklineBaseline.setAttribute("y2", "55");
  sparklineBaseline.setAttribute("class", "mc-sparkline__baseline");
  const sparkline = document.createElementNS("http://www.w3.org/2000/svg", "path");
  sparkline.setAttribute("class", "mc-sparkline__line");
  sparkline.setAttribute("vector-effect", "non-scaling-stroke");
  sparklineSvg.append(sparklineTitle, sparklineBaseline, sparkline);
  sparklineWrap.append(sparklineLabel, sparklineSvg);

  const metrics = element("div", "mc-status__metrics");
  metrics.append(
    errorMetric.wrapper,
    latencyMetric.wrapper,
    phaseMetric.wrapper,
    timerMetric.wrapper,
    sparklineWrap,
  );

  const resolvedSummary = textElement("p", "mc-resolved-summary", "Incident resolved.");
  resolvedSummary.dataset.testid = "resolved-summary";
  resolvedSummary.hidden = true;
  statusHeader.append(incidentHeading, metrics, resolvedSummary);

  const connectionBanner = element("div", "mc-connection-banner");
  connectionBanner.setAttribute("role", "status");
  connectionBanner.setAttribute("aria-live", "polite");
  connectionBanner.append(icon("connectionOff"));
  const connectionBannerText = textElement(
    "p",
    "",
    "Connecting to the incident room. Waiting for live updates.",
  );
  connectionBanner.append(connectionBannerText);

  const notice = element("div", "mc-notice");
  notice.setAttribute("role", "alert");
  notice.hidden = true;
  notice.append(icon("alert"));
  const noticeText = textElement("p", "", "");
  const noticeDismiss = textElement("button", "mc-icon-button", "Dismiss");
  noticeDismiss.type = "button";
  notice.append(noticeText, noticeDismiss);

  const boards = element("main", "mc-boards");
  boards.id = "mc-incident-boards";

  const hypothesesPanel = element("section", "mc-panel mc-panel--hypotheses");
  hypothesesPanel.setAttribute("aria-labelledby", "mc-hypotheses-heading");
  const hypothesesHeading = createPanelHeading("Hypotheses", "hypothesis");
  hypothesesHeading.header.querySelector("h2")!.id = "mc-hypotheses-heading";
  const hypothesesList = element("ul", "mc-card-list");
  hypothesesList.dataset.testid = "hypotheses-list";
  const hypothesesEmpty = createEmptyState(
    "hypothesis",
    "No hypotheses yet",
    "Agents will place evidence-backed causes here.",
  );
  hypothesesPanel.append(hypothesesHeading.header, hypothesesEmpty, hypothesesList);

  const mitigationsPanel = element("section", "mc-panel mc-panel--mitigations");
  mitigationsPanel.setAttribute("aria-labelledby", "mc-mitigations-heading");
  const mitigationsHeading = createPanelHeading("Mitigations", "mitigation");
  mitigationsHeading.header.querySelector("h2")!.id = "mc-mitigations-heading";
  const mitigationsList = element("ul", "mc-card-list");
  mitigationsList.dataset.testid = "mitigations-list";
  const mitigationsEmpty = createEmptyState(
    "mitigation",
    "No fixes proposed",
    "A fix appears here after agents agree on the evidence.",
  );
  mitigationsPanel.append(mitigationsHeading.header, mitigationsEmpty, mitigationsList);

  const activityPanel = element("section", "mc-panel mc-panel--activity");
  activityPanel.setAttribute("aria-labelledby", "mc-activity-heading");
  const activityHeading = createPanelHeading("Activity", "activity");
  activityHeading.header.querySelector("h2")!.id = "mc-activity-heading";
  const activityList = element("ol", "mc-activity-list");
  activityList.dataset.testid = "activity-list";
  const activityEmpty = createEmptyState(
    "activity",
    "Room is quiet",
    "Agent actions and human decisions will be recorded here.",
  );
  activityPanel.append(activityHeading.header, activityEmpty, activityList);

  boards.append(hypothesesPanel, mitigationsPanel, activityPanel);

  const safetyNote = element("footer", "mc-safety-note");
  safetyNote.append(icon("shield"));
  safetyNote.append(
    textElement("p", "", "A human commander must approve a mitigation before it can be applied."),
  );

  const liveAnnouncement = textElement("p", "mc-visually-hidden", "");
  liveAnnouncement.setAttribute("aria-live", "polite");
  liveAnnouncement.setAttribute("aria-atomic", "true");

  const dialog = element("dialog", "mc-confirm-dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "mc-confirm-title");
  dialog.setAttribute("aria-describedby", "mc-confirm-summary");
  dialog.dataset.testid = "confirm-dialog";
  const dialogContent = element("div", "mc-confirm-dialog__content");
  const dialogIcon = element("div", "mc-confirm-dialog__icon");
  dialogIcon.append(icon("shield"));
  const dialogLabel = textElement("p", "mc-confirm-dialog__label", "Human approval required");
  const dialogTitle = textElement("h2", "mc-confirm-dialog__title", "Approve this mitigation?");
  dialogTitle.id = "mc-confirm-title";
  const dialogSummary = textElement("p", "mc-confirm-dialog__summary", "");
  dialogSummary.id = "mc-confirm-summary";
  const dialogAction = textElement("p", "mc-confirm-dialog__action", "");
  const dialogExpiry = textElement("p", "mc-confirm-dialog__expiry", "");
  const dialogError = textElement("p", "mc-confirm-dialog__error", "");
  dialogError.setAttribute("role", "alert");
  dialogError.hidden = true;
  const dialogActions = element("div", "mc-confirm-dialog__actions");
  const dialogReject = textElement("button", "mc-button mc-button--secondary", "Reject");
  dialogReject.type = "button";
  dialogReject.dataset.testid = "reject-mitigation";
  const dialogApprove = textElement("button", "mc-button mc-button--approve", "Approve mitigation");
  dialogApprove.type = "button";
  dialogApprove.dataset.testid = "approve-mitigation";
  dialogActions.append(dialogReject, dialogApprove);
  dialogContent.append(
    dialogIcon,
    dialogLabel,
    dialogTitle,
    dialogSummary,
    dialogAction,
    dialogExpiry,
    dialogError,
    dialogActions,
  );
  dialog.append(dialogContent);

  app.append(
    skipLink,
    topbar,
    statusHeader,
    connectionBanner,
    notice,
    boards,
    safetyNote,
    liveAnnouncement,
    dialog,
  );
  root.classList.add("mc-host");
  root.replaceChildren(app);

  return {
    app,
    connectionBadge,
    connectionIcon,
    connectionText,
    connectionBanner,
    connectionBannerText,
    notice,
    noticeText,
    noticeDismiss,
    statusHeader,
    serviceName,
    errorRate: errorMetric.value,
    latency: latencyMetric.value,
    phase,
    timer,
    memberCount,
    sparkline,
    sparklineTitle,
    resolvedSummary,
    hypothesesCount: hypothesesHeading.count,
    hypothesesList,
    hypothesesEmpty,
    mitigationsCount: mitigationsHeading.count,
    mitigationsList,
    mitigationsEmpty,
    activityCount: activityHeading.count,
    activityList,
    activityEmpty,
    liveAnnouncement,
    dialog,
    dialogSummary,
    dialogAction,
    dialogExpiry,
    dialogError,
    dialogReject,
    dialogApprove,
  };
}

function countVotes(room: RoomState, votes: Record<string, VoteChoice>): { yes: number; no: number } {
  const activeMembers = new Set(
    room.members.filter((member) => member.agentActive).map((member) => member.id),
  );
  return Object.entries(votes).reduce(
    (tally, [memberId, choice]) => {
      if (!activeMembers.has(memberId)) return tally;
      tally[choice] += 1;
      return tally;
    },
    { yes: 0, no: 0 },
  );
}

function memberName(room: RoomState, memberId: string): string {
  return room.members.find((member) => member.id === memberId)?.name ?? "Unknown responder";
}

function createStateLabel(className: string, label: string): HTMLSpanElement {
  const state = textElement("span", `mc-state-label ${className}`, label);
  return state;
}

function renderHypothesis(room: RoomState, hypothesis: Hypothesis): HTMLLIElement {
  const tally = countVotes(room, hypothesis.votes);
  const challenged = hypothesis.rebuttals.length > 0 || tally.no > tally.yes;
  const item = element("li", "mc-card-item");
  const card = element("article", "mc-card mc-hypothesis");
  card.dataset.hypothesisId = hypothesis.id;
  card.dataset.testid = "hypothesis-card";
  if (challenged) {
    card.classList.add("mc-card--challenged");
  }

  const header = element("header", "mc-card__header");
  const identity = element("div", "mc-card__identity");
  identity.append(textElement("p", "mc-card__author", memberName(room, hypothesis.by)));
  identity.append(textElement("h3", "mc-card__title", hypothesis.title));
  header.append(identity);
  if (challenged) {
    header.append(createStateLabel("mc-state-label--warning", "Challenged"));
  }

  const confidence = element("div", "mc-confidence");
  const confidenceHeader = element("div", "mc-confidence__header");
  confidenceHeader.append(textElement("span", "", "Confidence"));
  confidenceHeader.append(textElement("strong", "", formatConfidence(hypothesis.confidence)));
  const meter = element("meter", "mc-confidence__meter");
  meter.min = 0;
  meter.max = 1;
  meter.low = 0.4;
  meter.high = 0.7;
  meter.optimum = 1;
  meter.value = clamp(hypothesis.confidence, 0, 1);
  meter.setAttribute("aria-label", `Confidence ${formatConfidence(hypothesis.confidence)}`);
  confidence.append(confidenceHeader, meter);

  const evidence = element("div", "mc-evidence");
  const evidenceLabel = element("div", "mc-evidence__label");
  evidenceLabel.append(icon("evidence"));
  evidenceLabel.append(textElement("span", "", "Evidence"));
  evidence.append(evidenceLabel, textElement("p", "mc-evidence__text", hypothesis.evidence));

  const footer = element("footer", "mc-card__footer");
  const votes = element("div", "mc-vote-tally");
  votes.setAttribute("aria-label", `${tally.yes} agree, ${tally.no} disagree`);
  votes.append(createStateLabel("mc-state-label--positive", `${tally.yes} agree`));
  votes.append(createStateLabel("mc-state-label--negative", `${tally.no} disagree`));
  const rebuttalSummary = element("span", "mc-rebuttal-summary");
  rebuttalSummary.append(icon("rebuttal"));
  rebuttalSummary.append(
    textElement(
      "span",
      "",
      `${hypothesis.rebuttals.length} ${hypothesis.rebuttals.length === 1 ? "rebuttal" : "rebuttals"}`,
    ),
  );
  footer.append(votes, rebuttalSummary);

  card.append(header, confidence, evidence, footer);

  if (hypothesis.rebuttals.length > 0) {
    const rebuttals = element("details", "mc-rebuttals");
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
    rebuttals.append(summary, list);
    card.append(rebuttals);
  }

  item.append(card);
  return item;
}

function renderHypotheses(model: UiModel, refs: ShellRefs): void {
  clear(refs.hypothesesList);
  const hypotheses = model.room?.hypotheses ?? [];
  const emptyTitle = refs.hypothesesEmpty.querySelector<HTMLElement>(".mc-empty__title");
  const emptyBody = refs.hypothesesEmpty.querySelector<HTMLElement>(".mc-empty__body");
  if (emptyTitle && emptyBody) {
    setText(emptyTitle, model.room ? "No hypotheses yet" : "Loading hypotheses");
    setText(
      emptyBody,
      model.room
        ? "Agents will place evidence-backed causes here."
        : "Waiting for the first room update.",
    );
  }
  setText(refs.hypothesesCount, hypotheses.length);
  refs.hypothesesCount.setAttribute(
    "aria-label",
    `${hypotheses.length} ${hypotheses.length === 1 ? "hypothesis" : "hypotheses"}`,
  );
  setHidden(refs.hypothesesEmpty, hypotheses.length > 0);
  refs.hypothesesList.hidden = hypotheses.length === 0;
  for (const hypothesis of hypotheses) {
    refs.hypothesesList.append(renderHypothesis(model.room!, hypothesis));
  }
}

function mitigationState(
  room: RoomState,
  mitigation: Mitigation,
): { className: string; label: string } {
  if (room.appliedActions.includes(mitigation.actionId)) {
    return { className: "mc-state-label--resolved", label: "Applied" };
  }
  if (mitigation.passed) {
    return { className: "mc-state-label--warning", label: "Awaiting commander" };
  }
  return { className: "mc-state-label--neutral", label: "Voting open" };
}

function renderMitigation(
  room: RoomState,
  mitigation: Mitigation,
  model: UiModel,
  client: RoomUiClient,
  onVote: (targetId: string, choice: VoteChoice) => void,
): HTMLLIElement {
  const tally = countVotes(room, mitigation.votes);
  const state = mitigationState(room, mitigation);
  const hypothesis = room.hypotheses.find((item) => item.id === mitigation.hypothesisId);
  const item = element("li", "mc-card-item");
  const card = element("article", "mc-card mc-mitigation");
  card.dataset.mitigationId = mitigation.id;
  card.dataset.actionId = mitigation.actionId;
  card.dataset.passed = String(mitigation.passed);
  card.dataset.testid = "mitigation-card";

  const header = element("header", "mc-card__header");
  const identity = element("div", "mc-card__identity");
  identity.append(textElement("p", "mc-card__author", hypothesis?.title ?? "Linked hypothesis"));
  identity.append(textElement("h3", "mc-card__title mc-card__title--action", mitigation.actionId));
  header.append(identity, createStateLabel(state.className, state.label));

  const summary = textElement(
    "p",
    "mc-mitigation__summary",
    ACTION_SUMMARIES[mitigation.actionId],
  );
  const blastRadius = element("div", "mc-blast-radius");
  blastRadius.append(textElement("span", "mc-blast-radius__label", "Possible impact"));
  blastRadius.append(textElement("p", "", mitigation.blastRadius));

  const voteArea = element("div", "mc-vote-area");
  const voteSummary = textElement("p", "mc-vote-area__summary", `${tally.yes} yes, ${tally.no} no`);
  voteSummary.setAttribute("aria-live", "polite");
  const actions = element("div", "mc-vote-actions");
  const pending = model.pendingVotes.has(mitigation.id);
  const disabled = !client.vote || pending || room.phase === "resolved";
  const yesButton = textElement("button", "mc-button mc-button--vote", pending ? "Voting..." : "Vote yes");
  yesButton.type = "button";
  yesButton.disabled = disabled;
  yesButton.dataset.choice = "yes";
  yesButton.setAttribute("aria-label", `Vote yes on ${mitigation.actionId}`);
  const noButton = textElement("button", "mc-button mc-button--vote", "Vote no");
  noButton.type = "button";
  noButton.disabled = disabled;
  noButton.dataset.choice = "no";
  noButton.setAttribute("aria-label", `Vote no on ${mitigation.actionId}`);
  yesButton.addEventListener("click", () => onVote(mitigation.id, "yes"));
  noButton.addEventListener("click", () => onVote(mitigation.id, "no"));
  actions.append(yesButton, noButton);
  voteArea.append(voteSummary, actions);
  if (!client.vote) {
    voteArea.append(textElement("p", "mc-vote-area__hint", "Voting is available through your agent."));
  }

  card.append(header, summary, blastRadius, voteArea);
  item.append(card);
  return item;
}

function renderMitigations(
  model: UiModel,
  refs: ShellRefs,
  client: RoomUiClient,
  onVote: (targetId: string, choice: VoteChoice) => void,
): void {
  clear(refs.mitigationsList);
  const room = model.room;
  const mitigations = room?.mitigations ?? [];
  const emptyTitle = refs.mitigationsEmpty.querySelector<HTMLElement>(".mc-empty__title");
  const emptyBody = refs.mitigationsEmpty.querySelector<HTMLElement>(".mc-empty__body");
  if (emptyTitle && emptyBody) {
    setText(emptyTitle, room ? "No fixes proposed" : "Loading mitigations");
    setText(
      emptyBody,
      room
        ? "A fix appears here after agents agree on the evidence."
        : "Waiting for the first room update.",
    );
  }
  setText(refs.mitigationsCount, mitigations.length);
  refs.mitigationsCount.setAttribute(
    "aria-label",
    `${mitigations.length} ${mitigations.length === 1 ? "mitigation" : "mitigations"}`,
  );
  setHidden(refs.mitigationsEmpty, mitigations.length > 0);
  refs.mitigationsList.hidden = mitigations.length === 0;
  if (!room) {
    return;
  }
  for (const mitigation of mitigations) {
    refs.mitigationsList.append(renderMitigation(room, mitigation, model, client, onVote));
  }
}

function renderActivity(model: UiModel, refs: ShellRefs): void {
  clear(refs.activityList);
  const entries = model.room?.log ?? [];
  const emptyTitle = refs.activityEmpty.querySelector<HTMLElement>(".mc-empty__title");
  const emptyBody = refs.activityEmpty.querySelector<HTMLElement>(".mc-empty__body");
  if (emptyTitle && emptyBody) {
    setText(emptyTitle, model.room ? "Room is quiet" : "Loading activity");
    setText(
      emptyBody,
      model.room
        ? "Agent actions and human decisions will be recorded here."
        : "Waiting for the first room update.",
    );
  }
  setText(refs.activityCount, entries.length);
  refs.activityCount.setAttribute(
    "aria-label",
    `${entries.length} ${entries.length === 1 ? "activity entry" : "activity entries"}`,
  );
  setHidden(refs.activityEmpty, entries.length > 0);
  refs.activityList.hidden = entries.length === 0;

  for (const entry of entries) {
    const item = element("li", "mc-activity-entry");
    const time = textElement("time", "mc-activity-entry__time", formatActivityTime(entry.t));
    time.dateTime = epochSecondsToDate(entry.t).toISOString();
    item.append(time, textElement("p", "mc-activity-entry__text", entry.text));
    refs.activityList.append(item);
  }
  refs.activityList.scrollTop = refs.activityList.scrollHeight;
}

function renderSparkline(model: UiModel, refs: ShellRefs): void {
  const points = model.statusHistory;
  if (points.length === 0) {
    refs.sparkline.setAttribute("d", "");
    setText(refs.sparklineTitle, "Waiting for latency data");
    return;
  }

  const values = points.map((point) => Math.max(0, point.p99ms));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(1, maximum - minimum);
  const width = 240;
  const height = 48;
  const top = 4;
  const path = points
    .map((point, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const normalized = (Math.max(0, point.p99ms) - minimum) / spread;
      const y = top + height - normalized * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  refs.sparkline.setAttribute("d", path);
  const latest = points[points.length - 1]!;
  setText(
    refs.sparklineTitle,
    `p99 latency trend with ${points.length} samples. Latest ${formatLatency(latest.p99ms)}.`,
  );
}

function renderStatus(model: UiModel, refs: ShellRefs, now: () => number): void {
  const room = model.room;
  const status = model.status;
  const resolved = room?.phase === "resolved";
  const health = resolved ? "resolved" : status ? "critical" : "unknown";
  refs.statusHeader.dataset.health = health;
  refs.app.dataset.health = health;
  refs.app.dataset.roomPhase = room?.phase ?? "triage";

  setText(refs.errorRate, status ? formatErrorRate(status.errorRate) : "--");
  setText(refs.latency, status ? formatLatency(status.p99ms) : "--");
  setText(refs.phase, phaseLabel(room?.phase ?? "triage"));
  refs.phase.className = `mc-phase mc-phase--${room?.phase ?? "triage"}`;

  if (room) {
    const endSeconds = room.resolvedAt ?? Math.floor(now() / 1_000);
    const elapsed = Math.max(0, endSeconds - room.incidentStartedAt);
    const formattedElapsed = formatElapsed(elapsed);
    setText(refs.timer, formattedElapsed);
    refs.timer.setAttribute("aria-label", `Mean time to resolution ${formattedElapsed}`);
    const people = room.members.filter((member) => member.agentActive).length;
    setText(refs.memberCount, `${people} ${people === 1 ? "person" : "people"} in room`);
    if (resolved) {
      const resolution = room.appliedActions.includes("scale_pool:default")
        ? `Resolved in ${formattedElapsed}. DB pool restored.`
        : `Resolved in ${formattedElapsed}. Service is stable.`;
      setText(refs.resolvedSummary, resolution);
      refs.resolvedSummary.hidden = false;
    } else {
      refs.resolvedSummary.hidden = true;
    }
  } else {
    setText(refs.timer, "0:00");
    setText(refs.memberCount, "No people in room yet");
    refs.resolvedSummary.hidden = true;
  }
  renderSparkline(model, refs);
}

function connectionCopy(state: UiConnectionState): { badge: string; body: string } {
  switch (state.state) {
    case "open":
      return { badge: "Live", body: "Connected to the incident room." };
    case "reconnecting":
      return {
        badge: "Reconnecting",
        body: state.message ?? "Connection lost. Reconnecting to the incident room.",
      };
    case "closed":
      return {
        badge: "Offline",
        body: state.message ?? "The room connection is closed. Reload to try again.",
      };
    case "error":
      return {
        badge: "Connection error",
        body: state.message ?? "Could not reach the incident room.",
      };
    case "connecting":
    default:
      return {
        badge: "Connecting",
        body: state.message ?? "Connecting to the incident room. Waiting for live updates.",
      };
  }
}

function renderConnection(model: UiModel, refs: ShellRefs): void {
  const copy = connectionCopy(model.connection);
  refs.app.dataset.connection = model.connection.state;
  refs.connectionBadge.dataset.phase = model.connection.state;
  refs.connectionBadge.setAttribute("aria-label", `Room connection: ${copy.badge}`);
  refs.connectionIcon.className = `${
    model.connection.state === "open" ? "ph ph-wifi-high" : "ph ph-wifi-slash"
  } mc-icon`;
  setText(refs.connectionText, copy.badge);
  setText(refs.connectionBannerText, copy.body);
  const showBanner = model.connection.state !== "open";
  setHidden(refs.connectionBanner, !showBanner);
  refs.connectionBanner.setAttribute(
    "role",
    model.connection.state === "error" || model.connection.state === "closed"
      ? "alert"
      : "status",
  );
}

function renderConfirmation(model: UiModel, refs: ShellRefs, now: () => number): void {
  const confirmation = model.confirmation;
  if (!confirmation) {
    if (refs.dialog.open) {
      refs.dialog.close();
    }
    return;
  }

  const remainingSeconds = Math.max(0, confirmation.expiresAt - Math.floor(now() / 1_000));
  const expired = remainingSeconds === 0;
  setText(refs.dialogSummary, confirmation.actionSummary);
  setText(refs.dialogAction, `Action: ${confirmation.actionId}`);
  setText(
    refs.dialogExpiry,
    expired
      ? "This approval request has expired."
      : `Approval expires in ${remainingSeconds} ${remainingSeconds === 1 ? "second" : "seconds"}.`,
  );
  refs.dialogApprove.disabled = model.confirmPending || expired;
  refs.dialogReject.disabled = model.confirmPending;
  setText(refs.dialogApprove, model.confirmPending ? "Sending decision..." : "Approve mitigation");
  setText(refs.dialogReject, expired ? "Close" : "Reject");
  setText(refs.dialogError, model.confirmationError ?? "");
  refs.dialogError.hidden = !model.confirmationError;

  if (!refs.dialog.open) {
    try {
      refs.dialog.showModal();
    } catch {
      refs.dialog.setAttribute("open", "");
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "The request could not be completed. Try again.";
}

export function mountWarRoom(
  root: HTMLElement,
  client: RoomUiClient,
  options: MountWarRoomOptions = {},
): MountedWarRoom {
  const now = options.now ?? Date.now;
  const refs = createShell(root);
  const model: UiModel = {
    room: null,
    status: null,
    statusHistory: [],
    connection: { state: "connecting" },
    confirmation: null,
    confirmPending: false,
    confirmationError: null,
    pendingVotes: new Set(),
  };
  const abortController = new AbortController();
  let destroyed = false;

  const showNotice = (message: string): void => {
    setText(refs.noticeText, message);
    setHidden(refs.notice, false);
  };

  const hideNotice = (): void => {
    setHidden(refs.notice, true);
    setText(refs.noticeText, "");
  };

  const onVote = async (targetId: string, choice: VoteChoice): Promise<void> => {
    if (!client.vote || model.pendingVotes.has(targetId) || destroyed) {
      return;
    }
    model.pendingVotes.add(targetId);
    renderMitigations(model, refs, client, onVote);
    try {
      await client.vote(targetId, choice, abortController.signal);
    } catch (error) {
      if (!destroyed) {
        showNotice(errorMessage(error));
      }
    } finally {
      model.pendingVotes.delete(targetId);
      if (!destroyed) {
        renderMitigations(model, refs, client, onVote);
      }
    }
  };

  const renderRoom = (): void => {
    refs.app.setAttribute("aria-busy", model.room ? "false" : "true");
    renderStatus(model, refs, now);
    renderHypotheses(model, refs);
    renderMitigations(model, refs, client, onVote);
    renderActivity(model, refs);
  };

  const acceptStatus = (status: ServiceStatus): void => {
    model.status = status;
    if (Number.isFinite(status.p99ms)) {
      model.statusHistory.push({ at: now(), p99ms: status.p99ms });
      if (model.statusHistory.length > MAX_STATUS_POINTS) {
        model.statusHistory.splice(0, model.statusHistory.length - MAX_STATUS_POINTS);
      }
    }
    renderStatus(model, refs, now);
  };

  const acceptRoom = (room: RoomState): void => {
    model.room = room;
    renderRoom();
  };

  const onServerMessage = (message: ServerMessage): void => {
    if (destroyed) {
      return;
    }
    if (model.connection.state !== "open") {
      model.connection = { state: "open" };
      renderConnection(model, refs);
    }
    switch (message.type) {
      case "joined":
      case "state":
        acceptRoom(message.state);
        break;
      case "status": {
        const { type: _type, ...status } = message;
        acceptStatus(status);
        break;
      }
      case "event":
        setText(refs.liveAnnouncement, `Room activity: ${message.text}`);
        break;
      case "confirm_request":
        model.confirmation = message;
        model.confirmPending = false;
        model.confirmationError = null;
        renderConfirmation(model, refs, now);
        break;
      case "tool_result":
        if (message.data.kind === "room_state") {
          acceptRoom(message.data.state);
        } else if (message.data.kind === "service_status") {
          acceptStatus(message.data.status);
        } else if (message.data.kind === "apply") {
          acceptStatus(message.data.status);
        }
        break;
      case "error":
        showNotice(message.message);
        break;
    }
  };

  const onConnection = (state: UiConnectionState): void => {
    if (destroyed) {
      return;
    }
    model.connection = state;
    renderConnection(model, refs);
  };

  const decideConfirmation = async (approved: boolean): Promise<void> => {
    const confirmation = model.confirmation;
    if (!confirmation || model.confirmPending || destroyed) {
      return;
    }
    const expired = confirmation.expiresAt <= Math.floor(now() / 1_000);
    if (expired) {
      model.confirmation = null;
      model.confirmationError = null;
      renderConfirmation(model, refs, now);
      return;
    }

    model.confirmPending = true;
    model.confirmationError = null;
    renderConfirmation(model, refs, now);
    try {
      await client.confirm(confirmation.confirmationId, approved);
      model.confirmation = null;
      model.confirmationError = null;
    } catch (error) {
      if (!destroyed) {
        model.confirmationError = errorMessage(error);
      }
    } finally {
      model.confirmPending = false;
      if (!destroyed) {
        renderConfirmation(model, refs, now);
      }
    }
  };

  const onDialogCancel = (event: Event): void => {
    event.preventDefault();
    refs.dialogReject.focus();
  };
  const onReject = (): void => {
    void decideConfirmation(false);
  };
  const onApprove = (): void => {
    void decideConfirmation(true);
  };

  refs.noticeDismiss.addEventListener("click", hideNotice);
  refs.dialog.addEventListener("cancel", onDialogCancel);
  refs.dialogReject.addEventListener("click", onReject);
  refs.dialogApprove.addEventListener("click", onApprove);

  renderConnection(model, refs);
  renderRoom();

  let unsubscribeMessages = (): void => undefined;
  let unsubscribeConnection = (): void => undefined;
  try {
    unsubscribeMessages = client.subscribe(onServerMessage);
    if (client.subscribeConnection) {
      unsubscribeConnection = client.subscribeConnection(onConnection);
    }
  } catch (error) {
    model.connection = { state: "error", message: errorMessage(error) };
    renderConnection(model, refs);
  }

  const timer = window.setInterval(() => {
    if (destroyed) {
      return;
    }
    renderStatus(model, refs, now);
    renderConfirmation(model, refs, now);
  }, 1_000);

  return {
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      abortController.abort();
      window.clearInterval(timer);
      unsubscribeMessages();
      unsubscribeConnection();
      refs.noticeDismiss.removeEventListener("click", hideNotice);
      refs.dialog.removeEventListener("cancel", onDialogCancel);
      refs.dialogReject.removeEventListener("click", onReject);
      refs.dialogApprove.removeEventListener("click", onApprove);
      if (refs.dialog.open) {
        refs.dialog.close();
      }
      refs.app.remove();
      root.classList.remove("mc-host");
    },
  };
}

export type {
  ActivityEntry,
  Hypothesis,
  Member,
  Mitigation,
  RoomPhase,
  RoomState,
  ServiceStatus,
} from "../../shared/ws-messages";
