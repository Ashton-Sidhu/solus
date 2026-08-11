<script lang="ts">
  import { untrack } from "svelte"
  import { sectionNumbers, type PlanHeading } from "./headings";
  import { OUTLINE_DWELL_MS, afterDwell, holdsWithoutDwell, isOutlineVisible, type OutlineReason } from "./lib/outline";

  interface Props {
    headings: PlanHeading[]
    activePos?: number | null
    /** Threads per heading position — the amber count each row carries. */
    threadCounts?: Map<number, number>
    /** Held open by the reader (⌥⌘\), independent of the pointer. */
    pinned?: boolean
    /** Held open while a keyboard jump is in flight. */
    jumping?: boolean
    /** Full at the top; folded to measure bars once the document scrolls. */
    atTop?: boolean
    onScrollTo: (pos: number) => void
  }

  let {
    headings,
    activePos = null,
    threadCounts,
    pinned = false,
    jumping = false,
    atTop = true,
    onScrollTo,
  }: Props = $props()

  const numerals = $derived(sectionNumbers(headings))
  const totalThreads = $derived(
    [...(threadCounts?.values() ?? [])].reduce((sum, n) => sum + n, 0),
  )

  // Reasons the outline is currently showing its labels. A set, because
  // several can hold at once — pinning while hovering must survive the pointer
  // leaving. Starts at the top, where the full contents remain visible.
  let reasons = $state<Set<OutlineReason>>(new Set<OutlineReason>(['top']))
  const open = $derived(isOutlineVisible(reasons, atTop))

  function hold(reason: OutlineReason, held: boolean) {
    if (reasons.has(reason) === held) return
    const next = new Set(reasons)
    if (held) next.add(reason)
    else next.delete(reason)
    reasons = next
  }

  $effect(() => {
    const held = pinned
    untrack(() => hold('pinned', held))
  })
  $effect(() => {
    const held = jumping
    untrack(() => hold('jump', held))
  })
  $effect(() => {
    const held = atTop
    untrack(() => hold('top', held))
  })

  // The dwell. Two seconds after the last transient reason goes, the labels
  // dissolve — unless something sticky (a pin, keyboard focus) still holds.
  $effect(() => {
    if (!open || holdsWithoutDwell(reasons) || reasons.has('hover')) return
    const timer = setTimeout(() => (reasons = afterDwell(reasons)), OUTLINE_DWELL_MS)
    return () => clearTimeout(timer)
  })
</script>

