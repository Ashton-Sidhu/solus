/** The nearest ancestor that scrolls vertically, or null for the page. */
export function scrollContainerOf(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}
