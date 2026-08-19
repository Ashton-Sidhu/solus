<script lang="ts">
  import { useViewport } from '@xyflow/svelte'
  import { fade } from 'svelte/transition'
  import { CommentComposer } from '../ui/comment-composer'
  import {
    anchorToPane,
    placeThreadCard,
    THREAD_CARD_WIDTH,
    type AnchorRect,
  } from './lib/thread-card-position'

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  interface Props {
    /** The node or edge the new thread will ride, named so the composer can say so. */
    anchorLabel: string
    /** The anchor's rect in graph coordinates; null when it lives on another level. */
    anchorRect: AnchorRect | null
    pane: { width: number; height: number }
    /** Width the inspector or its rail claims on the right. */
    inspectorFootprint: number
    onSubmit: (text: string) => void
    onCancel: () => void
  }

  let { anchorLabel, anchorRect, pane, inspectorFootprint, onSubmit, onCancel }: Props = $props()

  let cardHeight = $state(132)

  // Reactive so a pan or a zoom moves the composer with its anchor. Reading it
  // here is why this component has to be mounted inside the flow.
  const viewport = useViewport()

  const placement = $derived(
    placeThreadCard({
      anchor: anchorRect ? anchorToPane(anchorRect, viewport.current) : { x: -Infinity, y: 0 },
      card: { width: THREAD_CARD_WIDTH, height: cardHeight },
      pane,
      inspectorFootprint,
    }),
  )
</script>

<!-- Starts a thread where the thread will live. It borrows the thread card's
     geometry exactly, so posting swaps one floating card for another in place. -->
<div
  class="diagram-thread-composer"
  style="left:{placement.left}px;top:{placement.top}px;width:{THREAD_CARD_WIDTH}px"
  bind:clientHeight={cardHeight}
  transition:fade|global={{ duration: reduceMotion ? 0 : 120 }}
>
  <div class="diagram-thread-composer__anchor">
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6.5h11M6.5 2.5v11" />
    </svg>
    <span class="diagram-thread-composer__anchor-label">{anchorLabel}</span>
    {#if placement.detached}
      <span class="diagram-thread-composer__detached" title="The thing this thread is on is off screen">
        off screen
      </span>
    {/if}
  </div>

  <!-- The one comment box, the same as a diff line's and a document run's. The
       anchor chip above already names what the thread is on. -->
  <CommentComposer
    onSave={onSubmit}
    {onCancel}
    placeholder="Comment on {anchorLabel}…"
    submitOn="enter"
    rows={4}
  />
</div>

<style>
  /* The thread card's layer exactly — the two are never open at once, and the
     composer becomes the card. */
  .diagram-thread-composer {
    position: absolute;
    z-index: 8;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    filter: drop-shadow(0 1rem 2.375rem rgba(60, 40, 25, 0.42));
  }

  .diagram-thread-composer__anchor {
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
    font-size: var(--text-xs);
  }

  .diagram-thread-composer__anchor-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-thread-composer__detached {
    flex: none;
    padding-left: 0.375rem;
    border-left: 0.0625rem solid var(--solus-container-border);
    font-family: var(--solus-code-font-family);
    font-size: var(--text-xs);
    opacity: 0.8;
  }
</style>