{#if headings.length >= 2}
  <!-- At rest the outline is a margin rule, not a panel: one tick per heading,
       and the only numeral showing is the section you are in. It renders in
       full while the document is at the top and while the pointer is in it.
       Row height and bar never move, so nothing reflows. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav
    class="doc-outline"
    class:doc-outline--open={open}
    aria-label="On this page"
    onpointerenter={() => hold('hover', true)}
    onpointerleave={() => hold('hover', false)}
    onfocusin={() => hold('focus', true)}
    onfocusout={() => hold('focus', false)}
  >
    <div class="doc-outline__ticks" aria-hidden="true">
      {#each headings as h, i (h.pos)}
        <span class="doc-outline__tick" class:doc-outline__tick--sub={h.level > 2} class:doc-outline__tick--active={activePos === h.pos}>
          <span class="doc-outline__numeral">{numerals[i] ?? ""}</span>
          <span class="doc-outline__bar"></span>
        </span>
      {/each}
    </div>

    <!-- `--outline-rows` divides the cascade across however many sections this
         document has, so the dissolve lands in its 160ms whether there are
         three headings or thirty. -->
    <div class="doc-outline__panel" style="--outline-rows:{headings.length}">
      <div class="doc-outline__head" style="--row:0">
        <span class="doc-outline__label">Contents</span>
        <span class="doc-outline__totals">
          {headings.length}{totalThreads > 0 ? ` · ${totalThreads} thread${totalThreads === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {#each headings as h, i (h.pos)}
        <button
          type="button"
          onclick={() => onScrollTo(h.pos)}
          style="--row:{i}"
          class="doc-outline__item"
          class:doc-outline__item--sub={h.level > 2}
          class:doc-outline__item--active={activePos === h.pos}
          title={h.text}
        >
          <span class="doc-outline__mark" aria-hidden="true"></span>
          <span class="doc-outline__index" aria-hidden="true">{numerals[i] ?? ""}</span>
          <span class="doc-outline__text">{h.text}</span>
          {#if threadCounts?.get(h.pos)}
            <span class="doc-outline__count">{threadCounts.get(h.pos)}</span>
          {/if}
        </button>
      {/each}
      <div class="doc-outline__foot" style="--row:{headings.length - 1}">
        <span class="doc-outline__foot-key">⌥1</span>
        <span>jump to section</span>
      </div>
    </div>
  </nav>
{/if}

<style>
  .doc-outline {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  /* Ticks are flush right, so the rail reads as the inside edge of the margin
     rather than a column of its own. The ticks scroll, not the rail, so the
     unfolded panel below is never clipped by an overflow ancestor. */
  .doc-outline__ticks {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.625rem;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .doc-outline__ticks::-webkit-scrollbar {
    display: none;
  }
  .doc-outline__tick {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
  }
  /* Transparent rather than absent: the numeral holds its column so the bars
     stay on one right edge whether or not a section is active. */
  .doc-outline__numeral {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.625rem;
    line-height: 1;
    color: transparent;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .doc-outline__bar {
    width: 1.25rem;
    height: 0.125rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--solus-text-tertiary) 32%, transparent);
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .doc-outline__tick--sub .doc-outline__bar {
    width: 0.75rem;
    background: color-mix(in srgb, var(--solus-text-tertiary) 20%, transparent);
  }
  .doc-outline__tick--active .doc-outline__numeral {
    color: var(--solus-accent);
  }
  .doc-outline__tick--active .doc-outline__bar,
  .doc-outline__tick--active.doc-outline__tick--sub .doc-outline__bar {
    background: var(--solus-accent);
  }

  /* The labelled outline. Anchored to the rail's own left edge and lifted out
     of flow, so unfolding it costs the text column nothing — expanding is a
     fade and a widen, never a re-layout of the page.

     Collapsing runs the other way and in two beats, 160ms end to end: each
     label dissolves over 120ms, cascading bottom-up so the section you are in
     is the last thing to go, and only once they are gone does the card follow.
     Row height and the bars never move, so nothing reflows either way. */
  .doc-outline__panel {
    --outline-panel-w: 16.375rem;
    /* The width of the gutter the rail rests in — where the widen starts. */
    --outline-rail-w: 5.5rem;
    /* The cascade is 40ms wide however many sections there are: 120ms of label
       fade + 40ms of stagger is the 160ms the design budgets for the collapse. */
    --outline-step: calc(40ms / max(var(--outline-rows) - 1, 1));
    position: absolute;
    top: -0.625rem;
    left: 0;
    z-index: 20;
    width: var(--outline-rail-w);
    max-height: calc(100% - 1.25rem);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 0.9375rem 0.875rem 0.875rem 1rem;
    border-radius: 1rem;
    /* This panel deliberately unfolds over the document. Use the shell's solid
       canvas rather than the slightly translucent popover token so text and
       table rules underneath can never show through it. */
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-popover-border);
    box-shadow:
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.55),
      0 0.0625rem 0.125rem rgba(0, 0, 0, 0.04),
      0 0.5rem 1.25rem rgba(60, 45, 30, 0.09);
    opacity: 0;
    visibility: hidden;
    transition:
      width 160ms var(--ease-premium),
      opacity 120ms var(--ease-premium) 40ms,
      visibility 0s linear 160ms;
  }
  .doc-outline--open .doc-outline__panel {
    width: var(--outline-panel-w);
    opacity: 1;
    visibility: visible;
    transition:
      width 160ms var(--ease-premium),
      opacity 120ms var(--ease-premium),
      visibility 0s linear 0s;
  }
  :global(.dark) .doc-outline__panel {
    box-shadow:
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.07),
      0 0.125rem 0.25rem rgba(0, 0, 0, 0.25),
      0 0.625rem 1.5rem rgba(0, 0, 0, 0.3);
  }
  /* Every row is laid out at the panel's full width even while it is narrow,
     so the widen reveals the labels rather than re-wrapping and re-ellipsing
     them on every frame of it. */
  .doc-outline__head,
  .doc-outline__item,
  .doc-outline__foot {
    flex: 0 0 auto;
    width: calc(var(--outline-panel-w) - 1.875rem);
    opacity: 0;
    transition: opacity 120ms var(--ease-premium)
      calc((var(--outline-rows) - 1 - var(--row)) * var(--outline-step));
  }
  .doc-outline--open .doc-outline__head,
  .doc-outline--open .doc-outline__foot {
    opacity: 1;
    transition-delay: calc(var(--row) * var(--outline-step));
  }
  .doc-outline__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.6875rem;
    padding-left: 0.6875rem;
  }
  /* Micro label — mono, the same face the section numerals hang in, so the
     rail reads as part of the document's own furniture. */
  .doc-outline__label {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.59375rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--solus-text-tertiary);
  }
  .doc-outline__totals {
    margin-left: auto;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.59375rem;
    color: color-mix(in srgb, var(--solus-text-tertiary) 75%, transparent);
    font-variant-numeric: tabular-nums;
  }
  /* Flat rows: the only mark on an active one is a 2px leading rule — no
     filled background, so the panel still reads as a margin note. The rule is
     an element rather than a border so it can be shorter than the row, which
     keeps a run of sub-items from reading as one continuous line. */
  .doc-outline__item {
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    text-align: left;
    font-size: 0.8125rem;
    line-height: 1.45;
    letter-spacing: -0.005em;
    padding: 0.3125rem 0.375rem 0.3125rem 0;
    color: var(--solus-text-tertiary);
    background: transparent;
    cursor: pointer;
    overflow: hidden;
    transition:
      color var(--duration-quick) var(--ease-premium),
      opacity 120ms var(--ease-premium)
        calc((var(--outline-rows) - 1 - var(--row)) * var(--outline-step));
  }
  .doc-outline--open .doc-outline__item {
    opacity: 1;
    transition-delay: 0s, calc(var(--row) * var(--outline-step));
  }
  .doc-outline__mark {
    flex: 0 0 auto;
    width: 0.125rem;
    height: 0.9375rem;
    border-radius: 9999px;
    background: transparent;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .doc-outline__index {
    flex: 0 0 auto;
    min-width: 1rem;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
  }
  /* Thread count: amber, because amber is annotation everywhere in the page. */
  .doc-outline__count {
    flex: 0 0 auto;
    min-width: 1rem;
    padding: 0.0625rem 0;
    border-radius: 9999px;
    text-align: center;
    font-size: 0.65625rem;
    font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, var(--solus-art-2) 26%, transparent);
    color: color-mix(in srgb, var(--solus-text-primary) 85%, var(--solus-art-2));
  }
  .doc-outline__item--sub {
    font-size: 0.78125rem;
    padding-left: 0.8125rem;
    color: color-mix(in srgb, var(--solus-text-tertiary) 85%, transparent);
  }
  .doc-outline__item--sub .doc-outline__mark {
    height: 0.75rem;
  }
  .doc-outline__item:hover {
    color: var(--solus-text-primary);
  }
  .doc-outline__item--active {
    color: var(--solus-accent);
    font-weight: 550;
  }
  .doc-outline__item--active .doc-outline__mark,
  .doc-outline__item--active .doc-outline__index {
    background: transparent;
    color: var(--solus-accent);
  }
  .doc-outline__item--active .doc-outline__mark {
    background: var(--solus-accent);
  }
  .doc-outline__item:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
    border-radius: 0.25rem;
  }
  .doc-outline__text {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .doc-outline__foot {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    margin-top: 0.625rem;
    padding-top: 0.625rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.59375rem;
    letter-spacing: 0.04em;
    color: var(--solus-text-tertiary);
  }
  .doc-outline__foot-key {
    color: var(--solus-accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-outline__head,
    .doc-outline__item,
    .doc-outline__foot,
    .doc-outline__mark,
    .doc-outline__panel,
    .doc-outline__numeral,
    .doc-outline__bar {
      transition: none !important;
    }
  }
</style>
