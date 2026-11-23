<script lang="ts">
  import { untrack } from "svelte";
  import { guideVisibleTop, guideScrollTop, scrollGuideTo } from "./lib/guide-scroll";
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
  let visibleTop = 0;
  let jump: { id: string; destination: number } | null = null;

  function cancelJump() {
    jump = null;
  }

  function destination(el: HTMLElement, node: HTMLElement) {
    return Math.max(0, Math.min(guideScrollTop(el, node, 32), el.scrollHeight - el.clientHeight));
  }

  function nodeFor(id: string): HTMLElement | null {
    return scrollEl?.querySelector(`[data-guide-section-id="${CSS.escape(id)}"]`) ?? null;
  }

  function rebuildSectionTops() {
    const el = scrollEl;
    if (!el) {
      sectionTops = [];
      return;
    }
    visibleTop = guideVisibleTop(el);
    const containerTop = el.getBoundingClientRect().top;
    sectionTops = items.map((item) => {
      const node = nodeFor(item.id);
      return node ? el.scrollTop + node.getBoundingClientRect().top - containerTop : Infinity;
    });
    // Diffs above the selected section replace their placeholders as they enter
    // view. A smooth scroll keeps its original pixel destination through reflow.
    if (jump) {
      const node = nodeFor(jump.id);
      if (node) {
        const top = destination(el, node);
        if (Math.abs(top - jump.destination) > 1) {
          jump.destination = top;
          el.scrollTo({ top, behavior: "instant" });
        }
      } else cancelJump();
    }
    recompute();
  }

  function recompute() {
    const el = scrollEl;
    if (!el) return;
    const atBottom = el.clientHeight > 0 && el.scrollHeight > el.clientHeight && el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom) {
      activeIndex = Math.max(0, items.length - 1);
      return;
    }
    const marker = el.scrollTop + visibleTop + ACTIVE_LINE;
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
    // The overview can wrap or finish rendering after the section sizes settle.
    const overview = el.querySelector(".guide-intro");
    if (overview) ro.observe(overview);
    const sectionResizeObserver = new ResizeObserver(scheduleRebuild);
    for (const item of items) {
      const node = nodeFor(item.id);
      if (node) sectionResizeObserver.observe(node);
    }
    el.addEventListener("scroll", schedule, { passive: true });
    const transcript = el.closest("[data-conversation-tab-id]");
    const controller = new AbortController();
    const options = { signal: controller.signal, passive: true };
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      el.addEventListener(event, cancelJump, options);
    }
    transcript?.addEventListener("scroll", () => {
      cancelJump();
      visibleTop = guideVisibleTop(el);
      schedule();
    }, options);
    return () => {
      controller.abort();
      cancelJump();
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

  function goTo(id: string) {
    const el = scrollEl;
    const node = nodeFor(id);
    if (!el || !node) return;
    jump = { id, destination: destination(el, node) };
    scrollGuideTo(el, node, 32);
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
