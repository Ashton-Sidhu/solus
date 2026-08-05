/**
 * Scrollbars are painted only while their scroller is actually moving, the way
 * the macOS overlay bar behaves — a thumb drawn at rest reads as a rule down
 * the side of the pane rather than as a position.
 *
 * Hover is the wrong trigger for this: a scroller usually fills its whole pane,
 * so it is hovered the entire time you are reading it. Chromium has no selector
 * for "this element is scrolling" and refuses to animate ::-webkit-scrollbar
 * pseudo-elements, so the state is stamped here as `data-scrolling` and
 * index.css keys the thumb colour off the attribute.
 */
const IDLE_MS = 900;

const idleTimers = new WeakMap<Element, number>();

function markScrolling(element: Element): void {
  // Re-setting an unchanged attribute on every scroll event would invalidate
  // style on the element for each frame of the gesture.
  if (!element.hasAttribute("data-scrolling")) {
    element.setAttribute("data-scrolling", "");
  }
  window.clearTimeout(idleTimers.get(element));
  idleTimers.set(
    element,
    window.setTimeout(() => {
      element.removeAttribute("data-scrolling");
      idleTimers.delete(element);
    }, IDLE_MS),
  );
}

/** One capture-phase listener covers every scroller in the app, including ones
 *  owned by third-party components that never see our markup. */
export function startScrollReveal(): void {
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      markScrolling(
        target instanceof Element ? target : document.documentElement,
      );
    },
    { capture: true, passive: true },
  );
}
