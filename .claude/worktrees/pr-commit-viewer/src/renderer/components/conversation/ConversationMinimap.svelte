<script lang="ts">
  import { untrack } from "svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    gutterWidth,
    hasRoomForRail,
    pickActiveIndex,
    railRightOffset,
    type NavItem,
  } from "./lib/minimap";

  // Editor-mode message navigator: a rail of dashes (one per user message) in the
  // reading gutter. Hover expands it into a preview list; clicking scrolls to the
  // message. Only renders when the gutter is wide enough to clear the text.
  let {
    items,
    scrollEl,
    isActive,
    prepareNavigate,
  }: {
    items: NavItem[];
    scrollEl: HTMLElement | null;
    isActive: boolean;
    prepareNavigate?: (id: string) => Promise<void>;
  } = $props();

  let paneWidth = $state(0);
  let activeIndex = $state(0);
  let hovered = $state(false);

  const visible = $derived(items.length >= 3 && hasRoomForRail(paneWidth));
  const rightOffset = $derived(railRightOffset(paneWidth));

  const reduceMotion =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // id→element index, built once per items/DOM change with a single querySelectorAll
  // rather than one full-subtree querySelector per user message per scroll frame. A
  // stale (disconnected) node is re-queried lazily and re-cached.
  let nodeMap = new Map<string, HTMLElement>();

  function rebuildNodeMap() {
    nodeMap = new Map();
    if (!scrollEl) return;
    for (const node of scrollEl.querySelectorAll<HTMLElement>("[data-nav-msg-id]")) {
      const id = node.dataset.navMsgId;
      if (id) nodeMap.set(id, node);
    }
  }

  function nodeFor(id: string): HTMLElement | null {
    if (!scrollEl) return null;
    let node = nodeMap.get(id);
    if (!node || !node.isConnected) {
      node =
        scrollEl.querySelector<HTMLElement>(`[data-nav-msg-id="${CSS.escape(id)}"]`) ??
        undefined;
      if (node) nodeMap.set(id, node);
      else nodeMap.delete(id);
    }
    return node ?? null;
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
    const containerTop = el.getBoundingClientRect().top;
    // Lazy top reads: pickActiveIndex stops at the first message below the active
    // line, so getBoundingClientRect is never called for messages past the fold.
    activeIndex = pickActiveIndex(items.length, (i) => {
      const node = nodeFor(items[i].id);
      return node
        ? node.getBoundingClientRect().top - containerTop
        : Number.POSITIVE_INFINITY;
    });
  }

  // Observe size + scroll on the container only (stable across streaming ticks).
  // Guard on isActive: a ResizeObserver + scroll listener on a hidden tab's
  // scroll container is wasted work that fires on every layout/scroll event.
  $effect(() => {
    const el = scrollEl;
    if (!el || !isActive) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        untrack(recompute);
      });
    };
    untrack(recompute);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  });

  // Recompute when the set of user messages changes (new prompt added/removed).
  // The DOM changed too, so rebuild the id→element index in the same pass.
  $effect(() => {
    void items.length;
    untrack(() => {
      rebuildNodeMap();
      recompute();
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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <nav
    class="msg-nav"
    class:expanded={hovered}
    style="right:{rightOffset}px"
    aria-label="Jump to message"
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
  >
    {#each items as it, i (it.id)}
      <button
        type="button"
        class="msg-nav-row"
        class:active={i === activeIndex}
        title={it.preview}
        aria-label={it.preview}
        aria-current={i === activeIndex ? "true" : undefined}
        onclick={() => goTo(it.id)}
      >
        <span class="msg-nav-label">{it.preview}</span>
        <span class="msg-nav-dash" aria-hidden="true"></span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  .msg-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 7px;
    max-height: 72%;
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
  .msg-nav::-webkit-scrollbar {
    display: none;
  }
  .msg-nav.expanded {
    gap: 1px;
    background: var(--solus-container-bg);
    border-color: var(--solus-container-border);
    box-shadow: var(--solus-card-shadow-collapsed);
  }

  .msg-nav-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .msg-nav.expanded .msg-nav-row {
    padding: 7px 11px;
  }

  /* Collapsed: the label contributes zero box (no width AND no height) so the
     ticks stack on the gap value alone instead of on the label's line-height. */
  .msg-nav-label {
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
  .msg-nav.expanded .msg-nav-label {
    max-width: 15rem;
    max-height: 1.5rem;
    opacity: 1;
  }

  /* Collapsed ruler ticks: tight hairline marks like a scrubber. The active tick
     is longer, fully opaque and accent-inked. Hidden once the rail expands. */
  .msg-nav-dash {
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
  .msg-nav-row.active {
    color: var(--solus-text-primary);
  }
  .msg-nav-row.active .msg-nav-dash {
    width: 25px;
    height: 2.5px;
    opacity: 1;
    background: var(--solus-accent);
  }
  .msg-nav.expanded .msg-nav-dash {
    display: none;
  }

  /* Expanded rows read as a menu: hover stays neutral while active keeps the
     accent wash used for the current location. */
  .msg-nav.expanded .msg-nav-row:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .msg-nav.expanded .msg-nav-row.active {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  .msg-nav-row:focus-visible {
    outline: 2px solid var(--solus-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .msg-nav,
    .msg-nav-label,
    .msg-nav-dash {
      transition: none;
    }
  }
</style>
