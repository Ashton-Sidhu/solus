<script lang="ts">
  import { MessageSquare, Pencil, Trash2 } from "@lucide/svelte";
  import type { DiffComment } from "@solus/contracts/types";
  import { Button } from "../ui/button";

  // A local review note the reader has left on a line but not yet sent. Distinct
  // from DiffThreadComment, which renders an existing GitHub conversation pulled
  // from the host; this one is always the reader's own unsent draft. Mounted by
  // every diff panel (session diff, PR review guide, file preview), so it is the
  // one card shape they all share.
  interface Props {
    comment: DiffComment;
    /** Where the note goes when it leaves: a PR review draft is posted with
     *  the review; a session note rides along with the next prompt. */
    sendsWith?: "review" | "message";
    onEdit?: (c: DiffComment) => void;
    onDelete?: (id: string) => void;
  }

  let { comment, sendsWith = "message", onEdit, onDelete }: Props = $props();
</script>

<!-- The same card as a posted thread (DiffThreadComment), dashed because it is
     not sent yet. The diff's light DOM is set in the code font, so the card
     restates the UI face. -->
<div
  class="mx-3 my-2 rounded-xl border border-dashed border-border/70 bg-background p-3 font-[family-name:var(--solus-font-family)] text-sm text-foreground shadow-sm"
  data-diff-line="{comment.side}:{comment.endLine}"
  data-comment-id={comment.id}
>
  <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    <MessageSquare class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="min-w-0 truncate">
      Pending — {sendsWith === "review" ? "sent when you submit the review" : "sent with your next message"}
    </span>
    {#if onEdit || onDelete}
      <span class="-my-1 ml-auto flex shrink-0 items-center">
        {#if onEdit}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            class="cursor-pointer text-muted-foreground"
            aria-label="Edit comment"
            onclick={(e) => {
              e.stopPropagation();
              onEdit?.(comment);
            }}
          >
            <Pencil class="size-3.5" />
          </Button>
        {/if}
        {#if onDelete}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            class="cursor-pointer text-muted-foreground hover:text-destructive"
            aria-label="Discard this comment"
            onclick={(e) => {
              e.stopPropagation();
              onDelete?.(comment.id);
            }}
          >
            <Trash2 class="size-3.5" />
          </Button>
        {/if}
      </span>
    {/if}
  </div>
  <p class="m-0 mt-2 leading-relaxed text-pretty whitespace-pre-wrap">
    {comment.comment}
  </p>
</div>
