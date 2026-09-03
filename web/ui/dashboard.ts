import { SERVICE_NAME } from "../../shared/scenario";
import type { RoomState, ServiceStatus } from "../../shared/ws-messages";
import { appendText, element, setText, svg, textElement } from "./dom";
import {
  clamp,
  formatElapsed,
  formatErrorRate,
  formatLatency,
  phaseLabel,
} from "./format";
import { icon } from "./icons";

export interface StatusPoint {
  at: number;
  p99ms: number;
  errorRate: number;
}

export interface DashboardSection {
  root: HTMLElement;
  render(input: {
    room: RoomState | null;
    status: ServiceStatus | null;
    history: StatusPoint[];
    elapsedSeconds: number;
  }): void;
}

// Anything at or above this reads as an active incident; the acceptance gate
// for recovery is the same 2% the room Worker uses to declare resolution.
const HEALTHY_ERROR_RATE = 0.02;
const GAUGE_RADIUS = 54;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
// Full sweep at 25% errors: the scripted fault sits at 23%, so the needle is
// near the top of the dial while the incident is live and visibly falls.
const GAUGE_FULL_SCALE = 0.25;

const TIMELINE_WIDTH = 520;
const TIMELINE_HEIGHT = 132;

function createGauge(): {
  root: HTMLElement;
  arc: SVGCircleElement;
  value: HTMLElement;
  caption: HTMLElement;
} {
  const root = element("div", "mc-gauge");
  const figure = svg("svg", {
    viewBox: "0 0 140 140",
    class: "mc-gauge__svg",
    role: "img",
    "aria-labelledby": "mc-gauge-title",
  });
  const title = svg("title", { id: "mc-gauge-title" });
  appendText(title, "Error rate gauge");
  const track = svg("circle", {
    class: "mc-gauge__track",
    cx: "70",
    cy: "70",
    r: String(GAUGE_RADIUS),
  });
  const arc = svg("circle", {
    class: "mc-gauge__arc",
    cx: "70",
    cy: "70",
    r: String(GAUGE_RADIUS),
    "stroke-dasharray": String(GAUGE_CIRCUMFERENCE),
    "stroke-dashoffset": String(GAUGE_CIRCUMFERENCE),
  });
  figure.append(title, track, arc);

  const readout = element("div", "mc-gauge__readout");
  const value = textElement("p", "mc-gauge__value", "--");
  value.dataset.testid = "error-rate";
  const label = textElement("p", "mc-gauge__label", "Error rate");
  const caption = textElement("p", "mc-gauge__caption", "Waiting for the first sample");
  readout.append(value, label);
  root.append(figure, readout, caption);
  return { root, arc, value, caption };
}

function createBigNumber(
  label: string,
  iconName: Parameters<typeof icon>[0],
  testId?: string,
): { root: HTMLElement; value: HTMLElement; note: HTMLElement } {
  const root = element("div", "mc-stat");
  const head = element("div", "mc-stat__head");
  head.append(icon(iconName));
  head.append(textElement("span", "", label));
  const value = textElement("p", "mc-stat__value", "--");
  if (testId) value.dataset.testid = testId;
  const note = textElement("p", "mc-stat__note", "");
  root.append(head, value, note);
  return { root, value, note };
}

