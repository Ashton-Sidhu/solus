<script lang="ts">
  import type { PlanComment } from '../../../../shared/types'
  import { threadTime } from '../../../lib/relative-time'
  import {
    authorLabel,
    commentAuthor,
    isResolved,
    isUnread,
  } from '../../comments/lib/thread'
  import { Switch } from '../../ui/switch'

  interface Props {
    /** Threads on the inspected node or edge, in the order they were written. */
    threads: PlanComment[]
    /** 'node' | 'edge' — the only thing that differs between the two tabs. */
    anchorKind: 'node' | 'edge'
    /** Unresolved threads across the whole diagram, for the footer count. */
    diagramThreadCount: number
    showResolved: boolean
    onShowResolvedChange: (show: boolean) => void
    /** Open the thread's card on the canvas and pan its anchor into view. */
    onOpenThread: (commentId: string) => void
    /** Open the diagram-wide thread list. */
    onShowAll: () => void
    now: number
  }

  let {
    threads,
    anchorKind,
    diagramThreadCount,
    showResolved,
    onShowResolvedChange,
    onOpenThread,
    onShowAll,
    now,
  }: Props = $props()

  const open = $derived(threads.filter((t) => !isResolved(t)))
  const resolved = $derived(threads.filter(isResolved))

  function replyCount(thread: PlanComment): string {
    const count = thread.replies?.length ?? 0
    if (count === 0) return ''
    return ` · ${count} ${count === 1 ? 'reply' : 'replies'}`
  }
</script>

<div class="inspector-field">
  <span class="inspector-label">On this {anchorKind}</span>

  {#if threads.length === 0}
    <p class="ct-empty">
      No threads on this {anchorKind} yet. Start one on the canvas — a thread rides its
      {anchorKind}, so it survives a re-layout.
    </p>
  {:else}
    <div class="ct-list">
      {#each open as thread (thread.id)}
        {#if commentAuthor(thread) === 'solus'}
          <!-- An agent row is a receipt, not a conversation: one line saying
               what it did. The full thread only ever opens on the canvas. -->
          <button type="button" class="ct-row ct-row--agent" onclick={() => onOpenThread(thread.id)}>
            <span class="ct-spark" aria-hidden="true">✦</span>
            <span class="ct-agent-name">{authorLabel(thread)}</span>
            <span class="ct-agent-note">{thread.comment}</span>
          </button>
        {:else}
          <button type="button" class="ct-row ct-row--open" onclick={() => onOpenThread(thread.id)}>
            <span class="ct-head">
              {#if isUnread(thread)}
                <span class="ct-unread" aria-label="Unread"></span>
              {/if}
              <!-- No byline: only the agent branch above names an author, and
                   the reader never needs telling that their own note is theirs. -->
              <span class="ct-meta">
                {thread.createdAt ? threadTime(thread.createdAt, now) : ''}{replyCount(thread)}
              </span>
            </span>
            <span class="ct-preview">{thread.comment}</span>
          </button>
        {/if}
      {/each}

      <!-- Resolved threads keep a one-line row here even when their canvas pin
           is gone: settled work stays findable without adding dots to the graph. -->
      {#each resolved as thread (thread.id)}
        <div class="ct-resolved">
          <span class="ct-resolved-dot" aria-hidden="true"></span>
          <span>Resolved</span>
          <button type="button" class="ct-text-btn" onclick={() => onOpenThread(thread.id)}>Show</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<div class="inspector-setting">
  <div class="inspector-setting__text">
    <span class="inspector-setting__title">Show resolved threads</span>
    <span class="inspector-setting__hint">Sage pins on the canvas, collapsed here</span>
  </div>
  <Switch
    checked={showResolved}
    onCheckedChange={onShowResolvedChange}
    aria-label="Show resolved threads"
  />
</div>

<div class="ct-foot">
  <span class="ct-foot__count">
    {diagramThreadCount}
    {diagramThreadCount === 1 ? 'thread' : 'threads'} in this diagram
  </span>
  <button type="button" class="ct-text-btn ct-foot__all" onclick={onShowAll}>Show all</button>
</div>

<style>
  .ct-empty {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--solus-text-tertiary);
    text-wrap: pretty;
  }

  .ct-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* A row here is the same surface as a thread card in the plan and document
     rails — popover fill behind a 1px accent-tinted edge — only shorter,
     because the conversation itself opens on the canvas. */
  .ct-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6875rem 0.75rem;
    border: 0.0625rem solid color-mix(in oklab, var(--solus-accent) 22%, var(--solus-container-border));
    border-radius: 1rem;
    background: var(--solus-popover-bg);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--duration-quick) var(--ease-premium);
  }

  /* Hover reaches the focused card's edge; the fill never moves, exactly as in
     the rails. */
  .ct-row--open:hover {
    border-color: color-mix(in oklab, var(--solus-accent) 45%, var(--solus-container-border));
  }

  .ct-row--agent {
    flex-direction: row;
    align-items: center;
    gap: 0.4375rem;
    border-color: color-mix(in srgb, var(--solus-accent) 30%, transparent);
    background: color-mix(in srgb, var(--solus-accent) 5%, var(--solus-popover-bg));
  }

  .ct-row--agent:hover {
    border-color: color-mix(in srgb, var(--solus-accent) 55%, transparent);
    background: color-mix(in srgb, var(--solus-accent) 9%, var(--solus-popover-bg));
  }

  .ct-row:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .ct-head {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }

  .ct-unread {
    flex: none;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--solus-art-2);
  }

  .ct-meta {
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
    white-space: nowrap;
  }

  /* Two lines of the opening comment — the full thread only renders on canvas. */
  .ct-preview {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--text-xs);
    line-height: 1.6;
    color: color-mix(in srgb, var(--solus-text-primary) 90%, var(--solus-text-tertiary));
    word-break: break-word;
    text-wrap: pretty;
  }

  .ct-spark {
    flex: none;
    font-size: var(--text-xs);
    color: var(--solus-accent);
  }

  .ct-agent-name {
    flex: none;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--solus-accent);
  }

  .ct-agent-note {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Chrome-less: a sage dot, who settled it, and a way back in. */
  .ct-resolved {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.125rem;
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
  }

  .ct-resolved-dot {
    flex: none;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--solus-art-3) 70%, transparent);
  }

  .ct-text-btn {
    margin-left: auto;
    border: none;
    background: none;
    padding: 0;
    font-size: inherit;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }

  .ct-text-btn:hover { color: var(--solus-text-primary); }

  .ct-text-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .ct-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 0.0625rem solid var(--solus-container-border);
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
  }

  .ct-foot__count {
    font-family: var(--solus-code-font-family);
  }

  .ct-foot__all { color: var(--solus-accent); }
  .ct-foot__all:hover { color: var(--solus-accent); opacity: 0.8; }

  @media (prefers-reduced-motion: reduce) {
    .ct-row, .ct-text-btn { transition: none; }
  }
</style>
