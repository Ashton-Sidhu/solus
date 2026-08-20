<script lang="ts">
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  /**
   * §16 — the one row every surface that reports a run shares. The live row and
   * the summary row are the same row: it rewrites its contents in place, so the
   * chevron holds its position and the spinner takes the 22px glyph slot the
   * icon cluster will occupy. Nothing moves horizontally when a run ends.
   *
   * The wrappers live here — the callers' snippets supply only what goes inside
   * them, which is what keeps the geometry identical across every state.
   */
  interface Props {
    glyph: Snippet;
    label: Snippet;
    /** Mono and truncating — the object of the sentence. */
    target?: Snippet;
    /** Right end, outside the disclosure so it can hold a button of its own. */
    actions?: Snippet;
    /** 10.5px mono rail; the run time goes last. */
    rail?: Snippet;
    /** Supporting content revealed with the folded activity. */
    detail?: Snippet;
    /** Tint for the glyph slot only; the row itself never takes a colour. */
    glyphClass?: string;
    /** The label runs to two lines, so the row tops-aligns instead of centring. */
    stacked?: boolean;
    expanded?: boolean;
    /** Absent means there is nothing folded away: the chevron keeps its slot for
     *  the geometry but has nothing to open. */
    onToggle?: () => void;
    testid?: string;
  }

  let {
    glyph,
    label,
    target,
    actions,
    rail,
    detail,
    glyphClass = "",
    stacked = false,
    expanded = false,
    onToggle,
    testid,
  }: Props = $props();
</script>