export function createDashboard(): DashboardSection {
  const root = element("section", "mc-dashboard");
  root.dataset.testid = "dashboard";
  root.setAttribute("aria-labelledby", "mc-dashboard-heading");

  const header = element("header", "mc-dashboard__header");
  const heading = textElement("h2", "mc-dashboard__heading", "Service health");
  heading.id = "mc-dashboard-heading";
  const service = element("p", "mc-dashboard__service");
  service.append(icon("pulse"));
  service.append(textElement("code", "", SERVICE_NAME));
  const phase = textElement("span", "mc-phase", phaseLabel("triage"));
  phase.dataset.testid = "room-phase";
  header.append(heading, service, phase);

  const gauge = createGauge();

  const latency = createBigNumber("p99 latency", "gauge", "p99-latency");
  const pool = createBigNumber("DB pool", "network");
  const deploy = createBigNumber("Deploy", "write");
  const mttr = createBigNumber("MTTR", "clock", "mttr");

  const timeline = element("div", "mc-timeline");
  const timelineHead = element("div", "mc-timeline__head");
  timelineHead.append(icon("trendDown"));
  timelineHead.append(textElement("span", "", "p99 latency, last 60 seconds"));
  const chart = svg("svg", {
    viewBox: `0 0 ${TIMELINE_WIDTH} ${TIMELINE_HEIGHT}`,
    class: "mc-timeline__svg",
    role: "img",
    preserveAspectRatio: "none",
    "aria-labelledby": "mc-timeline-title",
  });
  const chartTitle = svg("title", { id: "mc-timeline-title" });
  appendText(chartTitle, "Waiting for latency data");
  const grid = svg("g", { class: "mc-timeline__grid" });
  for (const fraction of [0.25, 0.5, 0.75]) {
    grid.append(
      svg("line", {
        x1: "0",
        x2: String(TIMELINE_WIDTH),
        y1: String(TIMELINE_HEIGHT * fraction),
        y2: String(TIMELINE_HEIGHT * fraction),
      }),
    );
  }
  const area = svg("path", { class: "mc-timeline__area" });
  const line = svg("path", { class: "mc-timeline__line", "vector-effect": "non-scaling-stroke" });
  const head = svg("circle", { class: "mc-timeline__head", r: "4", cx: "-10", cy: "-10" });
  chart.append(chartTitle, grid, area, line, head);
  const scale = element("div", "mc-timeline__scale");
  const scaleHigh = textElement("span", "", "--");
  const scaleLow = textElement("span", "", "--");
  scale.append(scaleHigh, scaleLow);
  timeline.append(timelineHead, chart, scale);

  const stats = element("div", "mc-dashboard__stats");
  stats.append(latency.root, pool.root, deploy.root, mttr.root);

  const resolved = textElement("p", "mc-resolved-summary", "Incident resolved.");
  resolved.dataset.testid = "resolved-summary";
  resolved.hidden = true;

  root.append(header, gauge.root, stats, timeline, resolved);

  const renderTimeline = (history: StatusPoint[]): void => {
    if (history.length === 0) {
      line.setAttribute("d", "");
      area.setAttribute("d", "");
      head.setAttribute("cx", "-10");
      setText(chartTitle, "Waiting for latency data");
      setText(scaleHigh, "--");
      setText(scaleLow, "--");
      return;
    }
    const values = history.map((point) => Math.max(0, point.p99ms));
    const maximum = Math.max(...values, 1);
    const minimum = Math.min(...values);
    const spread = Math.max(1, maximum - minimum);
    const top = 10;
    const usable = TIMELINE_HEIGHT - top - 8;
    const coordinates = history.map((point, index) => {
      const x =
        history.length === 1 ? TIMELINE_WIDTH : (index / (history.length - 1)) * TIMELINE_WIDTH;
      const normalized = (Math.max(0, point.p99ms) - minimum) / spread;
      return { x, y: top + usable - normalized * usable };
    });
    const path = coordinates
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" ");
    line.setAttribute("d", path);
    const first = coordinates[0]!;
    const last = coordinates[coordinates.length - 1]!;
    area.setAttribute(
      "d",
      `${path} L${last.x.toFixed(1)} ${TIMELINE_HEIGHT} L${first.x.toFixed(1)} ${TIMELINE_HEIGHT} Z`,
    );
    head.setAttribute("cx", last.x.toFixed(1));
    head.setAttribute("cy", last.y.toFixed(1));
    setText(scaleHigh, formatLatency(maximum));
    setText(scaleLow, formatLatency(minimum));
    setText(
      chartTitle,
      `p99 latency across ${history.length} samples, from ${formatLatency(values[0]!)} to ${formatLatency(
        values[values.length - 1]!,
      )}.`,
    );
  };

  return {
    root,
    render({ room, status, history, elapsedSeconds }) {
      const isResolved = room?.phase === "resolved";
      const health = isResolved
        ? "resolved"
        : status
          ? status.errorRate < HEALTHY_ERROR_RATE
            ? "recovering"
            : "critical"
          : "unknown";
      root.dataset.health = health;

      setText(phase, phaseLabel(room?.phase ?? "triage"));
      phase.className = `mc-phase mc-phase--${room?.phase ?? "triage"}`;

      setText(gauge.value, status ? formatErrorRate(status.errorRate) : "--");
      const filled = status ? clamp(status.errorRate / GAUGE_FULL_SCALE, 0, 1) : 0;
      gauge.arc.setAttribute(
        "stroke-dashoffset",
        String(GAUGE_CIRCUMFERENCE * (1 - filled)),
      );
      setText(
        gauge.caption,
        !status
          ? "Waiting for the first sample"
          : status.errorRate < HEALTHY_ERROR_RATE
            ? "Inside the 2% recovery threshold"
            : `${formatErrorRate(status.errorRate)} of checkout requests are failing`,
      );

      setText(latency.value, status ? formatLatency(status.p99ms) : "--");
      setText(latency.note, status && status.p99ms > 1_500 ? "Customers are timing out" : "Baseline is 420ms");

      setText(pool.value, status ? `${status.pool.inUse}/${status.pool.max}` : "--");
      setText(
        pool.note,
        status ? (status.pool.max <= 1 ? "Saturated at one connection" : "Connections available") : "",
      );

      setText(deploy.value, status ? status.currentDeploy : "--");
      const flags = status ? Object.entries(status.flagStates) : [];
      setText(
        deploy.note,
        flags.length === 0
          ? ""
          : flags.map(([flag, on]) => `${flag} ${on ? "on" : "off"}`).join(", "),
      );

      const formattedElapsed = formatElapsed(elapsedSeconds);
      setText(mttr.value, formattedElapsed);
      mttr.value.setAttribute("aria-label", `Mean time to resolution ${formattedElapsed}`);
      setText(mttr.note, isResolved ? "Timer stopped" : "Counting up");

      if (isResolved && room) {
        setText(
          resolved,
          room.appliedActions.includes("scale_pool:default")
            ? `Resolved in ${formattedElapsed}. DB pool restored.`
            : `Resolved in ${formattedElapsed}. Service is stable.`,
        );
        resolved.hidden = false;
      } else {
        resolved.hidden = true;
      }

      renderTimeline(history);
    },
  };
}
