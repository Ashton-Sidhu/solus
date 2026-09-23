<script lang="ts">
  import type { Snippet } from 'svelte'
  import { X as CloseIcon } from '@lucide/svelte'
  import type { CommentAuthor, PlanComment } from '@solus/contracts/types'
  import type { DocCommentThread } from '@solus/contracts/work-comments'
  import CommentThreadCard from '../comments/CommentThreadCard.svelte'
  import ExternalCommentCard from '../work/ExternalCommentCard.svelte'
  import SettingsSelect from '../settings/SettingsSelect.svelte'
  import type { MeasuredAnchor } from '../comments/lib/anchors'
  import { layoutThreads, type ThreadAnchor } from '../comments/lib/rail-layout'
  import { openThreads, railThreads, resolvedThreads, type RailThread } from '../comments/lib/thread'

  interface Props {
    externalWorkId?: string
    comments: PlanComment[]
    /** Local threads whose highlight is not in this text any more — the quote
     *  was edited away, or never anchored. They have no line, so they belong
     *  to the Page view with the external threads that have none. */
    pageComments?: PlanComment[]
    /** External threads the highlight plugin placed in this text. They share
     *  the margin with the local ones, each on the line it annotates. */
    externalThreads?: DocCommentThread[]
    /** External threads with no line to sit beside: comments on the document as
     *  a whole, detached ones, and quotes this copy no longer holds. They are
     *  a second view of the same rail rather than cards crowding the margin. */
    pageThreads?: DocCommentThread[]
    onAskExternalPrivately?: (thread: DocCommentThread) => void
    onLocateExternalQuote?: (quote: string, threadId: string) => boolean
    activeCommentId?: string | null
    editingCommentId?: string | null
    /** Guidance shown in the empty state; lets each host surface its own shortcut. */
    emptyHint?: string
    /**
     * `anchored` places each card on the line of its highlight, the way the
     * margin of a marked-up page does. `stacked` is for surfaces whose
     * comments have no y in a scroll container — a diagram's node anchors.
     */
    placement?: 'stacked' | 'anchored'
    /** Measured mark geometry. Anchored placement only. */
    anchors?: MeasuredAnchor[]
    /**
     * False while the rail is moving. Cards still follow their anchors, but
     * connectors are suppressed so nothing flickers across the margin.
     */
    settled?: boolean
    onScrollTo: (commentId: string) => void
    onHover: (commentId: string | null) => void
    onStartEdit: (commentId: string) => void
    onSaveEdit: (commentId: string, text: string) => void
    onCancelEdit: () => void
    onDelete: (commentId: string) => void
    onResolve?: (commentId: string, resolved: boolean) => void
    onReply?: (commentId: string, text: string) => void
    /** Optional action bar pinned below the thread list. */
    footer?: Snippet
    /** Set when the rail is a drawer over the text rather than a margin beside
     *  it: the header then carries the way out, because the drawer covers the
     *  control that opened it on a phone-width pane. */
    onClose?: () => void
  }

  let {
    externalWorkId,
    comments,
    pageComments = [],
    externalThreads = [],
    pageThreads = [],
    onAskExternalPrivately,
    onLocateExternalQuote,
    activeCommentId = null,
    editingCommentId = null,
    emptyHint = 'Select text in the plan to add one.',
    placement = 'stacked',
    anchors = [],
    settled = true,
    onScrollTo,
    onHover,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDelete,
    onResolve,
    onReply,
    footer,
    onClose,
  }: Props = $props()

  const anchorById = $derived(new Map(anchors.map((a) => [a.id, a])))

  // Two views of one rail. Inline is the margin: every thread that annotates a
  // passage, local and external alike, on its own line. Page is the list of
  // threads that annotate the document rather than a passage — they have no
  // line, and crowding them into the margin pushes the anchored cards off the
  // end of it. The toggle only appears when there is a second view to show.
  let view = $state<'inline' | 'page'>('inline')
  const inline = $derived(railThreads(comments, externalThreads))
  const page = $derived(railThreads(pageComments, pageThreads))
  // Never show an empty view while the other one holds the threads: a document
  // whose only comments are on the page as a whole opens on them.
  const activeView = $derived(
    view === 'page'
      ? page.length > 0
        ? 'page'
        : 'inline'
      : inline.length > 0 || page.length === 0
        ? 'inline'
        : 'page',
  )
  const threads = $derived(activeView === 'page' ? page : inline)
  const anchored = $derived(placement === 'anchored' && activeView === 'inline')

  const shownLocal = $derived(activeView === 'page' ? pageComments : comments)
  const shownExternal = $derived(activeView === 'page' ? pageThreads : externalThreads)
  const open = $derived(
    openThreads(shownLocal).length + shownExternal.filter((thread) => !thread.resolved).length,
  )
  const resolved = $derived(
    resolvedThreads(shownLocal).length + shownExternal.filter((thread) => thread.resolved).length,
  )

  // One clock for the whole rail rather than a timer per card.
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })

  // Card heights, measured as they render. Layout reads them back, which
  // settles in one extra frame — cheaper and simpler than pre-measuring.
  let heights = $state<Record<string, number>>({})
  let canvasEl: HTMLDivElement | null = $state(null)
  let canvasHeight = $state(0)

  // Anchors arrive in viewport space; the canvas's own box converts them. Read
  // off the same anchors signal so a scroll re-reads it rather than caching a
  // box that the pane may have moved out from under.
  const canvasBox = $derived.by(() => {
    void anchors
    void canvasHeight
    const rect = canvasEl?.getBoundingClientRect()
    return { top: rect?.top ?? 0, left: rect?.left ?? 0 }
  })

  // How far it is from the canvas's left edge to a card's left edge — the whole
  // alley the connector has to cross. Measured off the element that spans it
  // rather than restated as a number, so the CSS stays the one source of truth.
  let connectorWidth = $state(0)

  const layout = $derived.by(() => {
    if (!anchored) return null
    const items = threads
      .map((t) => {
        const anchor = anchorById.get(t.id)
        if (!anchor) return null
        return {
          id: t.id,
          anchorTop: anchor.anchorTop - canvasBox.top,
          height: heights[t.id] ?? 92,
        }
      })
      .filter((item) => item !== null)
    return layoutThreads(items, {
      focusedId: activeCommentId,
      viewport: { top: 0, bottom: canvasHeight },
    })
  })

  /**
   * A curve from the end of the highlighted run to the card's top-left corner.
   * The canvas reaches back over the prose column's own right gutter (see
   * `--rail-alley`) precisely so this can start at the text rather than in mid
   * air — a line that stops short of the run it belongs to connects nothing.
   *
   * It leaves the run horizontally and drops into the corner, so the eye reads
   * "this line, that card" rather than a diagonal across the margin.
   */
  function connectorPath(commentId: string): string {
    const anchor = anchorById.get(commentId)
    const top = layout?.tops.get(commentId)
    if (!anchor || top === undefined || connectorWidth === 0) return ''
    const from = anchor.anchorBottom - canvasBox.top
    const to = top + 15
    // Clamped: a run that ends past the alley (or before the canvas begins)
    // would otherwise send the curve backwards across the text.
    const startX = Math.min(Math.max(anchor.anchorRight - canvasBox.left, 0), connectorWidth - 8)
    const span = connectorWidth - startX
    return `M${startX} ${from}C${startX + span * 0.46} ${from} ${startX + span * 0.54} ${from} ${connectorWidth} ${to}`
  }

  const visibleConnectors = $derived(
    settled && layout ? threads.filter((t) => layout.connectors.has(t.id)) : [],
  )

  function threadProps(comment: PlanComment) {
    return {
      externalWorkId,
      comment,
      focused: activeCommentId === comment.id,
      anchorVisible: placement === 'anchored' ? (anchorById.get(comment.id)?.visible ?? true) : true,
      stickyEdge: activeCommentId === comment.id ? (layout?.stickyEdge ?? null) : null,
      moving: placement === 'anchored' && !settled,
      editing: editingCommentId === comment.id,
      now,
      onFocus: () => onScrollTo(comment.id),
      onResolve: (next: boolean) => onResolve?.(comment.id, next),
      onReply: (text: string) => onReply?.(comment.id, text),
      onStartEdit: () => onStartEdit(comment.id),
      onSaveEdit: (text: string) => onSaveEdit(comment.id, text),
      onCancelEdit,
      onDelete: () => onDelete(comment.id),
    }
  }

  // Bring the active thread into view when it's selected from the document.
  // Stacked only — anchored placement puts the card on its line already, so
  // scrolling the rail would fight the document's own scroll.
  let bodyEl: HTMLDivElement | null = $state(null)
  $effect(() => {
    const id = activeCommentId
    if (placement === 'anchored' || !id || !bodyEl) return
    bodyEl
      .querySelector(`[data-comment-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  })
</script>

{#snippet railCard(thread: RailThread)}
  {#if thread.kind === 'local'}
    <CommentThreadCard {...threadProps(thread.comment)} />
  {:else if externalWorkId}
    <ExternalCommentCard
      workId={externalWorkId}
      thread={thread.thread}
      focused={activeCommentId === thread.id}
      moving={placement === 'anchored' && !settled}
      onFocus={() => onScrollTo(thread.id)}
      onAskPrivately={onAskExternalPrivately ?? (() => {})}
      onLocateQuote={onLocateExternalQuote ?? (() => false)}
    />
  {/if}
{/snippet}

<!-- Threads in the margin, not a panel: the same page as the prose, with no
     frame, fill or shadow of their own. Only the amber thread cards are drawn,
     because amber *is* annotation everywhere in the document. -->
<aside class="plan-comments-rail">
  <div
    class="plan-comments-rail__header no-drag"
    class:plan-comments-rail__header--anchored={placement === 'anchored'}
  >
    <!-- The count is of the view you are in, so the toggle beside it carries no
         numbers of its own — and the count is what yields when the rail is too
         narrow for both, because losing the toggle would strand a whole view. -->
    <span class="plan-comments-rail__count"
      >{open} open{resolved > 0 ? ` · ${resolved} resolved` : ''}</span
    >
    <!-- Only when the document has threads of both kinds: with one kind there
         is nothing to switch between, and the count says what you are reading. -->
    {#if page.length > 0}
      <div class="ml-auto shrink-0">
        <SettingsSelect
          options={[
            { value: 'inline', label: `Inline (${inline.length})` },
            { value: 'page', label: `Page (${page.length})` },
          ]}
          value={activeView}
          onSelect={(next) => (view = next)}
          ariaLabel="Which comments"
          compact
        />
      </div>
    {/if}
    {#if onClose}
      <button
        type="button"
        class="plan-comments-rail__close"
        class:plan-comments-rail__close--alone={page.length === 0}
        onclick={onClose}
        title="Hide comments"
        aria-label="Hide comments"
      >
        <CloseIcon size={14} aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if threads.length === 0}
    <p class="plan-comments-rail__empty">{emptyHint}</p>
  {:else if anchored}
    <!-- Anchored: each card rides its own line, the rail clips what scrolls
         past, and the counts at the edges stand in for the rest. -->
    <div
      class="plan-comments-rail__canvas no-drag"
      class:plan-comments-rail__canvas--settled={settled}
      bind:this={canvasEl}
      bind:clientHeight={canvasHeight}
    >
      {#if layout && layout.above > 0}
        <button
          type="button"
          class="plan-comments-rail__edge plan-comments-rail__edge--top"
          title="Scroll to the nearest thread above"
          onclick={() => layout?.nearestAboveId && onScrollTo(layout.nearestAboveId)}
          onmouseenter={() => onHover(layout?.nearestAboveId ?? null)}
          onmouseleave={() => onHover(null)}
        >
          ↑ {layout.above}
        </button>
      {/if}

      <div
        class="plan-comments-rail__connectors"
        aria-hidden="true"
        bind:clientWidth={connectorWidth}
      >
        <svg>
          {#each visibleConnectors as thread (thread.id)}
            <path d={connectorPath(thread.id)} />
          {/each}
        </svg>
      </div>

      {#each threads as thread (thread.id)}
        <div
          class="plan-comments-rail__slot"
          class:plan-comments-rail__slot--stuck={!!layout?.stickyEdge &&
            activeCommentId === thread.id}
          style:transform="translateY({layout?.tops.get(thread.id) ?? 0}px)"
          style:visibility={layout?.tops.has(thread.id) && !layout.hidden.has(thread.id)
            ? 'visible'
            : 'hidden'}
          bind:clientHeight={heights[thread.id]}
          onmouseenter={() => onHover(thread.id)}
          onmouseleave={() => onHover(null)}
          role="presentation"
        >
          {@render railCard(thread)}
        </div>
      {/each}

      {#if layout && layout.below > 0}
        <button
          type="button"
          class="plan-comments-rail__edge plan-comments-rail__edge--bottom"
          title="Scroll to the nearest thread below"
          onclick={() => layout?.nearestBelowId && onScrollTo(layout.nearestBelowId)}
          onmouseenter={() => onHover(layout?.nearestBelowId ?? null)}
          onmouseleave={() => onHover(null)}
        >
          ↓ {layout.below}
        </button>
      {/if}
    </div>
  {:else}
    <div class="plan-comments-rail__body no-drag" bind:this={bodyEl}>
      {#each threads as thread (thread.id)}
        <div
          data-comment-id={thread.id}
          onmouseenter={() => onHover(thread.id)}
          onmouseleave={() => onHover(null)}
          role="presentation"
        >
          {@render railCard(thread)}
        </div>
      {/each}
    </div>
  {/if}

  {#if footer}
    <div class="plan-comments-rail__footer">
      {@render footer()}
    </div>
  {/if}
</aside>

<style>
  .plan-comments-rail {
    /* The alley: how far it is from the end of a line of prose to the rail's
       own left edge, which is the gap a connector has to cross. Constant at
       every pane width — the editor's `margin-inline: auto` slack takes back
       exactly what the --doc-pad-x ladder in index.css gives up. */
    --rail-alley: 3.5rem;
    /* The rail's own left inset — where a card's left edge sits. */
    --rail-gutter: 1.5625rem;
    /* Width is governed by the host sleeve (container-relative), so the rail
       fills whatever space it's given and scales with the shell, not the
       viewport — keeps proportions sane in a narrow split pane. */
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    /* Aligned with the top of the text column, not with the chrome above it. */
    padding: 0.625rem 0 0.5rem;
    background: transparent;
    /* Visible, not hidden: the canvas below reaches back over the prose
       column's right gutter so a connector can start at the text. The canvas
       does its own vertical clipping. */
    overflow: visible;
  }
  /* Micro label, the same mono voice as the section numerals and the code
     captions — the one piece of chrome the margin is allowed, and the count is
     the whole of it. Hiding the threads is the toolbar's job, where the same
     count already lives; a second control here would be the margin growing a
     second surface. */
  .plan-comments-rail__header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0 0.125rem 0.625rem;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  /* Line the label up over the cards, not over the connector gutter beside
     them — the count belongs to the column of threads it counts. */
  .plan-comments-rail__header--anchored {
    padding-left: var(--rail-gutter);
  }
  /* One line, always. The count truncates before the toggle gives up a pixel:
     a wrapped header pushes the margin's first card down its own line. */
  .plan-comments-rail__count {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The drawer's way out: the same weight as the view toggle beside it, and
     a thumb-sized target on touch, where it is the only way to close. */
  .plan-comments-rail__close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    margin: -0.25rem -0.25rem -0.25rem 0;
    padding: 0;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .plan-comments-rail__close--alone {
    margin-left: auto;
  }
  .plan-comments-rail__close:hover {
    background: color-mix(in srgb, var(--solus-text-tertiary) 12%, transparent);
    color: var(--solus-text-primary);
  }
  .plan-comments-rail__close:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }
  @media (pointer: coarse) {
    .plan-comments-rail__close {
      width: 2.5rem;
      height: 2.5rem;
      margin: -0.75rem -0.5rem -0.75rem 0;
    }
  }
  .plan-comments-rail__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 0.125rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  /* Anchored: a clipped plane the cards are placed on, not a scroller. The
     document's scroll is the only scroll — the rail follows it.

     The plane reaches back across the alley, over the prose column's own right
     gutter, because that is where a connector has to be drawn: the gap between
     the text and the card is the alley *plus* the rail's inset, and a curve
     confined to the inset alone stops well short of the run it belongs to.
     Nothing is painted there, and pointer events pass straight through, so the
     overhang costs the text nothing. */
  .plan-comments-rail__canvas {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    margin-left: calc(-1 * var(--rail-alley));
    padding-left: calc(var(--rail-alley) + var(--rail-gutter));
    pointer-events: none;
  }
  .plan-comments-rail__slot {
    position: absolute;
    top: 0;
    left: calc(var(--rail-alley) + var(--rail-gutter));
    right: 0;
    will-change: transform;
    pointer-events: auto;
  }
  /* Cards track their anchors 1:1 while the text moves — no lag, no easing, no
     parallax. The 120ms only ever animates the collision pass that runs once
     the scroll has stopped, which is the moment a card actually changes line. */
  .plan-comments-rail__canvas--settled .plan-comments-rail__slot {
    transition: transform 120ms var(--ease-premium);
  }
  /* The stuck card floats over the ones still on their lines. */
  .plan-comments-rail__slot--stuck {
    z-index: 2;
  }
  /* The connector: a 1.2px amber curve from the end of the highlighted run to
     the card's top-left corner. It spans the whole alley, so its own width is
     the distance the curve has to cover — which is what the path is measured
     against rather than a number restated in two places. */
  .plan-comments-rail__connectors {
    position: absolute;
    top: 0;
    left: 0;
    width: calc(var(--rail-alley) + var(--rail-gutter));
    height: 100%;
    pointer-events: none;
  }
  .plan-comments-rail__connectors svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .plan-comments-rail__connectors path {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-art-2) 60%, transparent);
    stroke-width: 1.2;
  }
  /* Off-screen threads are one pill per direction, never a stack of stubs and
     never a badge over the text: the margin says how many conversations it is
     holding out of view, and clicking takes you to the nearest of them. */
  .plan-comments-rail__edge {
    position: absolute;
    right: 0;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    height: 1.25rem;
    padding: 0 0.5rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-art-2) 45%, transparent);
    border-radius: 9999px;
    background: color-mix(in srgb, var(--solus-art-2) 12%, var(--solus-container-bg));
    font-size: var(--text-xs);
    color: color-mix(in srgb, var(--solus-text-primary) 84%, var(--solus-text-tertiary));
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    pointer-events: auto;
    transition:
      background var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium);
  }
  .plan-comments-rail__edge:hover {
    background: color-mix(in srgb, var(--solus-art-2) 20%, var(--solus-container-bg));
    border-color: color-mix(in srgb, var(--solus-art-2) 70%, transparent);
  }
  .plan-comments-rail__edge:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }
  .plan-comments-rail__edge--top {
    top: 1rem;
  }
  .plan-comments-rail__edge--bottom {
    bottom: 1rem;
  }
  .plan-comments-rail__footer {
    flex-shrink: 0;
  }
  .plan-comments-rail__empty {
    margin: 0;
    padding: 0.25rem 0.125rem;
    font-size: var(--text-xs);
    line-height: 1.6;
    color: var(--solus-text-tertiary);
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-comments-rail__canvas--settled .plan-comments-rail__slot,
    .plan-comments-rail__edge {
      transition: none !important;
    }
  }
</style>
