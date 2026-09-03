import { element } from "./dom";

export type IconName =
  | "activity"
  | "agent"
  | "alert"
  | "applied"
  | "approval"
  | "broadcast"
  | "check"
  | "clock"
  | "collapse"
  | "connection"
  | "connectionOff"
  | "copy"
  | "demo"
  | "download"
  | "evidence"
  | "expand"
  | "flow"
  | "gauge"
  | "hand"
  | "hypothesis"
  | "judge"
  | "key"
  | "lobby"
  | "manual"
  | "mitigation"
  | "network"
  | "pending"
  | "presence"
  | "pulse"
  | "rebuttal"
  | "recovered"
  | "refused"
  | "report"
  | "room"
  | "share"
  | "shield"
  | "sparkle"
  | "spectate"
  | "trap"
  | "trendDown"
  | "users"
  | "vote"
  | "write"
  | "x";

const iconClasses: Record<IconName, string> = {
  activity: "ph ph-list-bullets",
  agent: "ph ph-robot",
  alert: "ph ph-warning-octagon",
  applied: "ph ph-lightning",
  approval: "ph ph-gavel",
  broadcast: "ph ph-broadcast",
  check: "ph ph-check-circle",
  clock: "ph ph-clock-countdown",
  collapse: "ph ph-caret-down",
  connection: "ph ph-wifi-high",
  connectionOff: "ph ph-wifi-slash",
  copy: "ph ph-clipboard-text",
  demo: "ph ph-play",
  download: "ph ph-download-simple",
  evidence: "ph ph-magnifying-glass",
  expand: "ph ph-caret-right",
  flow: "ph ph-flow-arrow",
  gauge: "ph ph-gauge",
  hand: "ph ph-hand-pointing",
  hypothesis: "ph ph-lightbulb",
  judge: "ph ph-list-checks",
  key: "ph ph-key",
  lobby: "ph ph-door-open",
  manual: "ph ph-sliders",
  mitigation: "ph ph-wrench",
  network: "ph ph-network",
  pending: "ph ph-circle-dashed",
  presence: "ph ph-user-circle",
  pulse: "ph ph-pulse",
  rebuttal: "ph ph-arrows-counter-clockwise",
  recovered: "ph ph-seal-check",
  refused: "ph ph-prohibit",
  report: "ph ph-file-text",
  room: "ph ph-crosshair",
  share: "ph ph-share-network",
  shield: "ph ph-shield-check",
  sparkle: "ph ph-sparkle",
  spectate: "ph ph-eye",
  trap: "ph ph-shield-warning",
  trendDown: "ph ph-trend-down",
  users: "ph ph-users-three",
  vote: "ph ph-scales",
  write: "ph ph-note-pencil",
  x: "ph ph-x-circle",
};

/** The class string for an icon, for swapping a glyph in place. */
export function iconClass(name: IconName, className = ""): string {
  return `${iconClasses[name]} mc-icon${className ? ` ${className}` : ""}`;
}

export function icon(name: IconName, className = ""): HTMLElement {
  const node = element("i", iconClass(name, className));
  node.setAttribute("aria-hidden", "true");
  return node;
}
