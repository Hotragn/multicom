import "./phosphor.css";
import { SERVICE_NAME } from "../../shared/scenario";
import { button, element, prefersReducedMotion, setText, textElement } from "./dom";
import { createBrand } from "./brand";
import { icon } from "./icons";
import { mountViz } from "./viz";
import "./styles.css";

export interface LobbyActions {
  /** Provision an isolated room and open it. Resolves after navigation starts. */
  startOwnIncident(): Promise<void>;
  /** Open the curated public demo. */
  watchCuratedDemo(): void;
}

export interface MountedLobby {
  destroy(): void;
}

const FEATURES: Array<{ icon: Parameters<typeof icon>[0]; title: string; body: string }> = [
  {
    icon: "users",
    title: "Many people, many agents, one page",
    body: "Up to six people and their agents share one WebSocket. Copy the invite from the room — isolation is from other judges, not from your teammates.",
  },
  {
    icon: "vote",
    title: "The debate is the product",
    body: "Hypotheses carry cited evidence, take rebuttals, and win or lose a majority vote with stated reasons.",
  },
  {
    icon: "shield",
    title: "A human holds the write",
    body: "Nothing reaches production without a commander's approval, and that approval is good for one apply for sixty seconds.",
  },
  {
    icon: "trap",
    title: "A planted prompt injection",
    body: "One synthetic log line tells agents to skip diagnosis. It is returned as untrusted data and rendered as plain text.",
  },
];

/**
 * The landing page.
 *
 * The old default sent every visitor into one shared room, so a second judge
 * trampled the first judge's board and a seventh was refused outright. A visitor
 * now chooses: their own isolated incident, or the curated demo.
 */
