<script lang="ts">
  import type { DiffComment } from "../../../shared/types";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";

  // A local review note the reader has left on a line but not yet sent. Distinct
  // from DiffThreadComment, which renders an existing GitHub conversation pulled
  // from the host; this one is always the reader's own unsent draft.
  interface Props {
    comment: DiffComment;
    onEdit?: (c: DiffComment) => void;
    onDelete?: (id: string) => void;
  }

  let { comment, onEdit, onDelete }: Props = $props();

  const anchor = $derived(
    comment.startLine === comment.endLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–L${comment.endLine}`,
  );

  // Not reactive to the passage of time — the card is mounted imperatively by the
  // diff virtualizer, so a ticker here would never reach it anyway. It re-reads
  // on remount, which is when a stale "just now" would actually be noticed.
  const age = $derived(formatTimeAgoFromTimestamp(comment.createdAt));
</script>

<!-- Border and shadow live in `style` because Tailwind can't classify either
     value: the color-mix border and the comma-bearing rgba shadow both compile
     to classes that drop their value silently. -->
<div
  class="text-xs group relative mx-3 my-1.5 overflow-hidden rounded-2xl bg-(--solus-popover-bg) px-3 py-2.5"
  style="border:0.0625rem solid color-mix(in oklab, var(--solus-accent) 22%, var(--solus-container-border));box-shadow:0 0.75rem 1.875rem -1.25rem rgba(0, 0, 0, 0.5)"
  data-diff-line="{comment.side}:{comment.endLine}"
  data-comment-id={comment.id}
>
  <div class="flex items-center gap-2">
    <span
      class="shrink-0 text-(--solus-text-tertiary) tabular-nums"
      style="font-family:var(--solus-code-font-family)"
    >
      {anchor}
    </span>
    {#if age}
      <span class="shrink-0 text-(--solus-text-tertiary)">{age}</span>
    {/if}
    <!-- Revealed on focus-within for the keyboard, and simply at rest for a
         coarse pointer, which has no :hover and nothing to focus first. -->
    <div
      class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
    >
      {#if onEdit}
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
          onclick={(e) => {
            e.stopPropagation();
            onEdit?.(comment);
          }}
        >
          Edit
        </button>
      {/if}
      {#if onDelete}
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-(--solus-text-tertiary) transition-colors hover:text-(--solus-status-error) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
          onclick={(e) => {
            e.stopPropagation();
            onDelete?.(comment.id);
          }}
        >
          Delete
        </button>
      {/if}
    </div>
  </div>
  <p
    class="m-0 mt-1 leading-[1.55] text-pretty whitespace-pre-wrap text-(--solus-text-primary)"
  >
    {comment.comment}
  </p>
</div>
