<script lang="ts">
  import { untrack } from "svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";

  // Guide section navigator: a rail of dashes (one per main section) pinned to the
  // left edge of the guide. Hover expands it into a labelled list; clicking
  // scrolls to that section. Mirrors the conversation minimap, but lives at the
  // edge-to-edge guide's left margin rather than a centered reading gutter.
  let {
    items,
    scrollEl,
  }: {
    items: { id: string; title: string }[];
    scrollEl: HTMLElement | null;
  } = $props();

  // Distance (px) from the scroll top marking the "current" section: the last
  // section whose top has crossed this line is active.
  const ACTIVE_LINE = 120;

  let activeIndex = $state(0);
  let hovered = $state(false);
  let sectionTops: number[] = [];

  const reduceMotion =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <nav
    class="guide-nav"
    class:expanded={hovered}
    aria-label="Jump to section"
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
  >
    {#each items as it, i (it.id)}
      <!-- Nav ticks, fully styled below: no button primitive, whose fixed height
           would stretch the collapsed rail's 2px dashes into 32px rows. -->
      <button
        type="button"
        class="guide-nav-row {i === activeIndex ? 'active' : ''}"
        title={it.title}
        aria-label={it.title}
        aria-current={i === activeIndex ? "true" : undefined}
        onclick={() => goTo(it.id)}
      >
        <span class="guide-nav-label">{it.title}</span>
        <span class="guide-nav-dash" aria-hidden="true"></span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  /* Pinned to the guide's left margin, vertically centered, overlaying the
     scroll content. Anchored to the right so the rail grows leftward as it
     expands without shifting its ticks. */
  .guide-nav {
    position: absolute;
    top: 50%;
    left: 8px;
    transform: translateY(-50%);
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    max-height: 78%;
    padding: 6px;
    border-radius: 14px;
    border: 1px solid transparent;
    background: transparent;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    transition:
      background-color 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.16s ease,
      gap 0.16s ease;
  }
  .guide-nav::-webkit-scrollbar {
    display: none;
  }
  .guide-nav.expanded {
    gap: 1px;
    background: var(--solus-container-bg);
    border-color: var(--solus-container-border);
    box-shadow: var(--solus-card-shadow-collapsed);
  }

  :global(.guide-nav-row) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .guide-nav.expanded :global(.guide-nav-row) {
    padding: 7px 11px;
  }

  /* Collapsed: the label collapses to a zero box so the ticks stack on the gap
     value alone. */
  .guide-nav-label {
    max-width: 0;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.8125rem;
    line-height: 1.25;
    text-align: left;
    transition:
      max-width 0.18s ease,
      max-height 0.18s ease,
      opacity 0.14s ease;
  }
  .guide-nav.expanded .guide-nav-label {
    max-width: 15rem;
    max-height: 1.5rem;
    opacity: 1;
  }

  /* Collapsed ruler ticks. The active tick is longer, opaque and accent-inked. */
  .guide-nav-dash {
    display: block;
    width: 17px;
    height: 2px;
    flex-shrink: 0;
    border-radius: 2px;
    background: currentColor;
    opacity: 0.5;
    transition:
      width 0.16s ease,
      height 0.16s ease,
      opacity 0.16s ease,
      background-color 0.16s ease;
  }
  :global(.guide-nav-row.active) {
    color: var(--solus-text-primary);
  }
  :global(.guide-nav-row.active) .guide-nav-dash {
    width: 25px;
    height: 2.5px;
    opacity: 1;
    background: var(--solus-accent);
  }
  .guide-nav.expanded .guide-nav-dash {
    display: none;
  }

  .guide-nav.expanded :global(.guide-nav-row:hover) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .guide-nav.expanded :global(.guide-nav-row.active) {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  :global(.guide-nav-row:focus-visible) {
    outline: 2px solid var(--solus-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .guide-nav,
    .guide-nav-label,
    .guide-nav-dash {
      transition: none;
    }
  }
</style>
