import "./phosphor.css";
import { INJECTION_TRAP_LINE, ROOM_ID } from "../../shared/scenario";
import { shortRoomCode } from "../../shared/tenancy";
import type { VoteChoice } from "../../shared/tools";
import type { RoomState, ServerMessage, ServiceStatus } from "../../shared/ws-messages";
import { createActivityDrawer, type ActivityDrawer } from "./activity";
import { createApprovalDialog, type ApprovalDialog } from "./approval-dialog";
import { createDashboard, type DashboardSection, type StatusPoint } from "./dashboard";
import { button, element, prefersReducedMotion, setHidden, setText, textElement } from "./dom";
import { createBrand } from "./brand";
import { createHero, type HeroSection } from "./hero";
import { icon, iconClass } from "./icons";
import { createInviteStrip, type InviteStrip } from "./invite";
import { createInvestigation, type InvestigationSection } from "./investigation";
import { createJudgeConsole, type JudgeConsole } from "./judge-console";
import { createManualControls, type ManualControls } from "./manual-controls";
import { createOnboarding, type OnboardingPanel } from "./onboarding";
import { createPresenceRail, type PresenceRail } from "./presence";
import { approvalTimestamp, type RubricObservations } from "./rubric";
import type {
  Confirmation,
  MountWarRoomOptions,
  MountedWarRoom,
  ParticipationTier,
  RoomUiClient,
  ToolRegistrationSummary,
  UiConnectionState,
  WarRoomEnvironment,
} from "./types";
import "./styles.css";

const MAX_STATUS_POINTS = 30;
const HEALTHY_ERROR_RATE = 0.02;

type Tab = "status" | "investigation" | "actions";

