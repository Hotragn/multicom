import { TOOL_NAMES } from "../../shared/tools";
import type { RoomState } from "../../shared/ws-messages";
import { button, element, setHidden, setText, textElement } from "./dom";
import {
  agentInstruction,
  agentSeatNote,
  commanderSeatTaken,
  FIRST_AGENT_INSTRUCTION,
} from "./format";
import { icon } from "./icons";
import type { ParticipationTier, ToolRegistrationSummary, WarRoomEnvironment } from "./types";

export { FIRST_AGENT_INSTRUCTION };

export interface OnboardingCallbacks {
  onDriveManually(): void;
  onRunScriptedDrill(): void;
  onStartOwnRoom(): void;
  onCopy(text: string, label: string): void;
}

export interface OnboardingPanel {
  root: HTMLElement;
  render(input: {
    joined: boolean;
    room: RoomState | null;
    tier: ParticipationTier;
    registration: ToolRegistrationSummary;
    environment: WarRoomEnvironment;
    manualOpen: boolean;
  }): void;
}

function tierCard(
  ordinal: string,
  title: string,
  bodyText: string,
): { root: HTMLElement; body: HTMLElement; footer: HTMLElement; status: HTMLElement } {
  const root = element("li", "mc-tier");
  const head = element("div", "mc-tier__head");
  head.append(textElement("span", "mc-tier__ordinal", ordinal));
  head.append(textElement("h3", "mc-tier__title", title));
  const status = textElement("span", "mc-tier__status", "");
  head.append(status);
  const body = textElement("p", "mc-tier__body", bodyText);
  const footer = element("div", "mc-tier__footer");
  root.append(head, body, footer);
  return { root, body, footer, status };
}

/**
 * Three ways in, so nobody is stuck at a wall.
 *
 * The old copy told a visitor to "open this page in a browser with a WebMCP
 * agent", which is a dead end on stock Safari or Firefox. A judge now always has
 * at least one path that works in the browser they already have, and the panel
 * says plainly which one they are on so the manual path is never mistaken for
 * agent autonomy.
 */
