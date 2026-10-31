<script lang="ts">
  import type { Snippet } from 'svelte'
  import {
    ShieldCheck as PermissionIcon,
    MessageSquareText as QuestionIcon,
    TriangleAlert as WarningIcon,
  } from '@lucide/svelte'

  /**
   * The shell of a decision card (docs/transcript-cards.md, "Interrupts"). A
   * glass card with one eyebrow line, an open body, and the decision at the
   * end. No header bar, no inner rules: the body's own hierarchy carries it.
   * Key hints show only while the pointer or focus is on the card.
   */
  interface Props {
    type: 'permission' | 'question'
    /** The eyebrow: who asks, in a few words. */
    title: string
    tone?: 'neutral' | 'destructive'
    /** A blocking request takes the attention lift; a message-mode question stays quiet. */
    blocking?: boolean
    testId: string
    /** Counts, time, and a disclosure link, never prose. */
    rail?: Snippet
    children: Snippet
    footer: Snippet
  }

  let { type, title, tone = 'neutral', blocking = true, testId, rail, children, footer }: Props = $props()
</script>

<div class="py-1 animate-msg-in-side">
  <section
    class="interrupt-card flex min-w-0 flex-col gap-3"
    class:is-quiet={!blocking}
    class:is-destructive={tone === 'destructive'}
    data-testid={testId}
  >
    <div class="interrupt-eyebrow">
      <span class="interrupt-eyebrow-glyph" class:is-destructive={tone === 'destructive'}>
        {#if tone === 'destructive'}<WarningIcon size={13} />
        {:else if type === 'permission'}<PermissionIcon size={13} />
        {:else}<QuestionIcon size={13} />{/if}
      </span>
      <span class="min-w-0 truncate">{title}</span>
      <span class="flex-1"></span>
      {#if rail}<span class="interrupt-rail">{@render rail()}</span>{/if}
    </div>
    {@render children()}
    {@render footer()}
  </section>
</div>

<style>
  /* ── shell ── */
  /* The agent conversation card's geometry: its radius, and padding that puts
     the text where that card's rows put theirs. */
  :global(.interrupt-card) {
    border-radius: var(--tx-card-radius);
    padding: 0.625rem 0.75rem 0.75rem;
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-attention-shadow);
    font-size: var(--text-transcript-card);
  }
  :global(.interrupt-card.is-quiet) {
    box-shadow: var(--solus-tx-quiet-shadow);
  }
  :global(.interrupt-card.is-destructive) {
    box-shadow:
      0 0 0 0.0625rem color-mix(in oklch, var(--destructive) 30%, transparent),
      var(--solus-tx-attention-shadow);
  }

  .interrupt-eyebrow {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }
  .interrupt-eyebrow-glyph {
    display: inline-flex;
    flex-shrink: 0;
    opacity: 0.8;
  }
  .interrupt-eyebrow-glyph.is-destructive {
    color: var(--destructive);
    opacity: 1;
  }
  .interrupt-rail {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.625rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* The lead line: the question, or what the agent wants to do. */
  :global(.interrupt-title) {
    margin: 0;
    font-size: var(--text-transcript-card);
    line-height: 1.45;
    color: var(--solus-text-primary);
    text-wrap: balance;
  }

  /* ── keys: present for focus, visible only while the pointer or focus is on the card ── */
  :global(.interrupt-key) {
    font-family: var(--solus-code-font-family);
    font-size: 0.6875rem;
    color: var(--muted-foreground);
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-card:hover .interrupt-key),
  :global(.interrupt-card:focus-within .interrupt-key) {
    opacity: 0.7;
  }
  :global(.interrupt-pill.is-filled .interrupt-key) {
    color: inherit;
  }
  @media (pointer: coarse) {
    :global(.interrupt-key) {
      display: none;
    }
  }

  /* ── a quiet text link in the eyebrow or under the bar ── */
  :global(.interrupt-link) {
    border: none;
    background: transparent;
    padding: 0;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-link:hover:not(:disabled)) {
    color: var(--solus-text-primary);
  }
  :global(.interrupt-link:disabled) {
    opacity: 0.5;
    cursor: default;
  }

  /* ── pills: the decision ── */
  :global(.interrupt-pill) {
    display: inline-flex;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 0.375rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    padding: 0 0.625rem;
    white-space: nowrap;
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  :global(.interrupt-pill:hover:not(:disabled)) {
    background: color-mix(in oklch, var(--foreground) 10%, transparent);
  }
  :global(.interrupt-pill:active:not(:disabled)) {
    transform: scale(0.985);
  }
  :global(.interrupt-pill.is-filled) {
    background: var(--primary);
    color: var(--primary-foreground);
  }
  :global(.interrupt-pill.is-filled:hover:not(:disabled)) {
    background: color-mix(in oklch, var(--primary) 92%, var(--foreground));
  }
  :global(.interrupt-pill.is-text) {
    background: transparent;
    padding: 0 0.5rem;
    color: var(--muted-foreground);
  }
  :global(.interrupt-pill.is-text:hover:not(:disabled)) {
    background: transparent;
    color: var(--solus-text-primary);
  }
  :global(.interrupt-pill.is-text.is-deny:hover:not(:disabled)) {
    color: var(--destructive);
  }
  :global(.interrupt-pill:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  :global(.interrupt-pill:focus-visible) {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
  @media (pointer: coarse) {
    :global(.interrupt-pill) {
      height: 2rem;
      padding: 0 0.75rem;
    }
  }

  /* ── the own-words bar: card fill, a hairline, the primary action inside ── */
  :global(.interrupt-bar) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.75rem;
    padding: 0.375rem 0.375rem 0.375rem 0.875rem;
    box-shadow: inset 0 0 0 0.0625rem color-mix(in oklab, var(--border) 50%, transparent);
    transition: box-shadow var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-bar:focus-within) {
    box-shadow: inset 0 0 0 0.0625rem color-mix(in oklch, var(--primary) 45%, var(--border));
  }
  :global(.interrupt-send) {
    display: inline-flex;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--primary);
    padding: 0 0.75rem;
    white-space: nowrap;
    color: var(--primary-foreground);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-send:hover:not(:disabled)) {
    background: color-mix(in oklch, var(--primary) 92%, var(--foreground));
  }
  :global(.interrupt-send:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  :global(.interrupt-send .interrupt-key) {
    color: inherit;
  }
  @media (pointer: coarse) {
    :global(.interrupt-send) {
      height: 2.25rem;
    }
  }

  /* ── the command, a preview, a diff: the only boxed things on the card ── */
  :global(.interrupt-term) {
    position: relative;
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 0.5rem;
    overflow: hidden;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in oklab, var(--border) 50%, transparent);
  }
  :global(.interrupt-term-prompt) {
    flex-shrink: 0;
    user-select: none;
    font-family: var(--solus-code-font-family);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--muted-foreground);
  }
  :global(.interrupt-term-copy) {
    position: absolute;
    top: 0.375rem;
    right: 0.5rem;
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-term:hover .interrupt-term-copy),
  :global(.interrupt-term:focus-within .interrupt-term-copy) {
    opacity: 1;
  }

  :global(.interrupt-payload) {
    overflow: hidden;
    border-radius: 0.5rem;
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in oklab, var(--border) 50%, transparent);
  }
  :global(.interrupt-payload-bar) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem 0.25rem;
  }
  :global(.interrupt-payload-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-transcript-meta);
    color: var(--solus-text-secondary);
  }

  /* A hairline between two choices, or between answered questions and the live one,
     inset to the option rows' text column as Settings' RowCard insets to its rows. */
  :global(.interrupt-divider) {
    height: 0.0625rem;
    margin: 0.0625rem 0.5rem;
    background: var(--solus-tx-divider);
    opacity: 0.8;
  }

  /* The chip that names where a permission runs. */
  :global(.interrupt-chip) {
    display: inline-flex;
    height: 1.375rem;
    align-items: center;
    gap: 0.3rem;
    border-radius: 0.4rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    padding: 0 0.5rem;
    vertical-align: 0.125rem;
    font-family: var(--solus-code-font-family);
    font-size: 0.75rem;
    color: var(--solus-text-secondary);
  }

  :global(.interrupt-detail-table) {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.875rem;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-transcript-meta);
    color: var(--solus-text-secondary);
    overflow-wrap: anywhere;
  }
</style>