interface UiModel {
  joined: boolean;
  memberId: string | null;
  manualDriven: boolean;
  manualOpen: boolean;
  room: RoomState | null;
  status: ServiceStatus | null;
  statusHistory: StatusPoint[];
  connection: UiConnectionState;
  confirmation: Confirmation | null;
  confirmPending: boolean;
  confirmationError: string | null;
  pendingVotes: Set<string>;
  registration: ToolRegistrationSummary;
  observations: RubricObservations;
  recoveryAt: number | null;
  tab: Tab;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

const defaultEnvironment = (): WarRoomEnvironment => ({
  roomId: ROOM_ID,
  shortCode: shortRoomCode(ROOM_ID),
  shareUrl: typeof location === "undefined" ? "" : location.href,
  selfServe: false,
  demo: false,
  judgeConsoleOpen: false,
  registration: Promise.resolve({ status: "unavailable", count: 0, native: false }),
});

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The request could not be completed. Try again.";
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

interface Shell {
  app: HTMLDivElement;
  roomCode: HTMLElement;
  shareButton: HTMLButtonElement;
  judgeToggle: HTMLButtonElement;
  connectionBadge: HTMLSpanElement;
  connectionIcon: HTMLElement;
  connectionText: HTMLSpanElement;
  connectionBanner: HTMLDivElement;
  connectionBannerText: HTMLParagraphElement;
  notice: HTMLDivElement;
  noticeText: HTMLParagraphElement;
  noticeDismiss: HTMLButtonElement;
  noticeAction: HTMLButtonElement;
  tabs: Map<Tab, HTMLButtonElement>;
  liveAnnouncement: HTMLParagraphElement;
  presence: PresenceRail;
  invite: InviteStrip;
  hero: HeroSection;
  dashboard: DashboardSection;
  investigation: InvestigationSection;
  activity: ActivityDrawer;
  onboarding: OnboardingPanel;
  manual: ManualControls;
  judge: JudgeConsole;
  approval: ApprovalDialog;
}

/**
 * The room page.
 *
 * This module is the orchestrator only: it owns the model, the subscriptions,
 * and the layout, and delegates every region to its own module. Nothing here
 * writes markup — all dynamic text goes through the text-node helpers in
 * `dom.ts`, which is a security property the injection demo depends on.
 */
export function mountWarRoom(
  root: HTMLElement,
  client: RoomUiClient,
  options: MountWarRoomOptions = {},
): MountedWarRoom {
  const now = options.now ?? Date.now;
  const environment: WarRoomEnvironment = { ...defaultEnvironment(), ...options.environment };
  const abortController = new AbortController();
  let destroyed = false;

  const model: UiModel = {
    joined: false,
    memberId: null,
    manualDriven: false,
    manualOpen: false,
    room: null,
    status: null,
    statusHistory: [],
    connection: { state: "connecting" },
    confirmation: null,
    confirmPending: false,
    confirmationError: null,
    pendingVotes: new Set(),
    registration: { status: "pending", count: 0, native: false },
    observations: {
      registration: { status: "pending", count: 0, native: false },
      maxActiveMembers: 0,
      witnesses: [],
      trapLineSeen: false,
      trapLineAt: null,
      replayRefusedAt: null,
      recoveryAt: null,
      recoveryWitnesses: 0,
    },
    recoveryAt: null,
    tab: "status",
  };

  // --- notices --------------------------------------------------------------
  let noticeActionHandler: (() => void) | null = null;
  // Assigned once every helper the shell captures exists. `createShell` reads
  // `onVote`, `download`, and friends eagerly, so it cannot run any earlier.
  let shell!: Shell;

  const showNotice = (message: string, action?: { label: string; run: () => void }): void => {
    setText(shell.noticeText, message);
    noticeActionHandler = action?.run ?? null;
    setText(shell.noticeAction, action?.label ?? "");
    shell.noticeAction.hidden = !action;
    setHidden(shell.notice, false);
  };

  const hideNotice = (): void => {
    setHidden(shell.notice, true);
    setText(shell.noticeText, "");
    shell.noticeAction.hidden = true;
    noticeActionHandler = null;
  };

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      showNotice(`${label} copied to your clipboard.`);
    } catch {
      // A denied clipboard permission must not swallow the value the judge
      // asked for, so hand it back in the notice to copy by hand.
      showNotice(`${label} could not be copied automatically. Here it is: ${text}`);
    }
  };

  const download = (filename: string, text: string, mimeType: string): void => {
    try {
      const blob = new Blob([text], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = element("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch {
      showNotice("This browser blocked the download. Use “Copy run report” instead.");
    }
  };

  // --- votes ----------------------------------------------------------------
  const onVote = (targetId: string, choice: VoteChoice): void => {
    if (!client.vote || model.pendingVotes.has(targetId) || destroyed) return;
    model.pendingVotes.add(targetId);
    renderInvestigation();
    void (async () => {
      try {
        await client.vote?.(targetId, choice, abortController.signal);
      } catch (error) {
        if (!destroyed) showNotice(errorMessage(error));
      } finally {
        model.pendingVotes.delete(targetId);
        if (!destroyed) renderInvestigation();
      }
    })();
  };

  // --- render ---------------------------------------------------------------
  function participationTier(): ParticipationTier {
    if (model.joined && model.manualDriven) return "manual";
    if (model.joined) return model.registration.status === "registered" ? "agent" : "manual";
    if (environment.demo) return "scripted";
    return "spectating";
  }

  function elapsedSeconds(): number {
    const room = model.room;
    if (!room) return 0;
    const end = room.resolvedAt ?? Math.floor(now() / 1_000);
    return Math.max(0, end - room.incidentStartedAt);
  }

  function renderInvestigation(): void {
    shell.investigation.render({
      room: model.room,
      pendingVotes: model.pendingVotes,
      canVote: Boolean(client.vote) && model.joined,
      confirmation: model.confirmation,
    });
  }

  function renderJudge(): void {
    shell.judge.render({
      room: model.room,
      status: model.status,
      observations: { ...model.observations, registration: model.registration },
      roomCode: environment.shortCode,
      shareUrl: environment.shareUrl,
      approvedAt: approvalTimestamp(model.room),
      recoveryAt: model.recoveryAt,
      nowMs: now(),
    });
  }

  function renderAll(): void {
    const tier = participationTier();
    shell.app.dataset.roomPhase = model.room?.phase ?? "triage";
    shell.app.dataset.tier = tier;
    shell.app.setAttribute("aria-busy", model.room ? "false" : "true");
    shell.hero.render({
      room: model.room,
      status: model.status,
      tier,
      elapsedSeconds: elapsedSeconds(),
    });
    shell.dashboard.render({
      room: model.room,
      status: model.status,
      history: model.statusHistory,
      elapsedSeconds: elapsedSeconds(),
    });
    shell.presence.render(model.room);
    shell.invite.render({
      seated: model.room?.members.filter((member) => member.agentActive).length ?? 0,
      demo: environment.demo,
    });
    renderInvestigation();
    shell.activity.render(model.room);
    shell.onboarding.render({
      joined: model.joined,
      room: model.room,
      tier,
      registration: model.registration,
      environment,
      manualOpen: model.manualOpen,
    });
    shell.manual.render({
      room: model.room,
      joined: model.joined,
      open: model.manualOpen,
      memberId: model.memberId,
    });
    renderJudge();
    shell.approval.render({
      confirmation: model.confirmation,
      room: model.room,
      pending: model.confirmPending,
      error: model.confirmationError,
      nowMs: now(),
    });
  }

  function renderConnection(): void {
    const copy = connectionCopy(model.connection);
    shell.app.dataset.connection = model.connection.state;
    shell.connectionBadge.dataset.phase = model.connection.state;
    shell.connectionBadge.setAttribute("aria-label", `Room connection: ${copy.badge}`);
    shell.connectionIcon.className = iconClass(
      model.connection.state === "open" ? "connection" : "connectionOff",
    );
    setText(shell.connectionText, copy.badge);
    setText(shell.connectionBannerText, copy.body);
    const showBanner = model.connection.state !== "open";
    setHidden(shell.connectionBanner, !showBanner);
    shell.connectionBanner.setAttribute(
      "role",
      model.connection.state === "error" || model.connection.state === "closed" ? "alert" : "status",
    );
  }

  // --- observations ---------------------------------------------------------
  function observeRoom(room: RoomState): void {
    const active = room.members.filter((member) => member.agentActive);
    if (active.length > model.observations.maxActiveMembers) {
      model.observations.maxActiveMembers = active.length;
      model.observations.witnesses = active.map((member) => member.name);
    }
    const errorRate = model.status?.errorRate ?? 1;
    if (
      model.recoveryAt === null &&
      room.phase === "resolved" &&
      errorRate < HEALTHY_ERROR_RATE
    ) {
      model.recoveryAt = room.resolvedAt ?? nowSeconds();
      model.observations.recoveryAt = model.recoveryAt;
      model.observations.recoveryWitnesses = Math.max(
        active.length,
        model.observations.maxActiveMembers,
      );
    }
  }

  function observeLogs(lines: readonly string[], untrusted: boolean): void {
    if (!untrusted) return;
    if (!lines.some((line) => line === INJECTION_TRAP_LINE || line.includes("SYSTEM-NOTE"))) return;
    if (model.observations.trapLineSeen) return;
    model.observations.trapLineSeen = true;
    model.observations.trapLineAt = nowSeconds();
  }

  // --- server messages ------------------------------------------------------
  const acceptStatus = (status: ServiceStatus): void => {
    model.status = status;
    if (Number.isFinite(status.p99ms)) {
      model.statusHistory.push({ at: now(), p99ms: status.p99ms, errorRate: status.errorRate });
      if (model.statusHistory.length > MAX_STATUS_POINTS) {
        model.statusHistory.splice(0, model.statusHistory.length - MAX_STATUS_POINTS);
      }
    }
    if (model.room) observeRoom(model.room);
    renderAll();
  };

  const acceptRoom = (room: RoomState): void => {
    const previousMembers = new Set(
      (model.room?.members ?? []).filter((member) => member.agentActive).map((member) => member.id),
    );
    model.room = room;
    observeRoom(room);
    for (const member of room.members) {
      if (member.agentActive && !previousMembers.has(member.id)) {
        shell.presence.flash(member.id);
        shell.hero.viz.pulse(member.id);
      }
    }
    renderAll();
  };

  const onServerMessage = (message: ServerMessage): void => {
    if (destroyed) return;
    if (model.connection.state !== "open") {
      model.connection = { state: "open" };
      renderConnection();
    }
    switch (message.type) {
      case "joined":
        model.joined = true;
        model.memberId = message.memberId;
        acceptRoom(message.state);
        break;
      case "state":
        acceptRoom(message.state);
        break;
      case "status": {
        const { type: _type, ...status } = message;
        acceptStatus(status);
        break;
      }
      case "event":
        setText(shell.liveAnnouncement, `Room activity: ${message.text}`);
        break;
      case "confirm_request":
        model.confirmation = message;
        model.confirmPending = false;
        model.confirmationError = null;
        renderAll();
        break;
      case "tool_result":
        if (message.data.kind === "room_state") {
          acceptRoom(message.data.state);
        } else if (message.data.kind === "service_status") {
          acceptStatus(message.data.status);
        } else if (message.data.kind === "apply") {
          acceptStatus(message.data.status);
        } else if (message.data.kind === "logs") {
          observeLogs(message.data.lines, message.data.untrustedContentHint === true);
          renderJudge();
        } else if (message.data.kind === "vote" && model.memberId) {
          shell.presence.flash(model.memberId);
          shell.hero.viz.pulse(model.memberId);
        }
        break;
      case "error":
        // A refused replay is the single-use approval property in action, so it
        // is recorded rather than only shown.
        if (
          message.code === "needs_human_confirm" &&
          (model.room?.appliedActions.length ?? 0) > 0 &&
          model.observations.replayRefusedAt === null
        ) {
          model.observations.replayRefusedAt = nowSeconds();
          renderJudge();
        }
        if (message.code === "room_full" && environment.startOwnRoom) {
          showNotice(message.message, {
            label: "Start your own room",
            run: () => void environment.startOwnRoom?.(),
          });
        } else {
          showNotice(message.message);
        }
        break;
    }
  };

  const onConnection = (state: UiConnectionState): void => {
    if (destroyed) return;
    model.connection = state;
    renderConnection();
  };

  // --- commander decision ---------------------------------------------------
  const decideConfirmation = async (approved: boolean): Promise<void> => {
    const confirmation = model.confirmation;
    if (!confirmation || model.confirmPending || destroyed) return;
    if (confirmation.expiresAt <= Math.floor(now() / 1_000)) {
      model.confirmation = null;
      model.confirmationError = null;
      renderAll();
      return;
    }
    model.confirmPending = true;
    model.confirmationError = null;
    renderAll();
    try {
      await client.confirm(confirmation.confirmationId, approved);
      model.confirmation = null;
      model.confirmationError = null;
    } catch (error) {
      if (!destroyed) model.confirmationError = errorMessage(error);
    } finally {
      model.confirmPending = false;
      if (!destroyed) renderAll();
    }
  };

  // --- shell ----------------------------------------------------------------
  function createShell(): Shell {
    const app = element("div", "mc-war-room");
    app.dataset.connection = "connecting";
    app.dataset.roomPhase = "triage";
    app.dataset.motion = prefersReducedMotion() ? "reduced" : "full";
    app.dataset.tab = "status";

    const skipLink = textElement("a", "mc-skip-link", "Skip to the investigation");
    skipLink.href = "#mc-investigation";

    // Topbar -----------------------------------------------------------------
    const topbar = element("div", "mc-topbar");
    const brand = createBrand({ home: true, context: "Back to lobby" }).root;

    const roomChip = element("span", "mc-room-chip");
    roomChip.dataset.testid = "room-code";
    roomChip.append(icon("room"));
    const roomCode = textElement("span", "mc-room-chip__code", environment.shortCode);
    roomChip.append(roomCode);
    roomChip.setAttribute("aria-label", `Room ${environment.shortCode}`);

    const shareButton = button("mc-icon-button", "Invite", () => {
      void copyText(environment.shareUrl, "Invite link");
    });
    shareButton.dataset.testid = "share-room";
    shareButton.prepend(icon("share"));
    shareButton.title = "Copy this room's invite. It never carries a commander secret.";

    const judgeToggle = button("mc-icon-button", "Judge console", () => {
      shell.judge.setOpen(!shell.judge.isOpen());
      judgeToggle.setAttribute("aria-pressed", String(shell.judge.isOpen()));
    });
    judgeToggle.dataset.testid = "toggle-judge-console";
    judgeToggle.prepend(icon("judge"));
    judgeToggle.setAttribute("aria-pressed", String(environment.judgeConsoleOpen));

    const connectionBadge = element("span", "mc-connection-badge");
    const connectionIcon = icon("connectionOff");
    const connectionText = textElement("span", "", "Connecting");
    connectionBadge.append(connectionIcon, connectionText);

    const controls = element("div", "mc-topbar__controls");
    controls.append(roomChip, shareButton, judgeToggle, connectionBadge);
    topbar.append(brand, controls);

    // Presence ---------------------------------------------------------------
    const presence = createPresenceRail();
    const invite = createInviteStrip(() => {
      void copyText(environment.shareUrl, "Invite link");
    });

    // Hero -------------------------------------------------------------------
    const hero = createHero();

    // Banners ----------------------------------------------------------------
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
    notice.dataset.testid = "notice";
    notice.hidden = true;
    notice.append(icon("alert"));
    const noticeText = textElement("p", "", "");
    const noticeAction = button("mc-button mc-button--ghost", "", () => noticeActionHandler?.());
    noticeAction.dataset.testid = "notice-action";
    noticeAction.hidden = true;
    const noticeDismiss = button("mc-icon-button", "Dismiss", () => hideNotice());
    notice.append(noticeText, noticeAction, noticeDismiss);

    // Tabs (small screens) ---------------------------------------------------
    const tabBar = element("nav", "mc-tabbar");
    tabBar.setAttribute("aria-label", "Room sections");
    const tabs = new Map<Tab, HTMLButtonElement>();
    const tabLabels: Array<[Tab, string]> = [
      ["status", "Status"],
      ["investigation", "Investigation"],
      ["actions", "Actions"],
    ];
    for (const [id, label] of tabLabels) {
      const control = button("mc-tabbar__tab", label, () => {
        model.tab = id;
        app.dataset.tab = id;
        for (const [otherId, otherControl] of tabs) {
          otherControl.setAttribute("aria-pressed", String(otherId === id));
        }
      });
      control.dataset.tab = id;
      control.dataset.testid = `tab-${id}`;
      control.setAttribute("aria-pressed", String(id === "status"));
      tabs.set(id, control);
      tabBar.append(control);
    }

    // Main -------------------------------------------------------------------
    const dashboard = createDashboard();
    const investigation = createInvestigation({ onVote });
    const activity = createActivityDrawer(false);

    const main = element("main", "mc-main");
    main.id = "mc-main";
    main.append(dashboard.root, investigation.root, activity.root);

    // Onboarding + manual ----------------------------------------------------
    const onboarding = createOnboarding({
      onDriveManually: () => {
        model.manualDriven = true;
        model.manualOpen = true;
        model.tab = "actions";
        app.dataset.tab = "actions";
        renderAll();
        manual.focusJoin();
      },
      onRunScriptedDrill: () => environment.runScriptedDrill?.(),
      onStartOwnRoom: () => void environment.startOwnRoom?.(),
      onCopy: (text, label) => void copyText(text, label),
    });

    const manual = createManualControls(
      client,
      {
        onJoined: (memberId) => {
          model.joined = true;
          model.memberId = memberId;
          renderAll();
        },
        onNotice: (message) => showNotice(message),
        onLogsRead: (lines, untrusted) => {
          observeLogs(lines, untrusted);
          renderJudge();
        },
        onClose: () => {
          model.manualOpen = false;
          renderAll();
        },
      },
      abortController.signal,
    );

    // Judge console ----------------------------------------------------------
    const judge = createJudgeConsole(
      {
        onCopy: (text, label) => void copyText(text, label),
        onDownload: download,
      },
      environment.judgeConsoleOpen,
    );

    // Footer + dialog --------------------------------------------------------
    const safetyNote = element("footer", "mc-safety-note");
    safetyNote.append(icon("shield"));
    safetyNote.append(
      textElement(
        "p",
        "",
        "A human commander must approve a mitigation before it can be applied, and that approval is good for one apply.",
      ),
    );

    const liveAnnouncement = textElement("p", "mc-visually-hidden", "");
    liveAnnouncement.setAttribute("aria-live", "polite");
    liveAnnouncement.setAttribute("aria-atomic", "true");

    const approval = createApprovalDialog({
      onDecide: (approved) => void decideConfirmation(approved),
    });

    app.append(
      skipLink,
      topbar,
      presence.root,
      invite.root,
      hero.root,
      connectionBanner,
      notice,
      onboarding.root,
      tabBar,
      main,
      manual.root,
      judge.root,
      safetyNote,
      liveAnnouncement,
      approval.root,
    );
    root.classList.add("mc-host");
    root.replaceChildren(app);

    return {
      app,
      roomCode,
      shareButton,
      judgeToggle,
      connectionBadge,
      connectionIcon,
      connectionText,
      connectionBanner,
      connectionBannerText,
      notice,
      noticeText,
      noticeDismiss,
      noticeAction,
      tabs,
      liveAnnouncement,
      presence,
      invite,
      hero,
      dashboard,
      investigation,
      activity,
      onboarding,
      manual,
      judge,
      approval,
    };
  }

  // --- start ----------------------------------------------------------------
  shell = createShell();

  void environment.registration.then((summary) => {
    if (destroyed) return;
    model.registration = summary;
    model.observations.registration = summary;
    renderAll();
  });

  renderConnection();
  renderAll();

  let unsubscribeMessages = (): void => undefined;
  let unsubscribeConnection = (): void => undefined;
  try {
    unsubscribeMessages = client.subscribe(onServerMessage);
    if (client.subscribeConnection) {
      unsubscribeConnection = client.subscribeConnection(onConnection);
    }
  } catch (error) {
    model.connection = { state: "error", message: errorMessage(error) };
    renderConnection();
  }

  const timer = globalThis.setInterval(() => {
    if (destroyed) return;
    shell.dashboard.render({
      room: model.room,
      status: model.status,
      history: model.statusHistory,
      elapsedSeconds: elapsedSeconds(),
    });
    shell.hero.render({
      room: model.room,
      status: model.status,
      tier: participationTier(),
      elapsedSeconds: elapsedSeconds(),
    });
    shell.approval.render({
      confirmation: model.confirmation,
      room: model.room,
      pending: model.confirmPending,
      error: model.confirmationError,
      nowMs: now(),
    });
  }, 1_000);

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      abortController.abort();
      globalThis.clearInterval(timer);
      unsubscribeMessages();
      unsubscribeConnection();
      shell.approval.destroy();
      shell.hero.destroy();
      shell.app.remove();
      root.classList.remove("mc-host");
    },
  };
}

export { mountLobby, type LobbyActions, type MountedLobby } from "./lobby";
export type {
  MountWarRoomOptions,
  MountedWarRoom,
  ParticipationTier,
  RoomUiClient,
  ToolRegistrationSummary,
  UiConnectionState,
  WarRoomEnvironment,
} from "./types";
export type {
  ActivityEntry,
  Hypothesis,
  Member,
  Mitigation,
  RoomPhase,
  RoomState,
  ServiceStatus,
} from "../../shared/ws-messages";
