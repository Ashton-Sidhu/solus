// Centralized horizontal-scroll controller for the tab strip.
//
// Owns the scroll element, the overflow/edge flags, and the input handlers
// (wheel, paging, scroll) so the component doesn't juggle a tangle of
// `getBoundingClientRect` calls and magic timeouts. All measurement is funneled
// through a single rAF so a fast scroll or resize never thrashes layout.

/** Tunables, named so the component never hardcodes a bare pixel/ms again. */
export const TAB_SCROLL = {
  /** Slack (px) before an edge counts as "there's more to scroll this way". */
  edgeSlack: 4,
  /** Kept-visible overlap (px) when paging, so the edge tab stays for continuity. */
  pageOverlap: 80,
  /** Floor (px) for a single page jump on a narrow strip. */
  minPage: 160,
  /** After user-driven scroll, suppress auto-scroll-into-view for this long (ms). */
  manualIdleMs: 450,
} as const;

export type TabScroll = ReturnType<typeof createTabScroll>;

export function createTabScroll(opts: { onMeasure?: () => void } = {}) {
  let el: HTMLElement | null = null;
  let canLeft = $state(false);
  let canRight = $state(false);
  let overflowing = $state(false);
  let lastManual = 0;
  let raf = 0;

  function measure() {
    raf = 0;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    overflowing = scrollWidth - clientWidth > TAB_SCROLL.edgeSlack;
    canLeft = scrollLeft > TAB_SCROLL.edgeSlack;
    canRight = scrollLeft + clientWidth < scrollWidth - TAB_SCROLL.edgeSlack;
    opts.onMeasure?.();
  }

  /** Coalesce every measurement request into one rAF — no per-frame thrash. */
  function schedule() {
    if (!raf) raf = requestAnimationFrame(measure);
  }

  function markManual() {
    lastManual = performance.now();
  }

  function onScroll() {
    markManual();
    schedule();
  }

  // Mouse-wheel (vertical) → horizontal scroll. Trackpads already emit deltaX,
  // so leave those alone and only translate a pure vertical wheel.
  function onWheel(e: WheelEvent) {
    if (!el || e.deltaX !== 0 || e.deltaY === 0) return;
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
    markManual();
    schedule();
  }

  return {
    get canLeft() {
      return canLeft;
    },
    get canRight() {
      return canRight;
    },
    get overflowing() {
      return overflowing;
    },
    get el() {
      return el;
    },
    /** True if the user scrolled/wheeled within the idle window — used to avoid
     *  yanking the strip back to the active tab while they're browsing. */
    recentlyManual() {
      return performance.now() - lastManual < TAB_SCROLL.manualIdleMs;
    },
    /** Request a (throttled) re-measure of edge/overflow state + gap. */
    remeasure: schedule,

    /** Page one screenful in `dir`, snapping the landing point to the nearest
     *  tab boundary so a click never leaves a half-clipped tab at the edge. */
    page(dir: -1 | 1) {
      if (!el) return;
      markManual();
      const pageSize = Math.max(TAB_SCROLL.minPage, el.clientWidth - TAB_SCROLL.pageOverlap);
      const rawTarget = el.scrollLeft + dir * pageSize;
      const rowLeft = el.getBoundingClientRect().left;
      // Snap to whichever child boundary lands closest to the raw page target.
      // Seed with the true start (0): the scroller's leading padding offsets the
      // first tab's boundary a few px past 0, so without 0 as a candidate, paging
      // left snaps there and the strip never reaches the actual start.
      let target = 0;
      let bestDist = Math.abs(0 - rawTarget);
      for (const child of el.children) {
        const contentLeft =
          (child as HTMLElement).getBoundingClientRect().left - rowLeft + el.scrollLeft;
        const dist = Math.abs(contentLeft - rawTarget);
        if (dist < bestDist) {
          bestDist = dist;
          target = contentLeft;
        }
      }
      target = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
      el.scrollTo({ left: target, behavior: "smooth" });
    },

    /** Svelte action: bind the scroll element and wire its listeners. */
    attach(node: HTMLElement) {
      el = node;
      node.addEventListener("scroll", onScroll, { passive: true });
      node.addEventListener("wheel", onWheel, { passive: false });
      const ro = new ResizeObserver(schedule);
      ro.observe(node);
      schedule();
      return {
        destroy() {
          node.removeEventListener("scroll", onScroll);
          node.removeEventListener("wheel", onWheel);
          ro.disconnect();
          if (raf) cancelAnimationFrame(raf);
          el = null;
        },
      };
    },
  };
}
