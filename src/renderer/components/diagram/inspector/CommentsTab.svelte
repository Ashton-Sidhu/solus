<script lang="ts">
  import type { PlanComment } from '../../../../shared/types'
  import { threadTime } from '../../../lib/relative-time'
  import PlanCommentEditor from '../../plan/PlanCommentEditor.svelte'
  import {
    authorInitials,
    authorLabel,
    authorName,
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
    onAddThread: (text: string) => void
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
    onAddThread,
    onShowAll,
    now,
  }: Props = $props()

  const open = $derived(threads.filter((t) => !isResolved(t)))
  const resolved = $derived(threads.filter(isResolved))

  let composing = $state(false)

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
      No threads on this {anchorKind} yet. A thread rides its {anchorKind}, so it survives a
      re-layout.
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
              <span class="ct-avatar" aria-hidden="true">
                {authorInitials(commentAuthor(thread))}
              </span>
              <span class="ct-name">{authorName(commentAuthor(thread))}</span>
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
          <span>Resolved · {authorName(thread.resolvedBy ?? 'you')}</span>
          <button type="button" class="ct-text-btn" onclick={() => onOpenThread(thread.id)}>Show</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<div class="inspector-field">
  <span class="inspector-label">Add</span>
  {#if composing}
    <PlanCommentEditor
      initialValue=""
      placeholder="Comment on this {anchorKind}…"
      onSave={(text) => {
        onAddThread(text)
        composing = false
      }}
      onCancel={() => (composing = false)}
    />
  {:else}
    <button type="button" class="ct-add" onclick={() => (composing = true)}>
      <span class="ct-avatar ct-avatar--you" aria-hidden="true">You</span>
      <span>Comment on this {anchorKind}…</span>
    </button>
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
    gap: 0.375rem;
  }

  /* Each row is the pin's tint at 9% behind a 1px 55% edge — the same colour
     rule the canvas pin and the thread card use. */
  .ct-row {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
    padding: 0.5625rem 0.6875rem;
    border-radius: 0.625rem;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .ct-row--open {
    border: 0.0625rem solid color-mix(in srgb, var(--solus-art-2) 55%, transparent);
    background: color-mix(in srgb, var(--solus-art-2) 9%, var(--solus-container-bg));
  }

  .ct-row--open:hover {
    background: color-mix(in srgb, var(--solus-art-2) 15%, var(--solus-container-bg));
  }

  .ct-row--agent {
    flex-direction: row;
    align-items: center;
    gap: 0.4375rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-accent) 30%, transparent);
    background: color-mix(in srgb, var(--solus-accent) 6%, var(--solus-container-bg));
  }

  .ct-row--agent:hover {
    background: color-mix(in srgb, var(--solus-accent) 11%, var(--solus-container-bg));
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

  /* Only a human ever wears a circle here — Solus takes the ✦ branch above, so
     this row has exactly one author tone rather than a hashed palette, and
     that tone is the terracotta that already means "you" everywhere else. */
  .ct-avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.0625rem;
    height: 1.0625rem;
    border-radius: 9999px;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .ct-name {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--solus-text-primary);
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
    line-height: 1.55;
    color: var(--solus-text-tertiary);
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

  /* The only dashed affordance in the panel besides Add field. */
  .ct-add {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    padding: 0.5625rem 0.6875rem;
    border: 0.0625rem dashed color-mix(in srgb, var(--solus-accent) 45%, transparent);
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--solus-accent) 5%, var(--solus-container-bg));
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .ct-add:hover { background: color-mix(in srgb, var(--solus-accent) 10%, var(--solus-container-bg)); }

  .ct-add:focus-visible {
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
    .ct-row, .ct-add, .ct-text-btn { transition: none; }
  }
</style>
