import { element } from "./dom";

export type IconName =
  | "activity"
  | "alert"
  | "broadcast"
  | "check"
  | "clock"
  | "connection"
  | "connectionOff"
  | "evidence"
  | "gauge"
  | "hypothesis"
  | "mitigation"
  | "rebuttal"
  | "shield"
  | "users"
  | "x";

const iconClasses: Record<IconName, string> = {
  activity: "ph ph-list-bullets",
  alert: "ph ph-warning-octagon",
  broadcast: "ph ph-broadcast",
  check: "ph ph-check-circle",
  clock: "ph ph-clock-countdown",
  connection: "ph ph-wifi-high",
  connectionOff: "ph ph-wifi-slash",
  evidence: "ph ph-magnifying-glass",
  gauge: "ph ph-gauge",
  hypothesis: "ph ph-lightbulb",
  mitigation: "ph ph-wrench",
  rebuttal: "ph ph-arrows-counter-clockwise",
  shield: "ph ph-shield-check",
  users: "ph ph-users-three",
  x: "ph ph-x-circle",
};

export function icon(name: IconName, className = ""): HTMLElement {
  const node = element("i", `${iconClasses[name]} mc-icon${className ? ` ${className}` : ""}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}
