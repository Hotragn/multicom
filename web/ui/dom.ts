export type ElementTag = keyof HTMLElementTagNameMap;

export function element<K extends ElementTag>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

export function appendText(node: ParentNode, value: unknown): void {
  node.append(document.createTextNode(String(value)));
}

export function setText(node: ParentNode, value: unknown): void {
  node.replaceChildren(document.createTextNode(String(value)));
}

export function textElement<K extends ElementTag>(
  tag: K,
  className: string,
  value: unknown,
): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  appendText(node, value);
  return node;
}

export function clear(node: ParentNode): void {
  node.replaceChildren();
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
  node.inert = hidden;
  node.setAttribute("aria-hidden", hidden ? "true" : "false");
}

/** A button whose label is a text node, never markup. */
export function button(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = textElement("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

export function labelledField(
  labelText: string,
  control: HTMLElement,
  hint?: string,
): HTMLLabelElement {
  const wrapper = element("label", "mc-field");
  wrapper.append(textElement("span", "mc-field__label", labelText));
  wrapper.append(control);
  if (hint) wrapper.append(textElement("span", "mc-field__hint", hint));
  return wrapper;
}

/**
 * `prefers-reduced-motion` is checked once per call rather than cached, so a
 * judge who flips the OS setting mid-session gets the quiet interface without a
 * reload.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
