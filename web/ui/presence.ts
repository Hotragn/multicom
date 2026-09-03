import type { Member, RoomState } from "../../shared/ws-messages";
import { clear, element, setText, textElement } from "./dom";
import { icon } from "./icons";

export interface PresenceRail {
  root: HTMLElement;
  render(room: RoomState | null): void;
  /** Ring the avatar for one member, e.g. after a vote or an applied action. */
  flash(memberId: string): void;
}

/** Six stable hues, assigned by join order so a member keeps their colour. */
const ACCENTS = [
  "var(--mc-person-1)",
  "var(--mc-person-2)",
  "var(--mc-person-3)",
  "var(--mc-person-4)",
  "var(--mc-person-5)",
  "var(--mc-person-6)",
] as const;

export function memberAccent(room: RoomState | null, memberId: string): string {
  const index = room?.members.findIndex((member) => member.id === memberId) ?? -1;
  return ACCENTS[(index < 0 ? 0 : index) % ACCENTS.length]!;
}

/** First letter of each of the first two words, so "Responder 2" reads "R2". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((word) => [...word][0] ?? "").join("").toUpperCase();
}

export function createPresenceRail(): PresenceRail {
  const root = element("div", "mc-presence");
  root.dataset.testid = "presence-rail";
  root.setAttribute("aria-label", "People in this room");
  const list = element("ul", "mc-presence__list");
  const summary = textElement("p", "mc-presence__summary", "Nobody seated yet");
  summary.dataset.testid = "presence-summary";
  root.append(list, summary);

  const avatars = new Map<string, HTMLElement>();

  const renderMember = (room: RoomState, member: Member): HTMLLIElement => {
    const item = element("li", "mc-presence__item");
    item.dataset.memberId = member.id;
    item.dataset.role = member.role;
    item.dataset.active = String(member.agentActive);
    const avatar = textElement("span", "mc-avatar", initials(member.name));
    avatar.style.setProperty("--mc-avatar-accent", memberAccent(room, member.id));
    avatar.setAttribute("aria-hidden", "true");
    const label = element("span", "mc-presence__label");
    label.append(textElement("span", "mc-presence__name", member.name));
    label.append(
      textElement(
        "span",
        "mc-presence__role",
        member.agentActive ? member.role : `${member.role} · away`,
      ),
    );
    item.append(avatar, label);
    // The name is peer-authored, so it is only ever a text node — including in
    // the accessible name, which is built from the same string.
    item.setAttribute(
      "aria-label",
      `${member.name}, ${member.role}${member.agentActive ? "" : ", away"}`,
    );
    avatars.set(member.id, avatar);
    return item;
  };

  return {
    root,
    render(room) {
      clear(list);
      avatars.clear();
      const members = room?.members ?? [];
      for (const member of members) list.append(renderMember(room!, member));
      const active = members.filter((member) => member.agentActive).length;
      setText(
        summary,
        members.length === 0
          ? "Nobody seated yet"
          : active === 0
            ? "Everyone is away"
            : `${active} ${active === 1 ? "person" : "people"} in room`,
      );
      root.dataset.count = String(active);
      if (members.length === 0) {
        const empty = element("li", "mc-presence__item mc-presence__item--empty");
        empty.append(icon("users"));
        empty.append(textElement("span", "mc-presence__name", "Invite a teammate"));
        list.append(empty);
      }
    },
    flash(memberId) {
      const avatar = avatars.get(memberId);
      if (!avatar) return;
      avatar.classList.remove("mc-avatar--flash");
      // Force a reflow so the animation restarts for a rapid second event.
      void avatar.offsetWidth;
      avatar.classList.add("mc-avatar--flash");
    },
  };
}
