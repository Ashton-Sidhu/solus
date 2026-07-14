<script lang="ts">
  import { CaretRightIcon, PencilSimpleIcon, TrashIcon, ChatsCircleIcon } from 'phosphor-svelte'
  import type { Snippet } from 'svelte'
  import type { PlanComment } from '../../../shared/types'
  import PlanCommentEditor from './PlanCommentEditor.svelte'
  import { Button } from '../ui/button'

  interface Props {
    comments: PlanComment[]
    activeCommentId?: string | null
    editingCommentId?: string | null
    /** Guidance shown in the empty state; lets each host surface its own shortcut. */
    emptyHint?: string
    onScrollTo: (commentId: string) => void
    onHover: (commentId: string | null) => void
    onStartEdit: (commentId: string) => void
    onSaveEdit: (commentId: string, text: string) => void
    onCancelEdit: () => void
    onDelete: (commentId: string) => void
    onClose: () => void
    /** Optional action bar pinned inside the card, below the comment list. */
    footer?: Snippet
  }

  let {
    comments,
    activeCommentId = null,
    editingCommentId = null,
    emptyHint = 'Select text in the plan to add one.',
    onScrollTo,
    onHover,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDelete,
    onClose,
    footer,
  }: Props = $props()

  function truncate(s: string, n = 100) {
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  // Bring the active card into view when it's selected from the document (e.g. a
  // clicked highlight) so the comment is visible without manual scrolling.
  let bodyEl: HTMLDivElement | null = $state(null)
  $effect(() => {
    const id = activeCommentId
    if (!id || !bodyEl) return
    // `nearest` is a no-op when the card is already visible, so hovering marks
    // whose cards are on-screen won't jolt the list; `auto` avoids queuing
    // smooth animations during rapid hover.
    bodyEl
      .querySelector(`[data-comment-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  })
</script>

<aside
  class="plan-comments-rail"
>
  <div class="plan-comments-rail__card no-drag">
    <div class="plan-comments-rail__header">
      <div class="plan-comments-rail__title">
        <span>Comments</span>
        {#if comments.length > 0}
          <span class="plan-comments-rail__count">{comments.length}</span>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
        onclick={onClose}
        title="Hide comments"
        aria-label="Hide comments"
      >
        <CaretRightIcon size={13} />
      </Button>
    </div>

    <div class="plan-comments-rail__body" bind:this={bodyEl}>
    {#if comments.length === 0}
      <div class="plan-comments-rail__empty">
        <ChatsCircleIcon size={28} weight="duotone" />
        <p class="plan-comments-rail__empty-title">No comments yet</p>
        <p class="plan-comments-rail__empty-sub">
          {emptyHint}
        </p>
      </div>
    {:else}
      {#each comments as comment (comment.id)}
        <div
          class="plan-comment-card"
          data-comment-id={comment.id}
          class:plan-comment-card--active={activeCommentId === comment.id}
          onmouseenter={() => onHover(comment.id)}
          onmouseleave={() => onHover(null)}
          role="button"
          tabindex="0"
          onclick={() => onScrollTo(comment.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onScrollTo(comment.id)
            }
          }}
        >
          <div class="plan-comment-card__quote">
            &ldquo;{truncate(comment.selectedText)}&rdquo;
          </div>

          {#if editingCommentId === comment.id}
            <!-- Stop both click and keydown from reaching the card's role=button
                 handler — otherwise Space/Enter typed in the editor scroll-to
                 instead of inserting text. -->
            <div
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => e.stopPropagation()}
              role="presentation"
            >
              <PlanCommentEditor
                initialValue={comment.comment}
                onSave={(text) => onSaveEdit(comment.id, text)}
                onCancel={onCancelEdit}
              />
            </div>
          {:else}
            <p class="plan-comment-card__body">{comment.comment}</p>
            <div class="plan-comment-card__actions">
              <Button
                variant="ghost"
                size="icon-xs"
                class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
                onclick={(e) => { e.stopPropagation(); onStartEdit(comment.id) }}
                title="Edit comment"
              >
                <PencilSimpleIcon size={11} />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
                onclick={(e) => { e.stopPropagation(); onDelete(comment.id) }}
                title="Delete comment"
              >
                <TrashIcon size={11} />
              </Button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
    </div>

    {#if footer}
      <div class="plan-comments-rail__footer">
        {@render footer()}
      </div>
    {/if}
  </div>
</aside>

<style>
  .plan-comments-rail {
    /* Width is governed by the host sleeve (container-relative), so the rail
       fills whatever space it's given and scales with the shell, not the
       viewport — keeps proportions sane in a narrow split pane. */
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    /* Match SidePanel shell: card floats with a small inset gutter. */
    padding: 0.5rem 0.5rem 0.5rem 0;
    background: transparent;
    overflow: hidden;
  }
  .plan-comments-rail__card {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--solus-sidebar-bg-right, var(--solus-sidebar-bg));
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 1rem;
    overflow: hidden;
    contain: layout paint;
  }
  .plan-comments-rail__header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem 0.5rem;
  }
  .plan-comments-rail__title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--solus-text-tertiary);
    opacity: 0.8;
  }
  .plan-comments-rail__count {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0 0.3125rem;
    height: 1rem;
    line-height: 1rem;
    border-radius: 624.9375rem;
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border: none;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  .plan-comments-rail__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.25rem 0.5rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .plan-comments-rail__footer {
    flex-shrink: 0;
    border-top: 0.0625rem solid var(--solus-container-border);
  }
  .plan-comments-rail__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 3rem 1.125rem;
    color: var(--solus-text-tertiary);
    text-align: center;
  }
  .plan-comments-rail__empty-title {
    font-size: 0.75rem;
    color: var(--solus-text-secondary);
    font-weight: 500;
    margin: 0.375rem 0 0;
  }
  .plan-comments-rail__empty-sub {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    margin: 0;
    line-height: 1.5;
  }

  .plan-comment-card {
    padding: 0.5rem 0.625rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    outline: none;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .plan-comment-card:hover {
    background: var(--solus-surface-hover);
  }
  .plan-comment-card:focus-visible {
    box-shadow: 0 0 0 0.125rem var(--solus-input-focus-ring);
  }
  .plan-comment-card--active {
    background: var(--solus-accent-light);
  }
  .plan-comment-card--active:hover {
    background: var(--solus-accent-soft);
  }
  /* Quote treatment mirrors PlanCommentPopover so a comment reads the same
     everywhere: accent left-border over a faint surface fill. */
  .plan-comment-card__quote {
    font-size: 0.6563rem;
    font-style: italic;
    color: var(--solus-text-secondary);
    padding: 0.1875rem 0.4375rem;
    background: var(--solus-surface-hover);
    border-left: 0.125rem solid var(--solus-accent);
    border-radius: 0.25rem;
    margin-bottom: 0.25rem;
    line-height: 1.45;
  }
  .plan-comment-card__body {
    font-size: 0.75rem;
    color: var(--solus-text-primary);
    line-height: 1.5;
    word-break: break-word;
    margin: 0;
    user-select: text;
  }
  .plan-comment-card__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.0625rem;
    margin-top: 0.25rem;
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .plan-comment-card:hover .plan-comment-card__actions,
  .plan-comment-card--active .plan-comment-card__actions,
  .plan-comment-card:focus-visible .plan-comment-card__actions {
    opacity: 1;
  }
  @media (max-width: 767px) {
    .plan-comment-card__actions {
      opacity: 1;
    }

    .plan-comment-card {
      padding: 0.625rem 0.75rem;
    }

    .plan-comment-card__body {
      font-size: 0.875rem;
    }

    .plan-comment-card__quote {
      font-size: 0.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-comment-card,
    .plan-comment-card__actions {
      transition: none !important;
    }
  }
</style>