<div class="activity-block">
  <div
    class="activity-row"
    class:is-static={!onToggle}
    data-testid={testid}
  >
    <button
      type="button"
      class="activity-disclose"
      class:is-stacked={stacked}
      disabled={!onToggle}
      aria-expanded={onToggle ? expanded : undefined}
      onclick={onToggle}
    >
      {#if onToggle}
        <CaretRightIcon
          size={12}
          aria-hidden="true"
          class="activity-caret shrink-0 {expanded ? 'rotate-90' : ''}"
        />
      {:else}
        <!-- Nothing to open, so the caret is not drawn — only its slot is kept.
             It cannot be hidden with a utility: `.activity-caret` below is
             unlayered component CSS and outranks the whole utilities layer. -->
        <span class="activity-caret-slot" aria-hidden="true"></span>
      {/if}
      <span class="activity-glyph {glyphClass}">{@render glyph()}</span>
      <span class="activity-label min-w-0">{@render label()}</span>
      {#if target}
        <span class="activity-target font-mono truncate">{@render target()}</span>
      {/if}
      <span class="flex-1"></span>
    </button>

    {#if actions}{@render actions()}{/if}
    {#if rail}
      <span class="activity-rail font-mono shrink-0">{@render rail()}</span>
    {/if}
  </div>

  {#if expanded && detail}
    <div class="activity-detail">{@render detail()}</div>
  {/if}
</div>

<style>
  .activity-block {
    display: flex;
    flex-direction: column;
  }

  .activity-row {
    display: flex;
    width: calc(100% + 1.5rem);
    align-items: flex-start;
    gap: 0.625rem;
    /* The chassis has to clear the text on both ends, or a row this wide reads
       as a full-bleed slab glued to the container edge. 10px stays inside the
       transcript's own 16px gutter and the subagent grid's 12px column gap. */
    margin-inline: -0.75rem;
    padding: 0.4375rem 0.75rem;
    /* Fully round: at this row's height a corner radius reads as a cut no matter
       how large it gets, so the ends are capped instead. */
    border-radius: 9999px;
    /* Hover only — an open row is still a caption, and the rotated caret plus
       the detail's rule already say it is open. */
    transition:
      background var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }

  /* A defined edge rather than a floating patch of grey: the same chip chassis
     the dispatch card uses — barely-there fill under a hairline ring. */
  .activity-row:not(.is-static):hover {
    background: color-mix(in oklch, var(--foreground) 2.5%, transparent);
    box-shadow: inset 0 0 0 0.5px
      color-mix(in oklch, var(--foreground) 11%, transparent);
  }

  .activity-disclose {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.625rem;
    border: none;
    background: transparent;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }

  .activity-disclose:disabled {
    cursor: default;
  }

  .activity-disclose.is-stacked {
    align-items: flex-start;
  }

  .activity-disclose:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.25rem;
    border-radius: 0.25rem;
  }

  :global(.activity-caret) {
    color: var(--muted-foreground);
    opacity: 0.45;
    transition: transform var(--duration-quick) var(--ease-premium);
  }

  .activity-disclose.is-stacked :global(.activity-caret) {
    margin-top: 0.25rem;
  }

  .activity-caret-slot {
    width: 0.75rem;
    flex-shrink: 0;
  }

  /* The 22px slot the icon cluster, the spinner and the stop glyph all share, so
     nothing moves horizontally when the run ends. */
  .activity-glyph {
    display: inline-flex;
    min-width: 1.375rem;
    height: 1.125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 0.3125rem;
    color: var(--muted-foreground);
  }

  /* The only colour a row is permitted, and only on the glyph — never a filled
     banner. `:global` because callers pass it through `glyphClass`. */
  :global(.activity-glyph.is-destructive) {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
  }

  .activity-label {
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }

  .activity-target {
    min-width: 0;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .activity-rail {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.0625rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    opacity: 0.55;
  }

  /* Keep short run times aligned down the turn, but let longer durations claim
     the width they need rather than wrapping onto a second line. */
  :global(.activity-rail-time) {
    display: inline-block;
    min-width: 2.375rem;
    white-space: nowrap;
    text-align: right;
  }

  .activity-detail {
    margin: 0.125rem 0 0 0.9375rem;
    padding-left: 0.75rem;
    border-left: 0.0625rem solid
      color-mix(in oklch, var(--foreground) 9%, transparent);
  }

  /* Running reads as a sentence in progress; when it finishes the sentence goes
     past tense and stops moving. */
  :global(.activity-shimmer) {
    background: linear-gradient(
      90deg,
      var(--muted-foreground) 30%,
      var(--foreground) 50%,
      var(--muted-foreground) 70%
    );
    /* A fixed-width tile the sweep travels exactly once per cycle: percentages
       would resolve against the label's own width, so the loop would seam and
       the phase would jump every time the wording changed length. */
    background-size: 12rem 100%;
    background-repeat: repeat;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: activity-shim 2.4s linear infinite;
  }

  :global(.activity-spinner) {
    width: 0.8125rem;
    height: 0.8125rem;
    border-radius: 9999px;
    border: 0.09375rem solid color-mix(in oklch, var(--foreground) 14%, transparent);
    border-top-color: var(--muted-foreground);
    animation: activity-spin 0.8s linear infinite;
  }

  /* A request in flight with nothing back yet is waiting, not working — dots,
     not a spinner, because nothing is happening yet. */
  :global(.activity-dots) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  :global(.activity-dots > span) {
    width: 0.1875rem;
    height: 0.1875rem;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--foreground) 45%, transparent);
    animation: activity-breathe 1.6s ease-in-out infinite;
  }
  :global(.activity-dots > span:nth-child(2)) {
    animation-delay: 0.22s;
  }
  :global(.activity-dots > span:nth-child(3)) {
    animation-delay: 0.44s;
  }

  @keyframes activity-shim {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 12rem 0;
    }
  }

  @keyframes activity-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes activity-breathe {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.activity-shimmer) {
      animation: none;
      background: none;
      -webkit-text-fill-color: var(--muted-foreground);
      color: var(--muted-foreground);
    }
    :global(.activity-spinner) {
      animation: none;
    }
    :global(.activity-dots > span) {
      animation: none;
      opacity: 0.6;
    }
  }
</style>
