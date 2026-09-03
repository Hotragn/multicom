import { button, element, setText, textElement } from "./dom";
import { inviteCopy } from "./format";
import { icon } from "./icons";

export interface InviteStrip {
  root: HTMLElement;
  render(input: { seated: number; demo: boolean }): void;
}

/**
 * How a second person actually enters the room.
 *
 * The protocol already broadcasts the board. What failed in live QA was the
 * human step: share was an unlabeled control, and the lobby told people the
 * room was private. This strip is that missing step, in the room itself.
 */
export function createInviteStrip(onCopy: () => void): InviteStrip {
  const root = element("section", "mc-invite");
  root.dataset.testid = "invite-strip";
  root.setAttribute("aria-labelledby", "mc-invite-title");

  const copy = element("div", "mc-invite__copy");
  const title = textElement("h2", "mc-invite__title", "");
  title.id = "mc-invite-title";
  const body = textElement("p", "mc-invite__body", "");
  copy.append(title, body);

  const action = button("mc-button mc-button--secondary", "Copy invite link", () => onCopy());
  action.dataset.testid = "copy-invite";
  action.prepend(icon("share"));

  root.append(copy, action);

  return {
    root,
    render({ seated, demo }) {
      const next = inviteCopy({ seated, demo });
      root.dataset.seated = String(seated);
      root.dataset.demo = String(demo);
      setText(title, next.title);
      setText(body, next.body);
    },
  };
}
