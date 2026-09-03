import { SERVICE_NAME } from "../../shared/scenario";
import type { RoomPhase, RoomState, ServiceStatus } from "../../shared/ws-messages";
import { element, setText, textElement } from "./dom";
import { formatElapsed, phaseLabel } from "./format";
import { icon, iconClass, type IconName } from "./icons";
import type { ParticipationTier } from "./types";
import { mountViz, type VizHandle } from "./viz";

export interface HeroSection {
  root: HTMLElement;
  viz: VizHandle;
  render(input: {
    room: RoomState | null;
    status: ServiceStatus | null;
    tier: ParticipationTier;
    elapsedSeconds: number;
  }): void;
  destroy(): void;
}

const TIER_COPY: Record<ParticipationTier, { label: string; detail: string }> = {
  agent: {
    label: "Agent connected",
    detail: "Your browser agent holds the twelve room tools.",
  },
  manual: {
    label: "Driving it yourself",
    detail: "Your clicks send the same room messages an agent would.",
  },
  scripted: {
    label: "Scripted drill",
    detail: "The house responder is working the incident alongside you.",
  },
  spectating: {
    label: "Watching",
    detail: "Read-only until you join as an agent or take manual control.",
  },
};

const HEADLINE: Record<RoomPhase, string> = {
  triage: "Production is down",
  diagnosing: "Three theories, one cause",
  mitigating: "One fix, waiting on a human",
  resolved: "Back to baseline",
};

export function createHero(): HeroSection {
  const root = element("section", "mc-hero");
  root.dataset.testid = "hero";
  root.setAttribute("aria-labelledby", "mc-hero-title");

  const stage = element("div", "mc-viz");
  stage.dataset.testid = "hero-viz";
  const viz = mountViz(stage);

  const copy = element("div", "mc-hero__copy");
  const eyebrow = element("p", "mc-hero__eyebrow");
  eyebrow.append(icon("alert"));
  const eyebrowText = textElement("span", "", "P1 incident");
  eyebrow.append(eyebrowText);

  const title = textElement("h1", "mc-hero__title", HEADLINE.triage);
  title.id = "mc-hero-title";
  const subtitle = textElement(
    "p",
    "mc-hero__subtitle",
    `${SERVICE_NAME} is failing. Engineers and their agents are in this room together; a human approves the fix.`,
  );

  const stats = element("dl", "mc-hero__stats");
  const stat = (label: string): HTMLElement => {
    const wrapper = element("div", "mc-hero__stat");
    wrapper.append(textElement("dt", "", label));
    const value = textElement("dd", "", "--");
    wrapper.append(value);
    stats.append(wrapper);
    return value;
  };
  const phaseValue = stat("Phase");
  phaseValue.dataset.testid = "hero-phase";
  const elapsedValue = stat("Elapsed");
  const peopleValue = stat("In room");

  const tier = element("p", "mc-hero__tier");
  tier.dataset.testid = "participation-tier";
  const tierIcon = icon("spectate");
  const tierLabel = textElement("strong", "", TIER_COPY.spectating.label);
  const tierDetail = textElement("span", "", TIER_COPY.spectating.detail);
  tier.append(tierIcon, tierLabel, tierDetail);

  copy.append(eyebrow, title, subtitle, stats, tier);
  root.append(stage, copy);

  const tierIcons: Record<ParticipationTier, IconName> = {
    agent: "agent",
    manual: "hand",
    scripted: "demo",
    spectating: "spectate",
  };

  return {
    root,
    viz,
    render({ room, status, tier: currentTier, elapsedSeconds }) {
      const phase = room?.phase ?? "triage";
      root.dataset.phase = phase;
      setText(title, HEADLINE[phase]);
      setText(eyebrowText, phase === "resolved" ? "Incident resolved" : "P1 incident");
      setText(phaseValue, phaseLabel(phase));
      setText(elapsedValue, formatElapsed(elapsedSeconds));
      const people = room?.members.filter((member) => member.agentActive).length ?? 0;
      setText(peopleValue, String(people));

      const copyForTier = TIER_COPY[currentTier];
      tier.dataset.tier = currentTier;
      tierIcon.className = iconClass(tierIcons[currentTier]);
      setText(tierLabel, copyForTier.label);
      setText(tierDetail, copyForTier.detail);

      viz.update({
        participants: (room?.members ?? []).map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          active: member.agentActive,
        })),
        phase,
        errorRate: status?.errorRate ?? 0,
      });
    },
    destroy() {
      viz.destroy();
      root.remove();
    },
  };
}
