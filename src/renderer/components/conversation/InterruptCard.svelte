<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { WarningIcon } from 'phosphor-svelte'

  /**
   * One card shape for every moment the agent stops and needs the user. Header
   * furniture, body grammar and the two-tier footer are fixed; only the body
   * differs between a permission, a question and a rate limit. Sections stack in
   * a fixed order and are separated by hairlines, never by extra whitespace.
   */
  interface Props {
    /** One word naming the interrupt class. */
    eyebrow: string
    /** Short human summary — verb first, no payload pasted in. */
    title: string
    /** `destructive` adds the warning strip. Buttons stay neutral either way:
     *  the affirmative is still the card's one terracotta. */
    tone?: 'neutral' | 'destructive'
    testId: string
    /** State the app owns, as a `TranscriptChip`. */
    chip?: Snippet
    /** Provenance — tool · path, or agent · timer. */
    meta?: Snippet
    /** Header-right furniture: a pager, a countdown. */
    headerAside?: Snippet
    children: Snippet
    footer: Snippet
  }

  let {
    eyebrow,
    title,
    tone = 'neutral',
    testId,
    chip,
    meta,
    headerAside,
    children,
    footer,
  }: Props = $props()
</script>

<div
  transition:fly={{ y: 8, duration: 200 }}
  class="mx-auto my-2 w-full max-w-[47.5rem] overflow-hidden rounded-2xl border border-border bg-card text-[0.8125rem] shadow-[shadow:var(--solus-tx-raised-shadow)]"
  data-testid={testId}
>
  <div class="interrupt-head flex items-start gap-3 px-[1.125rem] pt-[0.875rem] pb-[0.8125rem]">
    <div class="flex min-w-0 flex-1 flex-col gap-[0.125rem]">
      <span class="interrupt-eyebrow">{eyebrow}</span>
      <div class="flex min-w-0 items-center gap-2.5">
        <h2 class="m-0 min-w-0 truncate text-[0.9375rem] leading-[1.3] font-semibold tracking-tight">
          {title}
        </h2>
        {@render chip?.()}
      </div>
      {#if meta}
        <div class="interrupt-meta flex min-w-0 items-center gap-1.5">{@render meta()}</div>
      {/if}
    </div>
    {@render headerAside?.()}
  </div>

  <!-- Only an explicit rule raises this strip, and it names the rule rather than
       claiming an effect. -->
  {#if tone === 'destructive'}
    <div class="interrupt-danger flex items-center gap-2 px-[1.125rem] py-[0.4375rem]">
      <WarningIcon size={14} weight="fill" class="shrink-0" />
      <span>Matches a destructive command pattern — its effects can reach outside the worktree.</span>
    </div>
  {/if}

  {@render children()}

  <!-- Escape hatch left, scope-broadening in the middle, the one filled default
       on the right. Never the reverse, on any interrupt. -->
  <div class="interrupt-footer flex items-center gap-2 py-[0.6875rem] pr-[0.875rem] pl-[1.125rem]">
    {@render footer()}
  </div>
</div>

<style>
  .interrupt-head {
    border-bottom: 0.0625rem solid var(--border);
  }

  .interrupt-eyebrow {
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  /* The meta line sets the size and colour its spans inherit; a card emphasises
     one segment by moving it to foreground/500, never by enlarging it. */
  .interrupt-meta {
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .interrupt-danger {
    background: color-mix(in oklch, var(--destructive) 10%, transparent);
    color: color-mix(in oklch, var(--destructive) 72%, var(--foreground));
    font-size: 0.71875rem;
  }

  .interrupt-footer {
    border-top: 0.0625rem solid var(--border);
    background: color-mix(in oklch, var(--muted) 32%, transparent);
  }

  /* Chrome below is shared by every card that mounts this chassis, so it is
     defined once here rather than copied into each of them. */

  /* Buttons name the outcome, not the verb. */
  :global(.interrupt-btn) {
    display: inline-flex;
    height: 1.875rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    padding: 0 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.78125rem;
    font-weight: 400;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-btn):hover:not(:disabled) {
    background: var(--muted);
    color: var(--foreground);
  }
  :global(.interrupt-btn):disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Broadening the grant is a neutral, bordered step — never a second fill. */
  :global(.interrupt-btn--secondary) {
    border: 0.0625rem solid var(--border);
    background: var(--card);
    padding: 0 0.625rem;
    color: var(--foreground);
    box-shadow: 0 0.0625rem 0.0625rem
      color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  /* The card's one terracotta. */
  :global(.interrupt-btn--primary) {
    gap: 0.5rem;
    padding: 0 0.75rem;
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 500;
    box-shadow: 0 0.0625rem 0.125rem
      color-mix(in oklch, var(--foreground) 14%, transparent);
  }
  :global(.interrupt-btn--primary):hover:not(:disabled) {
    background: color-mix(in oklch, var(--primary) 90%, black);
    color: var(--primary-foreground);
  }

  /* A key hint lives inside the button it fires, never in a separate legend. */
  :global(.interrupt-key) {
    font-family: var(--solus-code-font-family);
    font-size: 0.625rem;
    opacity: 0.75;
  }
  :global(.interrupt-btn--primary .interrupt-key) {
    font-size: 0.65625rem;
    opacity: 0.8;
  }

  /* The one canonical rendering of what the agent wants: a quiet bar naming the
     interpreter and holding Copy, over unwrapped mono. The fill stays near-card
     so contrast comes from the hairline rather than a grey slab. */
  :global(.interrupt-payload) {
    overflow: hidden;
    border: 0.0625rem solid var(--border);
    border-radius: 0.5rem;
    background: color-mix(in oklch, var(--muted) 26%, var(--card));
  }
  :global(.interrupt-payload-bar) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 0.0625rem solid var(--border);
    padding: 0.375rem 0.625rem 0.375rem 0.6875rem;
  }
  :global(.interrupt-payload-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--solus-code-font-family);
    font-size: 0.59375rem;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }
  /* Approving a command you can't read verbatim is the failure mode these cards
     exist to prevent, so the body scrolls rather than re-flowing. */
  :global(.interrupt-payload-body) {
    margin: 0;
    padding: 0.6875rem 0.8125rem 0.75rem;
    font-family: var(--solus-code-font-family);
    font-size: 0.75rem;
    line-height: 1.75;
    color: var(--foreground);
    white-space: pre;
    overflow-x: auto;
  }

  /* Debug data collapses; a preview the user is choosing between opens. */
  :global(.interrupt-disclosure) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    border: none;
    background: transparent;
    padding: 0.25rem 0;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-disclosure):hover {
    color: var(--foreground);
  }
  :global(.interrupt-caret) {
    display: inline-flex;
    flex-shrink: 0;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-caret.is-open) {
    transform: rotate(90deg);
  }

  :global(.interrupt-detail-table) {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.875rem;
    border: 0.0625rem solid var(--border);
    border-radius: 0.5rem;
    padding: 0.625rem 0.75rem;
    background: color-mix(in oklch, var(--muted) 24%, var(--card));
    font-family: var(--solus-code-font-family);
    font-size: 0.65625rem;
    overflow-wrap: anywhere;
  }
</style>
