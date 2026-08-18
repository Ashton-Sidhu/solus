<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../../lib/tw";
  import { formatMessageTime } from "../../lib/sessionUtils";

  /**
   * §17 — the transcript's one divider: two hairlines and a pill at a 4% wash.
   * Everything that interrupts the thread uses it — a stop, an interrupt notice,
   * a fork, a handoff, a move into a worktree — so there is one shape to learn.
   *
   * Retry rides *inside* the pill behind a hairline separator; it never becomes a
   * second element under the divider, and never a card or a banner.
   */
  interface Props {
    children: Snippet;
    glyph?: Snippet;
    /** The emphasised span after the label — a title, a branch, a worktree. */
    title?: Snippet;
    /** One ghost segment on the right end. Not valid together with `onclick`. */
    action?: Snippet;
    timestamp?: number;
    /** Callers style the content, never the chassis. */
    glyphClass?: string;
    titleClass?: string;
    onclick?: () => void;
    ariaLabel?: string;
    testid?: string;
    skipMotion?: boolean;
    emphasized?: boolean;
  }

  let {
    children,
    glyph,
    title,
    action,
    timestamp,
    glyphClass = "",
    titleClass = "",
    onclick,
    ariaLabel,
    testid,
    skipMotion = false,
    emphasized = false,
  }: Props = $props();
</script>

{#snippet pillBody()}
  {#if glyph}
    <span class={cn("divider-glyph", glyphClass)}>{@render glyph()}</span>
  {/if}
  <span class="divider-label">{@render children()}</span>
  {#if title}
    <span class={cn("divider-title", titleClass)}>{@render title()}</span>
  {/if}
  {#if timestamp}
    <span class="divider-time">· {formatMessageTime(timestamp)}</span>
  {/if}
  {#if action}
    <span class="divider-sep"></span>{@render action()}
  {/if}
{/snippet}

<div
  class="divider {skipMotion ? '' : 'animate-msg-in-side'}"
  class:is-emphasized={emphasized}
  data-testid={testid}
>
  <span class="divider-rule"></span>
  {#if onclick}
    <button type="button" class="divider-pill is-interactive" aria-label={ariaLabel} {onclick}>
      {@render pillBody()}
    </button>
  {:else}
    <span class="divider-pill" class:has-action={!!action}>{@render pillBody()}</span>
  {/if}
  <span class="divider-rule"></span>
</div>

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-block: 0.375rem;
  }

  .divider-rule {
    flex: 1;
    min-width: 0.75rem;
    height: 0.0625rem;
    background: var(--solus-tx-rule-strong);
  }

  .divider-pill {
    display: inline-flex;
    max-width: 80%;
    min-width: 0;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
    padding: 0.1875rem 0.625rem;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    line-height: 1rem;
    text-align: center;
    text-wrap: pretty;
  }

  .divider.is-emphasized .divider-pill {
    gap: 0.4375rem;
    padding: 0.25rem 0.75rem;
    font-size: var(--text-xs);
    line-height: 1.125rem;
  }

  /* The ghost segment brings its own right padding. */
  .divider-pill.has-action {
    padding-right: 0.25rem;
  }

  .divider-pill.is-interactive {
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .divider-pill.is-interactive:hover {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    color: var(--solus-text-primary);
  }
  .divider-pill.is-interactive:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  .divider-glyph {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
  }

  .divider-label {
    min-width: 0;
    white-space: pre-wrap;
  }

  .divider-title {
    max-width: 12.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .divider-time {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .divider-sep {
    width: 0.0625rem;
    height: 0.75rem;
    flex-shrink: 0;
    margin-inline: 0.1875rem;
    background: color-mix(in oklch, var(--foreground) 12%, transparent);
  }

  /* The one ghost control §17 allows on a divider, styled here so every caller's
     retry is the same segment. */
  :global(.divider-action) {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    border: none;
    border-radius: 9999px;
    background: transparent;
    padding: 0.125rem 0.5625rem;
    color: var(--solus-text-primary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  :global(.divider-action:hover) {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
  }
  :global(.divider-action:focus-visible) {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
</style>
