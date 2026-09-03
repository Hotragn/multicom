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
  node.setAttribute("aria-hidden", hidden ? "true" : "false");
}
