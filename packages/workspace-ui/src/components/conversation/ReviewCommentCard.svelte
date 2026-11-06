<script lang="ts">
  import { MessageSquare } from "@lucide/svelte";
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { reviewCommentLocation, type ReviewInlineComment } from "@solus/contracts/review-comment";
  import { requestFilePreview } from "../../lib/filePreview";
  import CodeBlock from "../ui/CodeBlock.svelte";

  let { comment, tabId }: { comment: ReviewInlineComment; tabId?: string } = $props();
</script>

<!-- The diff panel's file card: its code surface, and the comment
     anchored under the lines it is about, as the diff stream shows it. -->
<div
  class="my-2 w-full overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)"
  data-testid="review-comment-card"
>
  <button
    type="button"
    aria-label={`Open ${comment.filePath}, ${comment.rangeLabel}`}
    onclick={() => requestFilePreview({ ...reviewCommentLocation(comment), tabId })}
    class="flex w-full items-center gap-2 overflow-hidden border-b border-(--solus-art-border) px-3 py-2 text-left hover:bg-muted"
  >
    <span class="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-muted text-muted-foreground">
      <FileIcon path={comment.filePath} size={13} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate font-mono text-xs text-foreground">{comment.filePath}</span>
      <span class="block text-xs text-muted-foreground">{comment.sectionTitle} · {comment.rangeLabel}</span>
    </span>
  </button>
  <div class="bg-(--solus-diff-surface)">
    {#if comment.diff.trim()}
      <div class="max-h-90 overflow-auto [&_.solus-code-block]:!bg-transparent">
        <CodeBlock showHeader={false} text={comment.diff} lang={comment.fenceLanguage} />
      </div>
    {/if}
    {#if comment.text}
      <div class="px-3 pb-3" class:pt-3={!comment.diff.trim()}>
        <div class="rounded-xl border border-border/70 bg-background p-3 text-sm text-foreground shadow-sm">
          <MessageSquare class="float-left mt-1 mr-2 size-3.5 text-muted-foreground" aria-hidden="true" />
          <p class="m-0 leading-relaxed text-pretty whitespace-pre-wrap">{comment.text}</p>
        </div>
      </div>
    {/if}
  </div>
</div>
