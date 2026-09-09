<script lang="ts">
  import { tick, untrack } from "svelte"
  import { Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte"
  import { revealActiveOutlineRow } from "./lib/outline-scroll"
  import { fade } from "svelte/transition";
  import { sectionNumbers, type PlanHeading } from "./headings";
  import { OUTLINE_DWELL_MS, outlineTickRanges, afterDwell, holdsWithoutDwell, isOutlineVisible, type OutlineReason } from "./lib/outline";
  import { OUTLINE_LONG_MIN, outlineRows } from "./lib/outline-filter";

  interface Props {
    headings: PlanHeading[]
    /** Render the labelled list directly in a popover or mobile sheet. */
    standalone?: boolean
    activePos?: number | null
    /** Threads per heading position — the amber count each row carries. */
    threadCounts?: Map<number, number>
    /** Held open by the reader (⌥⌘\), independent of the pointer. */
    pinned?: boolean
    /** Held open while a keyboard jump is in flight. */
    jumping?: boolean
    /** Full at the top; folded to measure bars once the document scrolls. */
    atTop?: boolean
    /** The fit rule: false where 262px + clearance do not fit left of the
     *  measure, and the gutter is bars only however it is reached. */
    canRevealPanel?: boolean
    /** Put the caret in the filter on mount — the reader opened this panel to
     *  search it. Never on a rail that unfolds under the pointer. */
    autoFocusFilter?: boolean
    onScrollTo: (pos: number) => void
  }

  let {
    headings,
    standalone = false,
    activePos = null,
    threadCounts,
    pinned = false,
    jumping = false,
    atTop = true,
    canRevealPanel = true,
    autoFocusFilter = false,
    onScrollTo,
  }: Props = $props()

  const tickRanges = $derived(outlineTickRanges(headings.length))
  const activeIndex = $derived(headings.findIndex((heading) => heading.pos === activePos))
  const numerals = $derived(sectionNumbers(headings))
  const totalThreads = $derived(
    [...(threadCounts?.values() ?? [])].reduce((sum, n) => sum + n, 0),
  )

  // ── Long documents. A hundred sections are searched, not scanned, so past
  // the threshold the panel gains a field and the rows become its matches.
  // That is the only thing length changes: no folding, no second model.
  const isLong = $derived(headings.length >= OUTLINE_LONG_MIN)
  let query = $state("")
  let filterEl = $state<HTMLInputElement>()
  const searching = $derived(isLong && query.trim().length > 0)
  const rows = $derived(outlineRows(headings, isLong ? query : ""))

  /** Enter takes the first match. The rest of them are a Tab away. */
  function onFilterKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && rows[0]) {
      e.preventDefault()
      onScrollTo(rows[0].heading.pos)
    } else if (e.key === "Escape" && query) {
      e.preventDefault()
      e.stopPropagation()
      clearFilter()
    }
  }

  function clearFilter() {
    query = ""
    filterEl?.focus()
  }

  $effect(() => {
    if (!autoFocusFilter || !isLong) return
    void tick().then(() => filterEl?.focus())
  })

  // Reasons the outline is currently showing its labels. A set, because
  // several can hold at once — pinning while hovering must survive the pointer
  // leaving. Starts at the top, where the full contents remain visible.
  let reasons = $state<Set<OutlineReason>>(new Set<OutlineReason>(['top']))
  const open = $derived(standalone || isOutlineVisible(reasons, atTop, canRevealPanel))

  // Where there is no room for the panel, the ticks carry the contents one row
  // at a time: the hovered — or focused — bar names its own section, and
  // nothing else does. `top` is measured against the rail so the label can live
  // outside the ticks' scroller, which would otherwise clip it.
  let railEl = $state<HTMLElement>()
  let itemsEl = $state<HTMLDivElement>()

  $effect(() => {
    void activePos
    void open
    let cancelled = false
    void tick().then(() => {
      if (cancelled) return
      untrack(() => {
        // Do not move the list while the reader is choosing a section.
        if (reasons.has("focus") || reasons.has("hover")) return
        revealActiveOutlineRow(itemsEl)
      })
    })
    return () => { cancelled = true }
  })

  let namedTick = $state<{ text: string; top: number } | null>(null)

  function nameTick(tick: HTMLElement, text: string) {
    if (!railEl) return
    const bounds = tick.getBoundingClientRect()
    namedTick = {
      text,
      top: bounds.top + bounds.height / 2 - railEl.getBoundingClientRect().top,
    }
  }

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

