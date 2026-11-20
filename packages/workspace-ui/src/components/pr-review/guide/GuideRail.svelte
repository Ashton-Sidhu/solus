<script lang="ts">
  import { untrack } from "svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import NavigationRail from "../../ui/navigation-rail/NavigationRail.svelte";

  let {
    items,
    scrollEl,
  }: {
    items: { id: string; label: string }[];
    scrollEl: HTMLElement | null;
  } = $props();

  // Distance (px) from the scroll top marking the "current" section: the last
  // section whose top has crossed this line is active.
  const ACTIVE_LINE = 120;

  let activeIndex = $state(0);
  let sectionTops: number[] = [];

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function nodeFor(id: string): HTMLElement | null {
    return scrollEl?.querySelector(`[data-guide-section-id="${CSS.escape(id)}"]`) ?? null;
  }

  function rebuildSectionTops() {
    const el = scrollEl;
    if (!el) {
      sectionTops = [];
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    sectionTops = items.map((item) => {
      const node = nodeFor(item.id);
      return node ? el.scrollTop + node.getBoundingClientRect().top - containerTop : Infinity;
    });
    recompute();
  }

  function recompute() {
    const el = scrollEl;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom) {
      activeIndex = Math.max(0, items.length - 1);
      return;
    }
    const marker = el.scrollTop + ACTIVE_LINE;
    let lo = 0;
    let hi = sectionTops.length - 1;
    let active = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sectionTops[mid] <= marker) {
        active = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    activeIndex = active;
  }

  // Observe scroll + size on the container; scroll only compares cached offsets,
  // while layout reads are reserved for resize/content-height changes.
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    let scrollRaf = 0;
    let rebuildRaf = 0;
    const schedule = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        untrack(recompute);
      });
    };
    const scheduleRebuild = () => {
      if (rebuildRaf) return;
      rebuildRaf = requestAnimationFrame(() => {
        rebuildRaf = 0;
        untrack(rebuildSectionTops);
      });
    };
    untrack(rebuildSectionTops);
    const ro = new ResizeObserver(scheduleRebuild);
    ro.observe(el);
    const sectionResizeObserver = new ResizeObserver(scheduleRebuild);
    for (const item of items) {
      const node = nodeFor(item.id);
      if (node) sectionResizeObserver.observe(node);
    }
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (rebuildRaf) cancelAnimationFrame(rebuildRaf);
      ro.disconnect();
      sectionResizeObserver.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  });

  // Recompute when the set of sections changes.
  $effect(() => {
    void items.length;
    untrack(rebuildSectionTops);
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
    const duration = 340;
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      el.scrollTop = start + (clamped - start) * ease(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function goTo(id: string) {
    const el = scrollEl;
    const node = nodeFor(id);
    if (!el || !node) return;
    const target =
      el.scrollTop + (node.getBoundingClientRect().top - el.getBoundingClientRect().top) - 32;
    animateScrollTo(el, target);
    requestInputFocus();
  }
</script>

{#if items.length >= 3}
  <NavigationRail
    class="top-1/2 left-2 max-h-[78%]"
    label="Jump to section"
    {items}
    {activeIndex}
    onSelect={goTo}
  />
{/if}