export function mountLobby(root: HTMLElement, actions: LobbyActions): MountedLobby {
  const app = element("div", "mc-war-room mc-lobby");
  app.dataset.testid = "lobby";

  const skipLink = textElement("a", "mc-skip-link", "Skip to how a session works");
  skipLink.href = "#mc-guide-heading";

  const topbar = element("div", "mc-topbar");
  topbar.append(createBrand({ home: false, context: "Incident war room" }).root);

  const hero = element("section", "mc-hero mc-hero--lobby");
  const stage = element("div", "mc-viz");
  const viz = mountViz(stage);
  viz.update({
    // A believable room, so the landing graph is not an empty circle.
    participants: [
      { id: "l1", name: "Priya", role: "commander", active: true },
      { id: "l2", name: "Arjun", role: "responder", active: true },
      { id: "l3", name: "Mei", role: "responder", active: true },
    ],
    phase: "diagnosing",
    errorRate: 0.23,
  });

  const copy = element("div", "mc-hero__copy");
  const eyebrow = element("p", "mc-hero__eyebrow");
  eyebrow.append(icon("alert"));
  eyebrow.append(document.createTextNode("WebMCP Challenge"));
  const title = textElement("h1", "mc-hero__title", "A war room your agent can join");
  const subtitle = textElement(
    "p",
    "mc-hero__subtitle",
    `${SERVICE_NAME} is at 23% errors. Open one room with your teammates and their agents. A human still has to approve the fix.`,
  );
  copy.append(eyebrow, title, subtitle);
  hero.append(stage, copy);

  const guide = element("section", "mc-guide");
  guide.dataset.testid = "site-onboarding";
  guide.setAttribute("aria-labelledby", "mc-guide-heading");
  const guideIntro = element("header", "mc-guide__intro");
  const guideHeading = textElement("h2", "mc-guide__heading", "How a session works");
  guideHeading.id = "mc-guide-heading";
  const guideSub = textElement(
    "p",
    "mc-guide__sub",
    "This is a multiplayer room. The page you open is the board everyone else sees.",
  );
  guideIntro.append(guideHeading, guideSub);
  const steps = element("ol", "mc-guide__steps");
  const GUIDE_STEPS: Array<{ title: string; body: string }> = [
    {
      title: "Start a room",
      body: "Your own incident, or an invite you were sent. The live demo is the public curated room.",
    },
    {
      title: "Invite someone",
      body: "Copy the invite in the room. A second browser lands on the same board.",
    },
    {
      title: "Take seats",
      body: "One commander holds Approve. Everyone else joins as responder, then may bring an agent.",
    },
    {
      title: "Fix it together",
      body: "Evidence and votes are shared. A majority is not a write. The commander clicks Approve.",
    },
  ];
  for (const [index, step] of GUIDE_STEPS.entries()) {
    const item = element("li", "mc-guide__step");
    item.append(textElement("span", "mc-guide__ordinal", String(index + 1)));
    const text = element("div", "mc-guide__text");
    text.append(textElement("h3", "mc-guide__title", step.title));
    text.append(textElement("p", "mc-guide__body", step.body));
    item.append(text);
    steps.append(item);
  }
  guide.append(guideIntro, steps);

  const paths = element("section", "mc-paths");
  paths.id = "mc-lobby-paths";
  paths.setAttribute("aria-labelledby", "mc-paths-heading");
  const pathsHeading = textElement("h2", "mc-visually-hidden", "Two ways in");
  pathsHeading.id = "mc-paths-heading";

  const ownCard = element("article", "mc-path mc-path--primary");
  ownCard.append(icon("lobby", "mc-path__icon"));
  ownCard.append(textElement("h3", "mc-path__title", "Start my own incident"));
  ownCard.append(
    textElement(
      "p",
      "mc-path__body",
      "A fresh room with its own copy of the fault. You can claim commander with no secret. Share the invite with teammates — they join the same board. Other judges get their own rooms.",
    ),
  );
  const ownStatus = textElement("p", "mc-path__status", "");
  ownStatus.setAttribute("role", "status");
  ownStatus.hidden = true;
  let starting = false;
  const startButton = button("mc-button mc-button--primary mc-button--large", "Start my own incident", () => {
    if (starting) return;
    starting = true;
    setText(startButton, "Provisioning a room...");
    startButton.disabled = true;
    ownStatus.hidden = true;
    void actions
      .startOwnIncident()
      .catch((error: unknown) => {
        starting = false;
        startButton.disabled = false;
        setText(startButton, "Start my own incident");
        setText(
          ownStatus,
          error instanceof Error && error.message
            ? error.message
            : "Could not provision a room. Try the live demo instead.",
        );
        ownStatus.hidden = false;
      });
  });
  startButton.dataset.testid = "start-own-incident";
  ownCard.append(startButton, ownStatus);

  const demoCard = element("article", "mc-path");
  demoCard.append(icon("spectate", "mc-path__icon"));
  demoCard.append(textElement("h3", "mc-path__title", "Watch the live demo"));
  demoCard.append(
    textElement(
      "p",
      "mc-path__body",
      "The curated room, with a house responder that proposes the red herring and then concedes to the evidence. Read-only, and shared with everyone else watching.",
    ),
  );
  const demoButton = button("mc-button mc-button--secondary mc-button--large", "Watch the live demo", () =>
    actions.watchCuratedDemo(),
  );
  demoButton.dataset.testid = "watch-live-demo";
  demoCard.append(demoButton);

  paths.append(pathsHeading, ownCard, demoCard);

  const features = element("section", "mc-features");
  features.setAttribute("aria-label", "What this demonstrates");
  for (const feature of FEATURES) {
    const card = element("article", "mc-feature");
    card.append(icon(feature.icon, "mc-feature__icon"));
    card.append(textElement("h3", "mc-feature__title", feature.title));
    card.append(textElement("p", "mc-feature__body", feature.body));
    features.append(card);
  }

  const footer = element("footer", "mc-safety-note");
  footer.append(icon("shield"));
  footer.append(
    textElement(
      "p",
      "",
      "The scripted target service is the entire write surface. Agents choose from a fixed action library and cannot invent a production change.",
    ),
  );

  app.append(skipLink, topbar, hero, guide, paths, features, footer);
  app.dataset.motion = prefersReducedMotion() ? "reduced" : "full";
  root.classList.add("mc-host");
  root.replaceChildren(app);

  return {
    destroy() {
      viz.destroy();
      app.remove();
      root.classList.remove("mc-host");
    },
  };
}
