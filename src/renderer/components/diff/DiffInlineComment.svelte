<script lang="ts">
  import type { DiffComment } from "../../../shared/types";

  interface Props {
    comment: DiffComment;
    variant?: "card" | "minimal";
    onEdit?: (c: DiffComment) => void;
    onDelete?: (id: string) => void;
  }

  let { comment, variant = "card", onEdit, onDelete }: Props = $props();

  let badge = $derived(
    comment.startLine === comment.endLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–L${comment.endLine}`,
  );
</script>

<div
  class="inline-comment"
  class:card={variant === "card"}
  class:minimal={variant === "minimal"}
  data-diff-line="{comment.side}:{comment.endLine}"
  data-comment-id={comment.id}
>
  <div class="body">
    <span class="badge">{badge}</span>
    <p class="text">{comment.comment}</p>
  </div>
  <div class="actions">
    {#if onEdit}
      <button
        class="action-btn"
        class:action-btn-circle={variant === "card"}
        class:action-link={variant === "minimal"}
        aria-label="Edit comment"
        onclick={(e) => { e.stopPropagation(); onEdit?.(comment); }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81 4.275 10.286a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064L11.189 6.25z" />
        </svg>
      </button>
    {/if}
    {#if onDelete}
      <button
        class="action-btn action-btn--delete"
        class:action-btn-circle={variant === "card"}
        class:action-link={variant === "minimal"}
        aria-label="Delete comment"
        onclick={(e) => { e.stopPropagation(); onDelete?.(comment.id); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M.22.22a.75.75 0 011.06 0L5 3.94 8.72.22a.75.75 0 111.06 1.06L6.06 5l2.72 2.72a.75.75 0 11-1.06 1.06L5 6.06 1.28 9.78A.75.75 0 01.22 8.72L3.94 5 .22 1.28A.75.75 0 01.22.22z" />
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  /* Shared */
  .inline-comment {
    display: flex;
    align-items: flex-start;
    margin: 0.375rem 0.75rem;
    transition: box-shadow 0.15s ease, border-color 0.15s ease;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }

  .badge {
    font-family: var(--solus-code-font-family);
  }

  .text {
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    margin: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  /* Reveal on focus-within too, so keyboard and touch users (no :hover) can
     reach edit/delete. */
  .inline-comment:hover .actions,
  .inline-comment:focus-within .actions {
    opacity: 1;
  }

  .action-btn {
    border: none;
    background: none;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .action-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
    border-radius: 0.25rem;
  }

  /* Card variant (Diff.svelte) */
  .card {
    gap: 0.625rem;
    padding: 0.625rem 0.75rem;
    border-radius: 1rem;
    border: 0.0625rem solid var(--solus-container-border);
    background: #fffdfa;
    box-shadow: 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.06);
  }

  :global(.dark) .card {
    background: var(--solus-container-bg);
  }

  .card:hover {
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.09);
  }

  .card .body {
    padding-right: 2.5rem;
  }

  .card .badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--solus-text-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
  }

  .card .text {
    color: var(--solus-text-secondary);
  }

  .card .actions {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    gap: 0.125rem;
  }

  .card {
    position: relative;
  }

  .card .action-btn-circle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
  }

  .card .action-btn-circle:hover {
    background: var(--solus-surface-active);
    color: var(--solus-text-primary);
  }

  .card .action-btn--delete.action-btn-circle:hover {
    background: var(--solus-status-error-bg);
    color: var(--solus-status-error);
  }

  /* Minimal variant (DiffStream.svelte) */
  .minimal {
    padding: 0;
    border-radius: 0.5rem;
    border-left: 0.1875rem solid var(--solus-accent);
    background: var(--solus-popover-bg);
    box-shadow: 0 0 0 0.0625rem var(--solus-container-border);
  }

  .minimal:hover {
    border-left-color: var(--solus-accent);
  }

  .minimal .body {
    padding: 0.25rem 0.625rem;
  }

  .minimal .badge {
    display: inline-flex;
    align-items: center;
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0;
    flex-shrink: 0;
    background: transparent;
    color: var(--solus-text-tertiary);
  }

  .minimal .text {
    color: var(--solus-text-primary);
  }

  .minimal .actions {
    gap: 0.25rem;
    flex-shrink: 0;
    padding: 0.25rem 0.25rem 0 0;
  }

  .minimal .action-link {
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    padding: 0.0625rem 0.25rem;
    border-radius: 0.1875rem;
    text-decoration: none;
  }

  .minimal .action-link:hover {
    text-decoration: underline;
    text-underline-offset: 0.125rem;
  }

  .minimal .action-link:not(.action-btn--delete):hover {
    color: var(--solus-text-primary);
  }

  .minimal .action-btn--delete.action-link:hover {
    color: var(--solus-status-error);
  }
</style>
