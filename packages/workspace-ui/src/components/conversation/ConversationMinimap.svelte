<script lang="ts">
  import { untrack } from "svelte";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import NavigationRail from "../ui/navigation-rail/NavigationRail.svelte";
  import {
    hasRoomForRail,
    indexMinimapNodes,
    pickActiveIndex,
    type NavItem,
  } from "./lib/minimap";

  // Editor-mode message navigator: a rail of dashes (one per user message) in the
  // reading gutter, anchored to the pane edge so sidebar resizing cannot shift
  // the ticks within the gutter. Hover expands it into a preview list; clicking scrolls to the
  // message. Only renders when the gutter is wide enough to clear the text.
  let {
    items,
    scrollEl,
    isActive,
    windowStart,
    prepareNavigate,
    topForMessage,
    geometryRevision = 0,
  }: {
    items: NavItem[];
    scrollEl: HTMLElement | null;
    isActive: boolean;
    windowStart: number;
    prepareNavigate?: (id: string) => Promise<void>;
    topForMessage?: (id: string) => number | undefined;
    geometryRevision?: number;
  } = $props();

  let paneWidth = $state(0);
  let activeIndex = $state(0);

  const settings = getSettingsContext();
  const visible = $derived(
    items.length >= 3 && hasRoomForRail(paneWidth, settings.conversationWidth),
  );

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Missing historical nodes stay absent until the mounted window changes.
  let nodeMap = new Map<string, HTMLElement>();
  let firstMountedIndex = -1;

  function rebuildNodeMap() {
    nodeMap = new Map();
    firstMountedIndex = -1;
    if (!scrollEl) return;
    const index = indexMinimapNodes(scrollEl, items);
    nodeMap = index.nodes;
    firstMountedIndex = index.firstMountedIndex;
  }

  function nodeFor(id: string): HTMLElement | null {
    const node = nodeMap.get(id);
    return node?.isConnected ? node : null;
  }

  function recompute() {
    const el = scrollEl;
    if (!el) return;
    paneWidth = el.clientWidth;
    // At the very bottom the last message is "current" even if its top never
    // crossed the active line (e.g. a short final message) — no rects needed.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom) {
      activeIndex = Math.max(0, items.length - 1);
      return;
    }
    if (topForMessage) {
      let low = 0;
      let high = items.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const top = topForMessage(items[mid].id);
        if (top !== undefined && top <= el.scrollTop + 96) low = mid + 1;
        else high = mid;
      }
      activeIndex = Math.max(0, low - 1);
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    // Transcript windowing leaves older navigation items in the rail while
    // their message nodes are not mounted. They are above the current window,
    // not below its active line. Treating every missing node as +Infinity made
    // the loop stop at item zero, so only the first and last ticks could become
    // active on the web client.
    // Lazy top reads: pickActiveIndex stops at the first message below the active
    // line, so getBoundingClientRect is never called for messages past the fold.
    activeIndex = pickActiveIndex(
      items.length,
      (i) => {
        const node = nodeFor(items[i].id);
        return node
          ? node.getBoundingClientRect().top - containerTop
          : null;
      },
      firstMountedIndex,
    );
  }

  // One layout read per frame, taken in the frame: a read in the DOM update
  // that mounts a transcript forced its layout before the update finished.
  let recomputeFrame = 0;
  function scheduleRecompute() {
    if (recomputeFrame) return;
    recomputeFrame = requestAnimationFrame(() => {
      recomputeFrame = 0;
      untrack(recompute);
    });
  }

  // Observe size + scroll on the container only (stable across streaming ticks).
  // Guard on isActive: a ResizeObserver + scroll listener on a hidden tab's
  // scroll container is wasted work that fires on every layout/scroll event.
  $effect(() => {
    const el = scrollEl;
    if (!el || !isActive) return;
    const ro = new ResizeObserver(scheduleRecompute);
    ro.observe(el);
    el.addEventListener("scroll", scheduleRecompute, { passive: true });
    return () => {
      if (recomputeFrame) cancelAnimationFrame(recomputeFrame);
      recomputeFrame = 0;
      ro.disconnect();
      el.removeEventListener("scroll", scheduleRecompute);
    };
  });

  // Paging can mount older messages without changing the navigation items.
  // Returning to a hidden tab rebuilds its index after any deferred changes.
  $effect(() => {
    if (!isActive || !scrollEl) return;
    void items;
    void windowStart;
    void geometryRevision;
    untrack(() => {
      rebuildNodeMap();
      scheduleRecompute();
    });
  });

  function animateScrollTo(el: HTMLElement, target: number) {
    const clamped = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
    if (reduceMotion) {
      el.scrollTop = clamped;
      return;
    }
    const start = el.scrollTop;
    if (Math.abs(start - clamped) < 1) return;
    const startTime = performance.now();
    const duration = 320;
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      el.scrollTop = start + (clamped - start) * ease(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function goTo(id: string) {
    await prepareNavigate?.(id);
    rebuildNodeMap();
    const el = scrollEl;
    const node = nodeFor(id);
    if (!el || !node) return;
    const target =
      el.scrollTop +
      (node.getBoundingClientRect().top - el.getBoundingClientRect().top) -
      24;
    animateScrollTo(el, target);
    requestInputFocus();
  }
</script>

{#if visible}
  <NavigationRail
    class="left-4 top-[calc(50%-var(--solus-composer-inset,0px)/2)] max-h-[72%]"
    label="Jump to message"
    {items}
    {activeIndex}
    onSelect={goTo}
  />
{/if}
