<script lang="ts">
  import type { DiffComment } from "@solus/contracts/types";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { Button } from "../ui/button";

  // A local review note the reader has left on a line but not yet sent. Distinct
  // from DiffThreadComment, which renders an existing GitHub conversation pulled
  // from the host; this one is always the reader's own unsent draft. Mounted by
  // every diff panel (session diff, PR review guide, file preview), so it is the
  // one card shape they all share.
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

<!-- Same card as DiffThreadComment: the diff's light DOM is set in the code
     font, so the card restates the UI face and the Activity tab's card surface. -->
<div
  class="group relative mx-3 my-1.5 overflow-hidden rounded-xl border border-border bg-card px-3 py-2 font-[family-name:var(--solus-font-family)] text-xs leading-normal text-foreground"
  data-diff-line="{comment.side}:{comment.endLine}"
  data-comment-id={comment.id}
>
  <div class="flex items-center gap-2 text-muted-foreground">
    <span
      class="shrink-0 tabular-nums"
      style="font-family:var(--solus-code-font-family)"
    >
      {anchor}
    </span>
    {#if age}
      <span class="shrink-0">{age}</span>
    {/if}
    <!-- Revealed on focus-within for the keyboard, and simply at rest for a
         coarse pointer, which has no :hover and nothing to focus first. -->
    {#if onEdit || onDelete}
      <div
        class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
      >
        {#if onEdit}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            class="cursor-pointer font-medium text-muted-foreground"
            onclick={(e) => {
              e.stopPropagation();
              onEdit?.(comment);
            }}
          >
            Edit
          </Button>
        {/if}
        {#if onDelete}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            class="cursor-pointer font-medium text-muted-foreground hover:text-destructive"
            onclick={(e) => {
              e.stopPropagation();
              onDelete?.(comment.id);
            }}
          >
            Delete
          </Button>
        {/if}
      </div>
    {/if}
  </div>
  <p class="m-0 mt-1 text-pretty whitespace-pre-wrap">
    {comment.comment}
  </p>
</div>