{#snippet tickMarks(index: number)}
  <span class="doc-outline__numeral">{numerals[index] ?? ""}</span>
  <span class="doc-outline__bar"></span>
{/snippet}

{#if headings.length >= 2}
  <!-- The collapsed overview covers the whole document in at most 12 marks.
       The labelled list retains every heading. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav
    bind:this={railEl}
    class="doc-outline"
    class:doc-outline--open={open}
    class:doc-outline--standalone={standalone}
    class:doc-outline--long={isLong}
    aria-label="On this page"
    onpointerover={() => hold('hover', true)}
    onpointerleave={() => hold('hover', false)}
    onfocusin={() => hold('focus', true)}
    onfocusout={() => hold('focus', false)}
  >
    <!-- With no margin for the panel the bars are the contents, so each one
         becomes its own row: hovering names that section and clicking jumps to
         it. One label at a time is a margin note the measure can carry. -->
    {#if !standalone}
    <div
      class="doc-outline__ticks"
      aria-hidden={canRevealPanel ? "true" : undefined}
    >
      {#each tickRanges as range (range.start)}
        {@const active = activeIndex >= range.start && activeIndex < range.end}
        {@const i = active ? activeIndex : range.start}
        {@const h = headings[i]}
        {#if canRevealPanel}
          <span data-active={active} class="doc-outline__tick" class:doc-outline__tick--sub={h.level > 2} class:doc-outline__tick--active={active}>
            {@render tickMarks(i)}
          </span>
        {:else}
          <button
            type="button"
            class="doc-outline__tick doc-outline__tick--pickable"
            class:doc-outline__tick--sub={h.level > 2}
            class:doc-outline__tick--active={active}
            onclick={() => onScrollTo(h.pos)}
            onpointerenter={(e) => nameTick(e.currentTarget, h.text)}
            onpointerleave={() => (namedTick = null)}
            onfocus={(e) => nameTick(e.currentTarget, h.text)}
            onblur={() => (namedTick = null)}
            aria-label={h.text}
            data-active={active}
            aria-current={active ? "location" : undefined}
          >
            {@render tickMarks(i)}
          </button>
        {/if}
      {/each}
    </div>

    {/if}

    <!-- The label is anchored to the rail rather than to the tick, because the
         ticks column scrolls and a scroller clips both axes. -->
    {#if namedTick && !canRevealPanel}
      <span
        class="doc-outline__tick-label text-workspace-chrome"
        style="top:{namedTick.top}px"
        aria-hidden="true"
        transition:fade={{ duration: 120 }}
      >{namedTick.text}</span>
    {/if}

    <!-- `--outline-rows` divides the cascade across however many sections this
         document has, so the dissolve lands in its 160ms whether there are
         three headings or thirty. -->
    <div class="doc-outline__panel" style="--outline-rows:{rows.length}">
      <div class="doc-outline__head" style="--row:0">
        <span class="doc-outline__label">Contents</span>
        <span class="doc-outline__totals">
          {#if searching}
            {rows.length} of {headings.length}
          {:else}
            {headings.length}{totalThreads > 0 ? ` · ${totalThreads} thread${totalThreads === 1 ? "" : "s"}` : ""}
          {/if}
        </span>
      </div>

      <!-- Past sixteen headings, scanning stops being the fast way in. -->
      {#if isLong}
        <div class="doc-outline__filter" style="--row:0">
          <MagnifyingGlassIcon size={12} class="shrink-0 opacity-60" />
          <input
            bind:this={filterEl}
            bind:value={query}
            onkeydown={onFilterKeydown}
            class="doc-outline__filter-input text-workspace-chrome"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Filter sections"
            aria-label="Filter sections"
          />
          {#if query}
            <button
              type="button"
              class="doc-outline__filter-clear"
              onclick={clearFilter}
              aria-label="Clear filter"
            ><XIcon size={11} /></button>
          {/if}
        </div>
      {/if}

      <div bind:this={itemsEl} class="doc-outline__items no-scrollbar">
      {#each rows as row, i (row.heading.pos)}
        {@const h = row.heading}
        <button
          type="button"
          onclick={() => onScrollTo(h.pos)}
          style="--row:{i}"
          class="doc-outline__item text-workspace-chrome"
          class:doc-outline__item--sub={h.level > 2}
          class:doc-outline__item--section={row.isSection}
          class:doc-outline__item--active={activePos === h.pos}
          data-active={activePos === h.pos}
          aria-current={activePos === h.pos ? "location" : undefined}
        >
          <span class="doc-outline__mark" aria-hidden="true"></span>
          <span class="doc-outline__index" aria-hidden="true">{numerals[row.index] ?? ""}</span>
          <span class="doc-outline__text">{h.text}</span>
          {#if threadCounts?.get(h.pos)}
            <span class="doc-outline__count">{threadCounts.get(h.pos)}</span>
          {/if}
        </button>
      {/each}
      {#if rows.length === 0}
        <p class="doc-outline__empty text-workspace-chrome">No section matches</p>
      {/if}
      </div>
      <div class="doc-outline__foot" style="--row:{Math.max(rows.length - 1, 0)}">
        {#if searching}
          <span class="doc-outline__foot-key">↵</span>
          <span>jump to first match</span>
        {:else}
          <span class="doc-outline__foot-key">⌥1</span>
          <span>jump to section</span>
        {/if}
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
    max-height: 24rem;
    min-height: 0;
    pointer-events: none;
  }
  /* A hundred sections take every row the reading viewport can spare. The
     sleeve is already the height of that viewport, so the cap simply comes
     off: the contents becomes a full-height column beside the prose instead of
     a 24rem window onto a list twenty times longer. */
  .doc-outline--long {
    max-height: 100%;
  }
  .doc-outline__ticks,
  .doc-outline__panel {
    pointer-events: auto;
  }
  /* The overview never scrolls. More headings share the same finite marks. */
  .doc-outline__ticks {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
    overflow: visible;
  }
  .doc-outline__tick {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    height: 0.75rem;
    padding: 0;
    background: transparent;
    border: 0;
  }
  .doc-outline__tick--pickable {
    cursor: pointer;
  }
  /* The one-label contents. It hangs off the rail's right edge rather than
     widening it, so naming a section costs the prose no layout — and only the
     row under the pointer is ever named. */
  .doc-outline__tick-label {
    position: absolute;
    left: calc(100% + 0.5rem);
    transform: translateY(-50%);
    z-index: 25;
    max-width: 13rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.4375rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--solus-text-primary);
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-popover-border);
    box-shadow: 0 0.25rem 0.75rem rgba(60, 45, 30, 0.1);
    pointer-events: none;
  }
  :global(.dark) .doc-outline__tick-label {
    box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.35);
  }
  /* The numeral is transparent at rest; the hovered row earns its own. `:not`
     keeps the section you are in accented — `:hover` would otherwise outrank
     the active rule below on specificity alone. */
  .doc-outline__tick--pickable:not(.doc-outline__tick--active):hover .doc-outline__numeral,
  .doc-outline__tick--pickable:not(.doc-outline__tick--active):focus-visible .doc-outline__numeral {
    color: var(--solus-text-tertiary);
  }
  .doc-outline__tick--pickable:not(.doc-outline__tick--active):hover .doc-outline__bar {
    background: color-mix(in srgb, var(--solus-text-tertiary) 60%, transparent);
  }
  .doc-outline__tick--pickable:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.1875rem;
    border-radius: 0.25rem;
  }
  /* Transparent rather than absent: the numeral holds its column so the bars
     stay on one right edge whether or not a section is active. */
  .doc-outline__numeral {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);
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
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
  /* `.no-scrollbar` in markup, never `scrollbar-width` here: in Chromium any
     non-`auto` value opts the element out of ::-webkit-scrollbar and it falls
     back to the chunky native bar (index.css). The contents is a margin note —
     a rule drawn down the side of it is one element too many. */
  .doc-outline__items {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }
  .doc-outline--standalone {
    height: min(24rem, 55dvh);
  }
  /* Stays inside the mobile sheet's own 70% cap, so the sheet never grows a
     second scroller around the one the list already has. */
  .doc-outline--standalone.doc-outline--long {
    height: min(44rem, 66dvh);
  }
  .doc-outline--standalone .doc-outline__panel {
    position: relative;
    top: 0;
    width: 100%;
    opacity: 1;
    visibility: visible;
  }
  .doc-outline.doc-outline--standalone .doc-outline__head,
  .doc-outline.doc-outline--standalone .doc-outline__filter,
  .doc-outline.doc-outline--standalone .doc-outline__item,
  .doc-outline.doc-outline--standalone .doc-outline__foot {
    width: 100%;
  }
  .doc-outline--open:not(.doc-outline--standalone) .doc-outline__panel {
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
  .doc-outline__filter,
  .doc-outline__item,
  .doc-outline__foot {
    flex: 0 0 auto;
    width: calc(var(--outline-panel-w) - 1.875rem);
    opacity: 0;
    transition: opacity 120ms var(--ease-premium)
      calc((var(--outline-rows) - 1 - var(--row)) * var(--outline-step));
  }
  .doc-outline--open .doc-outline__head,
  .doc-outline--open .doc-outline__filter,
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
    font-size: var(--text-xs);
    font-weight: 500;
    text-transform: uppercase;

    color: var(--solus-text-tertiary);
  }
  .doc-outline__totals {
    margin-left: auto;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);
    color: color-mix(in srgb, var(--solus-text-tertiary) 75%, transparent);
    font-variant-numeric: tabular-nums;
  }
  /* Flat rows: the only mark on an active one is a 2px leading rule — no
     filled background, so the panel still reads as a margin note. The rule is
     an element rather than a border so it can be shorter than the row, which
     keeps a run of sub-items from reading as one continuous line. */
  .doc-outline__item {
    display: flex;
    align-items: flex-start;
    gap: 0.5625rem;
    text-align: left;
    line-height: 1.45;
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
  /* Structure without an interaction to learn: the section you are inside
     stays at the top of the list while its own sub-headings scroll under it,
     so a long list always says which part of the document it is showing. The
     panel's own canvas is the mask — invisible until something scrolls behind
     it. A set of filter matches is flat, so nothing pins there. */
  .doc-outline__item--section {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--solus-container-bg);
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
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
  }
  /* Thread count: amber, because amber is annotation everywhere in the page. */
  .doc-outline__count {
    flex: 0 0 auto;
    min-width: 1rem;
    padding: 0.0625rem 0;
    border-radius: 9999px;
    text-align: center;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, var(--solus-art-2) 26%, transparent);
    color: color-mix(in srgb, var(--solus-text-primary) 85%, var(--solus-art-2));
  }
  .doc-outline__item--sub {
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
    font-weight: 500;
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
  /* A name clipped to "2.3 The existing queue and.." is only half a table of
     contents, and a tooltip that answers it lands on the rows around it. Two
     lines instead: long titles simply read, and nothing has to be hovered. */
  .doc-outline__text {
    min-width: 0;
    flex: 1 1 auto;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .doc-outline__empty {
    padding: 0.5rem 0.375rem;
    color: var(--solus-text-tertiary);
  }
  /* The filter. A hundred sections are searched, not scanned. */
  .doc-outline__filter {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.4375rem;
    padding: 0.25rem 0.375rem 0.25rem 0.5rem;
    border-radius: 0.4375rem;
    color: var(--solus-text-tertiary);
    background: var(--solus-surface-hover);
    border: 0.0625rem solid transparent;
    transition: border-color var(--duration-quick) var(--ease-premium);
  }
  .doc-outline__filter:focus-within {
    border-color: var(--solus-accent-border);
  }
  .doc-outline__filter-input {
    min-width: 0;
    flex: 1 1 auto;
    border: 0;
    background: transparent;
    color: var(--solus-text-primary);
    outline: none;
  }
  .doc-outline__filter-input::placeholder {
    color: color-mix(in srgb, var(--solus-text-tertiary) 80%, transparent);
  }
  .doc-outline__filter-clear {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .doc-outline__filter-clear:hover {
    color: var(--solus-text-primary);
  }
  .doc-outline__foot {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    margin-top: 0.625rem;
    padding-top: 0.625rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);

    color: var(--solus-text-tertiary);
  }
  .doc-outline__foot-key {
    color: var(--solus-accent);
  }

  /* The runtime classifies the physical display once for every client. Keep the
     expanded outline compact on laptops without making a narrow pane depend on
     viewport width; the shell's container query still owns when the rail hides. */
  :global(html.is-laptop-display) .doc-outline__panel {
    --outline-panel-w: 14.5rem;
    padding: 0.75rem 0.75rem 0.75rem 0.875rem;
  }
  :global(html.is-laptop-display) .doc-outline__head,
  :global(html.is-laptop-display) .doc-outline__filter,
  :global(html.is-laptop-display) .doc-outline__item,
  :global(html.is-laptop-display) .doc-outline__foot {
    width: calc(var(--outline-panel-w) - 1.625rem);
  }
  :global(html.is-laptop-display) .doc-outline__head {
    gap: 0.375rem;
    margin-bottom: 0.5rem;
    padding-left: 0.5625rem;
  }
  :global(html.is-laptop-display) .doc-outline__item {
    gap: 0.4375rem;
    padding-block: 0.25rem;
  }
  :global(html.is-laptop-display) .doc-outline__item--sub {
    padding-left: 0.625rem;
  }
  :global(html.is-laptop-display) .doc-outline__foot {
    gap: 0.375rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-outline__head,
    .doc-outline__filter,
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
