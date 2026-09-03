import type { RoomState } from "../../shared/ws-messages";
import { clear, element, setHidden, setText, textElement } from "./dom";
import { epochSecondsToDate, formatActivityTime } from "./format";
import { icon } from "./icons";

export interface ActivityDrawer {
  root: HTMLElement;
  render(room: RoomState | null): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

/**
 * The activity log, demoted to a drawer.
 *
 * It is reference material — a judge should be able to reconstruct the incident
 * from it — but it is not a third of the screen. Entries are server-authored
 * sentences and are rendered as text nodes only.
 */
export function createActivityDrawer(initiallyOpen: boolean): ActivityDrawer {
  const root = element("aside", "mc-drawer");
  root.dataset.testid = "activity-drawer";
  root.setAttribute("aria-labelledby", "mc-activity-heading");

  const toggle = element("button", "mc-drawer__toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(initiallyOpen));
  toggle.setAttribute("aria-controls", "mc-activity-body");
  const toggleLabel = element("span", "mc-drawer__label");
  toggleLabel.append(icon("activity"));
  const heading = textElement("h2", "mc-drawer__heading", "Activity");
  heading.id = "mc-activity-heading";
  toggleLabel.append(heading);
  const count = textElement("span", "mc-count", "0");
  count.dataset.testid = "activity-count";
  const chevron = icon("collapse", "mc-drawer__chevron");
  toggle.append(toggleLabel, count, chevron);

  const body = element("div", "mc-drawer__body");
  body.id = "mc-activity-body";
  const list = element("ol", "mc-activity-list");
  list.dataset.testid = "activity-list";
  const empty = element("div", "mc-empty mc-empty--compact");
  empty.append(textElement("p", "mc-empty__title", "Room is quiet"));
  empty.append(
    textElement("p", "mc-empty__body", "Agent actions and human decisions land here."),
  );
  body.append(empty, list);
  root.append(toggle, body);

  let open = initiallyOpen;
  const apply = (): void => {
    root.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  };
  toggle.addEventListener("click", () => {
    open = !open;
    apply();
  });
  apply();

  return {
    root,
    render(room) {
      const entries = room?.log ?? [];
      setText(count, entries.length);
      count.setAttribute(
        "aria-label",
        `${entries.length} ${entries.length === 1 ? "activity entry" : "activity entries"}`,
      );
      setHidden(empty, entries.length > 0);
      setHidden(list, entries.length === 0);
      clear(list);
      for (const entry of entries) {
        const item = element("li", "mc-activity-entry");
        const time = textElement("time", "mc-activity-entry__time", formatActivityTime(entry.t));
        time.dateTime = epochSecondsToDate(entry.t).toISOString();
        item.append(time, textElement("p", "mc-activity-entry__text", entry.text));
        list.append(item);
      }
      list.scrollTop = list.scrollHeight;
    },
    setOpen(next) {
      open = next;
      apply();
    },
    isOpen() {
      return open;
    },
  };
}
