<script lang="ts">
  import { FileText } from "@lucide/svelte";
  import { reviewCommentLocation, type ReviewInlineComment } from "@solus/contracts/review-comment";
  import { requestFilePreview } from "../../lib/filePreview";
  import CodeBlock from "../ui/CodeBlock.svelte";

  let { comment, tabId }: { comment: ReviewInlineComment; tabId?: string } = $props();
</script>

<div class="my-2 w-full overflow-hidden rounded-2xl border border-border bg-card" data-testid="review-comment-card">
  <button
    type="button"
    aria-label={`Open ${comment.filePath}, ${comment.rangeLabel}`}
    onclick={() => requestFilePreview({ ...reviewCommentLocation(comment), tabId })}
    class="flex w-full items-center gap-2 overflow-hidden border-b border-border px-3 py-2 text-left hover:bg-muted"
  >
    <span class="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-muted text-muted-foreground">
      <FileText size={13} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate font-mono text-xs text-foreground">{comment.filePath}</span>
      <span class="block text-xs text-muted-foreground">{comment.sectionTitle} · {comment.rangeLabel}</span>
    </span>
  </button>
  {#if comment.text}
    <div class="whitespace-pre-wrap px-3 py-3 text-base leading-snug text-foreground">{comment.text}</div>
  {/if}
  {#if comment.diff.trim()}
    <div class="max-h-90 overflow-auto border-t border-border">
      <CodeBlock showHeader={false} text={comment.diff} lang={comment.fenceLanguage} />
    </div>
  {/if}
</div>
