<script lang="ts">
  import { useViewport } from '@xyflow/svelte'
  import { fade } from 'svelte/transition'
  import type { PlanComment } from '../../../shared/types'
  import CommentThreadCard from '../comments/CommentThreadCard.svelte'
  import { anchorToPane, placeThreadCard, type AnchorRect } from './lib/thread-card-position'

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  interface Props {
    comment: PlanComment
    /** The node or edge the thread rides, named so the card can say what it is attached to. */
    anchorLabel: string
    /** The anchor's rect in graph coordinates; null when it lives on another level. */
    anchorRect: AnchorRect | null
    pane: { width: number; height: number }
    /** Width the inspector or its rail claims on the right. */
    inspectorFootprint: number
    /** Ticking clock, shared with every other thread surface. */
    now: number
    editing: boolean
    onResolve: (resolved: boolean) => void
    onReply: (text: string) => void
    onStartEdit: () => void
    onSaveEdit: (text: string) => void
    onCancelEdit: () => void
    onDelete: () => void
  }

  let {
    comment,
    anchorLabel,
    anchorRect,
    pane,
    inspectorFootprint,
    now,
    editing,
    onResolve,
    onReply,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDelete,
  }: Props = $props()

  const CARD_WIDTH = 252

  // Measured rather than guessed: the card's height is however tall the
  // conversation is, and the clamp needs the real number to keep the composer
  // on screen. One extra frame, no pre-measuring pass.
  let cardHeight = $state(180)

  // Reactive so a pan or a zoom moves the card with its pin. Reading it here
  // is why this component has to be mounted inside the flow.
  const viewport = useViewport()

  // An anchor that has panned off the canvas still gets a card — pulled to the
  // nearest edge — because the thread is open and the reader asked for it.
  const placement = $derived(
    placeThreadCard({
      anchor: anchorRect
        ? anchorToPane(anchorRect, viewport.current)
        : { x: -Infinity, y: 0 },
      card: { width: CARD_WIDTH, height: cardHeight },
      pane,
      inspectorFootprint,
    }),
  )
</script>

<!-- One more floating card, in the same vocabulary as the inspector: it never
     docks and never pushes the graph. At most one is open at a time. -->
<div
  class="diagram-thread-card"
  bind:clientHeight={cardHeight}
  style="left:{placement.left}px;top:{placement.top}px;width:{CARD_WIDTH}px"
  transition:fade|global={{ duration: reduceMotion ? 0 : 120 }}
>
  <!-- The card always says what it is attached to, because it is not attached
       to a coordinate — a moved node keeps its thread. -->
  <div class="diagram-thread-card__anchor">
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6.5h11M6.5 2.5v11" />
    </svg>
    <span class="diagram-thread-card__anchor-label">{anchorLabel}</span>
    {#if placement.detached}
      <span class="diagram-thread-card__detached" title="The node this thread is on is off screen">
        off screen
      </span>
    {/if}
  </div>

  <CommentThreadCard
    {comment}
    focused
    {now}
    {editing}
    onFocus={() => {}}
    {onResolve}
    {onReply}
    {onStartEdit}
    {onSaveEdit}
    {onCancelEdit}
    {onDelete}
  />
</div>

<style>
  /* Sits above the graph and the floating chrome, below the inspector — the
     inspector is the one panel it must never cover. */
  .diagram-thread-card {
    position: absolute;
    z-index: 8;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    /* One step lighter than the inspector's. */
    filter: drop-shadow(0 1rem 2.375rem rgba(60, 40, 25, 0.42));
  }

  .diagram-thread-card__anchor {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    align-self: flex-start;
    max-width: 100%;
    padding: 0.125rem 0.4375rem;
    border-radius: 0.375rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-container-border);
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
  }

  .diagram-thread-card__anchor-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-thread-card__detached {
    flex: none;
    padding-left: 0.375rem;
    border-left: 0.0625rem solid var(--solus-container-border);
    font-family: var(--solus-code-font-family);
    font-size: 0.75rem;
    opacity: 0.8;
  }
</style>
