<script lang="ts">
  import type { PinSummary } from './lib/comment-threads'

  interface Props {
    pin: PinSummary
    /** What the pin is attached to — read aloud, never drawn. */
    anchorLabel: string
    onOpen: () => void
  }

  let { pin, anchorLabel, onOpen }: Props = $props()

  const countLabel = $derived(
    `${pin.count} ${pin.count === 1 ? 'thread' : 'threads'} on ${anchorLabel}`,
  )
</script>

<!-- Rides the anchor's top-right corner rather than a canvas coordinate, so a
     moved node keeps its threads. It overlaps the corner deliberately — the
     card itself stays untouched, with no tint or badge inside its body. -->
<button
  type="button"
  class="comment-pin comment-pin--{pin.tone}"
  onclick={(e) => {
    e.stopPropagation()
    onOpen()
  }}
  title="{countLabel}{pin.unread ? ' · unread' : ''}"
  aria-label="Open {countLabel}{pin.unread ? ', unread' : ''}"
>
  {#if pin.unread}
    <!-- The only difference between read and unread. -->
    <span class="comment-pin__dot" aria-hidden="true"></span>
  {/if}

  {#if pin.tone === 'resolved'}
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8.4l3.4 3.2L13 5" />
    </svg>
  {:else if pin.tone === 'agent'}
    <!-- The same mark the doc editor uses for an agent voice. -->
    <span class="comment-pin__spark" aria-hidden="true">✦</span>
    <span class="comment-pin__count">{pin.count}</span>
  {:else}
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v4.8a1.6 1.6 0 0 1-1.6 1.6H6.6L3.6 13.2v-2.6h.6a1.6 1.6 0 0 1-1.6-1.6z" />
    </svg>
    <span class="comment-pin__count">{pin.count}</span>
  {/if}
</button>

<style>
  /* Inside the transformed graph layer, so it pans and zooms with the nodes and
     can never collide with the floating chrome. */
  .comment-pin {
    --pin-tint: var(--solus-art-2);
    --pin-fill: 24%;
    --pin-edge: 60%;
    position: absolute;
    right: -0.625rem;
    top: -0.9375rem;
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.25rem;
    /* The visible pill is 20px; the padding block below pads the hit target out
       to the 24px minimum without moving the pill. */
    padding: 0 0.375rem;
    border-radius: 9999px;
    border: 0.0625rem solid color-mix(in srgb, var(--pin-tint) var(--pin-edge), transparent);
    background: color-mix(in srgb, var(--pin-tint) var(--pin-fill), var(--solus-container-bg));
    box-shadow: 0 0.125rem 0.3125rem rgba(60, 40, 25, 0.14);
    color: var(--pin-tint);
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  /* Pads the click target to 24px min without changing the drawn pill. */
  .comment-pin::before {
    content: '';
    position: absolute;
    inset: -0.125rem -0.0625rem;
  }

  .comment-pin:hover {
    background: color-mix(in srgb, var(--pin-tint) calc(var(--pin-fill) + 12%), var(--solus-container-bg));
  }

  .comment-pin:focus-visible {
    outline: 0.125rem solid var(--pin-tint);
    outline-offset: 0.125rem;
  }

  .comment-pin--resolved {
    --pin-tint: var(--solus-art-3);
    --pin-fill: 20%;
    --pin-edge: 55%;
  }

  .comment-pin--agent {
    --pin-tint: var(--solus-accent);
    --pin-fill: 12%;
    --pin-edge: 42%;
    padding: 0 0.4375rem;
  }

  .comment-pin__dot {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 9999px;
    background: var(--pin-tint);
  }

  .comment-pin__spark {
    font-size: 0.625rem;
    line-height: 1;
  }

  .comment-pin__count {
    font-family: var(--solus-code-font-family);
    font-size: 0.625rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--pin-tint) 70%, var(--solus-text-primary));
  }

  .comment-pin--agent .comment-pin__count {
    color: var(--pin-tint);
  }

  @media (prefers-reduced-motion: reduce) {
    .comment-pin { transition: none; }
  }
</style>
