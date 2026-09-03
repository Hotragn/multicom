import { element, textElement } from "./dom";
import { icon } from "./icons";

export interface BrandMark {
  root: HTMLElement;
}

/**
 * Wordmark. On a room page it is the way back to the lobby — the icon looked
 * clickable and did nothing, which is how people get stuck in an incident.
 */
export function createBrand(input: { home: boolean; context: string }): BrandMark {
  const root = input.home ? element("a", "mc-brand mc-brand--home") : element("div", "mc-brand");
  if (input.home) {
    const link = root as HTMLAnchorElement;
    link.href = "/";
    link.dataset.testid = "home-link";
    link.setAttribute("aria-label", "Back to lobby");
  }
  root.append(icon("broadcast", "mc-brand__icon"));
  const copy = element("span", "mc-brand__copy");
  copy.append(textElement("span", "mc-brand__name", "multicom"));
  copy.append(textElement("span", "mc-brand__context", input.context));
  root.append(copy);
  return { root };
}
