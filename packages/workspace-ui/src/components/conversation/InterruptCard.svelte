<script lang="ts">
  import type { Snippet } from 'svelte'
  import {
    ShieldCheck as PermissionIcon,
    MessageSquareText as QuestionIcon,
    TriangleAlert as WarningIcon,
  } from '@lucide/svelte'
  import TranscriptCard from './TranscriptCard.svelte'

  /** Decision bodies stay open, inside the same shell as other transcript cards. */
  interface Props {
    type: 'permission' | 'question'
    title: string
    target?: string
    tone?: 'neutral' | 'destructive'
    blocking?: boolean
    testId: string
    rail?: Snippet
    children: Snippet
    footer: Snippet
  }

  let {
    type,
    title,
    target,
    tone = 'neutral',
    blocking = true,
    testId,
    rail,
    children,
    footer,
  }: Props = $props()
</script>

<TranscriptCard
  {title}
  {type}
  {target}
  variant={blocking ? 'attention' : 'quiet'}
  glyphClass={tone === 'destructive' ? 'is-failed' : ''}
  data-testid={testId}
  {rail}
>
  {#snippet glyph()}
    {#if tone === 'destructive'}<WarningIcon />
    {:else if type === 'permission'}<PermissionIcon />
    {:else}<QuestionIcon />{/if}
  {/snippet}
  {#snippet body()}
    <div class="flex min-w-0 flex-col gap-2.5 text-transcript-card">
      {#if tone === 'destructive'}
        <p class="m-0 text-transcript-meta text-destructive">
          Matches a destructive command pattern — its effects can reach outside the worktree.
        </p>
      {/if}
      {@render children()}
    </div>
  {/snippet}
  {#snippet actions()}
    {@render footer()}
  {/snippet}
</TranscriptCard>

<style>
  :global(.interrupt-key) {
    font-family: var(--solus-code-font-family);
    font-size: var(--text-transcript-meta);
    opacity: 0.75;
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
    font-size: var(--text-transcript-meta);
    font-weight: 500;

    color: var(--muted-foreground);
  }
  /* Approving a command you can't read verbatim is the failure mode these cards
     exist to prevent, so the body scrolls rather than re-flowing. */
  :global(.interrupt-payload-body) {
    margin: 0;
    padding: 0.6875rem 0.8125rem 0.75rem;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-transcript-meta);
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
    font-size: var(--text-transcript-meta);
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
    font-size: var(--text-transcript-meta);
    overflow-wrap: anywhere;
  }
</style>