export function createOnboarding(callbacks: OnboardingCallbacks): OnboardingPanel {
  const root = element("section", "mc-onboarding");
  // Kept from the earlier spectator notice: this element is still "you do not
  // have a seat yet", and it disappears the moment you do.
  root.dataset.testid = "spectator-banner";
  root.setAttribute("aria-labelledby", "mc-onboarding-heading");
  root.setAttribute("role", "region");

  const header = element("header", "mc-onboarding__header");
  const headline = element("div", "mc-onboarding__headline");
  const heading = textElement("h2", "mc-onboarding__heading", "You are watching this incident");
  heading.id = "mc-onboarding-heading";
  const subheading = textElement(
    "p",
    "mc-onboarding__subheading",
    "Invite from the bar above, then pick how you take part.",
  );
  headline.append(heading, subheading);
  header.append(headline);

  const tiers = element("ul", "mc-tiers");

  const agentTier = tierCard(
    "1",
    "Bring your own agent",
    "Best path. Your browser agent picks up the room tools and works the incident with you.",
  );
  const seatNote = textElement(
    "p",
    "mc-tier__note",
    "Send the instruction below to your agent. It cannot approve a fix — only the commander’s click can.",
  );
  agentTier.root.insertBefore(seatNote, agentTier.footer);
  agentTier.root.dataset.testid = "tier-agent";
  const instruction = element("div", "mc-instruction");
  const instructionText = textElement("p", "mc-instruction__text", FIRST_AGENT_INSTRUCTION);
  instructionText.dataset.testid = "agent-instruction";
  let commanderTaken = false;
  const copyInstruction = button("mc-button mc-button--ghost", "Copy first instruction", () =>
    callbacks.onCopy(
      instructionText.textContent ?? agentInstruction(commanderTaken),
      commanderTaken ? "Responder instruction" : "First instruction",
    ),
  );
  copyInstruction.prepend(icon("copy"));
  instruction.append(instructionText, copyInstruction);
  const setupNote = element("details", "mc-setup-note");
  setupNote.append(
    textElement("summary", "mc-setup-note__summary", "No agent in this browser? Enable WebMCP"),
  );
  const setupList = element("ol", "mc-setup-note__list");
  for (const step of [
    "Use Chrome 149 or newer.",
    "Open chrome://flags/#enable-webmcp-testing and set it to Enabled.",
    "Relaunch Chrome and reload this page.",
    "Otherwise this page falls back to the MCP-B polyfill, and tiers 2 and 3 below work in any browser.",
  ]) {
    setupList.append(textElement("li", "", step));
  }
  setupNote.append(setupList);
  agentTier.footer.append(instruction, setupNote);

  const manualTier = tierCard(
    "2",
    "Drive it myself",
    "Real controls for a human hand: run a check, pull logs, propose, counter, vote, state a reason, ask for approval. Same messages, no shortcuts.",
  );
  manualTier.root.dataset.testid = "tier-manual";
  const manualButton = button("mc-button mc-button--primary", "Drive it myself", () =>
    callbacks.onDriveManually(),
  );
  manualButton.dataset.testid = "drive-manually";
  manualButton.prepend(icon("hand"));
  manualTier.footer.append(manualButton);

  const scriptedTier = tierCard(
    "3",
    "Run the scripted drill",
    "No setup at all. The house responder joins, argues the red herring, concedes to evidence, and votes — about ninety seconds end to end.",
  );
  scriptedTier.root.dataset.testid = "tier-scripted";
  const scriptedButton = button("mc-button mc-button--secondary", "Run the scripted drill", () =>
    callbacks.onRunScriptedDrill(),
  );
  scriptedButton.dataset.testid = "run-scripted-drill";
  scriptedButton.prepend(icon("demo"));
  scriptedTier.footer.append(scriptedButton);

  tiers.append(agentTier.root, manualTier.root, scriptedTier.root);

  const ownRoom = element("p", "mc-onboarding__own-room");
  ownRoom.hidden = true;
  const ownRoomButton = button("mc-button mc-button--ghost", "Start your own incident", () =>
    callbacks.onStartOwnRoom(),
  );
  ownRoomButton.dataset.testid = "start-own-room";
  ownRoomButton.prepend(icon("lobby"));
  ownRoom.append(
    textElement(
      "span",
      "",
      "Sharing this room with other judges? You can have an isolated incident of your own.",
    ),
    ownRoomButton,
  );

  root.append(header, tiers, ownRoom);

  return {
    root,
    render({ joined, room, tier, registration, environment, manualOpen }) {
      // A visitor with a seat does not need the way in any more.
      setHidden(root, joined);
      root.dataset.tier = tier;
      commanderTaken = commanderSeatTaken(room?.members);
      setText(instructionText, agentInstruction(commanderTaken));
      setText(seatNote, agentSeatNote(commanderTaken));
      setText(heading, "You are watching this incident");

      const registered = registration.status === "registered";
      agentTier.root.dataset.available = String(registered);
      setText(
        agentTier.status,
        registration.status === "pending"
          ? "Checking this browser"
          : registered
            ? `${registration.count} of ${TOOL_NAMES.length} tools ${
                registration.native ? "in this browser's own WebMCP surface" : "via the MCP-B polyfill"
              }`
            : "Not available in this browser",
      );
      setText(
        agentTier.body,
        registered
          ? registration.native
            ? "Best path. This browser exposes WebMCP itself, and the room tools are registered into it."
            : "Best path. The MCP-B polyfill is active, so an agent that speaks WebMCP can pick up the room tools."
          : registration.message ??
            "This browser did not expose a WebMCP surface. Use tier 2 or tier 3 instead.",
      );

      manualButton.disabled = manualOpen;
      setText(manualButton, manualOpen ? "Manual controls open below" : "Drive it myself");
      manualButton.prepend(icon("hand"));
      scriptedButton.disabled = environment.demo;
      setText(
        scriptedTier.status,
        environment.demo ? "Already running in this room" : "Works in any browser",
      );
      setText(
        copyInstruction,
        commanderTaken ? "Copy responder instruction" : "Copy first instruction",
      );
      copyInstruction.prepend(icon("copy"));

      ownRoom.hidden = !environment.startOwnRoom || environment.selfServe;
    },
  };
}
