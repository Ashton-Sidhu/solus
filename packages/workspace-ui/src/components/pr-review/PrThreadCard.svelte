<script lang="ts">
  import {
    CircleCheck as CheckCircleIcon,
    Circle as CircleIcon,
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    ChevronUp as CaretUpIcon,
  } from "@lucide/svelte";
  import CommentMarkdown from '../github-markdown/CommentMarkdown.svelte';
  import { CommentComposer } from "../ui/comment-composer";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { Button } from "../ui/button";
  import {
    activityDiffPreview,
    diffLineCount,
    dirName,
    fileName,
    hunkToPatch,
    threadStartsFolded,
  } from "./lib/activity-data";
  import { nearViewport } from "../../lib/near-viewport";
  import { toasts } from "../../lib/toasts";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { ReviewThread, ReviewComment } from "@solus/contracts/providers";

  // One review thread in the activity timeline: anchored diff hunk, stacked
  // comments, reply / resolve. Mutates the shared thread object in place (the
  // Diff tab renders the same objects) — the host only supplies the RPCs.
  let {
    thread,
    fullDiffHunk,
    unfolded = $bindable(false),
    onJump,
    onReply,
    onResolve,
  }: {
    thread: ReviewThread;
    /** Complete containing hunk from the PR patch, when it has loaded. */
    fullDiffHunk?: string;
    /** A resolved or outdated thread folds to one line (hiding its diff hunk
     *  and conversation), as GitHub folds them. True while the reader has
     *  opened it; resolving folds it again. Bindable because the timeline row
     *  takes a different shape for each state. */
    unfolded?: boolean;
    /** Jump to the thread's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  const firstComment = $derived(thread.comments[0]);
  const statusLabel = $derived(
    `${thread.isResolved ? "Resolved" : "Open"} · ${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`,
  );
  const diffHunk = $derived(fullDiffHunk ?? firstComment?.diffHunk);

  let replying = $state(false);
  let replyText = $state("");
  let busy = $state(false);
  const startsFolded = $derived(threadStartsFolded(thread));
  const collapsed = $derived(startsFolded && !unfolded);
  let diffOpen = $state(true);
  // The diff engine is the heaviest thing on the card, so it mounts the first
  // time the card comes near the viewport. A long timeline then builds the
  // diffs the reader reaches, not one per open thread.
  let diffNearViewport = $state(false);
  let diffBeforeExpanded = $state(false);
  let diffAfterExpanded = $state(false);
  const collapsedDiffPreview = $derived(
    diffHunk
      ? activityDiffPreview(diffHunk, thread.line, thread.side)
      : null,
  );
  const visibleDiffPreview = $derived(
    diffHunk
      ? activityDiffPreview(
          diffHunk,
          thread.line,
          thread.side,
          diffBeforeExpanded,
          diffAfterExpanded,
        )
      : null,
  );

  function cancelReply() {
    replying = false;
    replyText = "";
  }

  async function submitReply(body: string) {
    if (!body || busy) return;
    busy = true;
    try {
      const comment = await onReply(thread.id, body);
      thread.comments.push(comment);
      cancelReply();
    } catch (err) {
      toasts.error("Reply failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
  }

  async function toggleResolved() {
    busy = true;
    try {
      await onResolve(thread.id, !thread.isResolved);
      thread.isResolved = !thread.isResolved;
      if (thread.isResolved) unfolded = false;
    } catch (err) {
      toasts.error("Couldn't update thread", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
  }

  function toggleDiff() {
    diffOpen = !diffOpen;
    requestInputFocus();
  }

</script>

{#if collapsed}
  <!-- A resolved or outdated thread is not the open question on the page: one
       prose line on the spine in the same voice as a commit row (the spine
       node carries its state), so a run of them reads as a list rather than a
       stack of cards. The row opens the full card. -->
  <button
    type="button"
    class="group/resolved flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pt-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    onclick={() => (unfolded = true)}
    aria-expanded="false"
  >
    <span class="min-w-0 flex-1 truncate">
      <span class="font-medium text-foreground">{firstComment?.author}</span>
      commented on
      <span class="text-foreground">{fileName(thread.filePath)}{thread.line !== null ? `:${thread.line}` : ""}</span>
      {#if thread.isResolved}· resolved{/if}{#if thread.isOutdated} · outdated{/if}{#if firstComment}
        · {formatTimeAgoFromTimestamp(new Date(firstComment.createdAt).getTime())}{/if}
    </span>
    <span
      class="inline-flex shrink-0 items-center gap-1 text-xs opacity-0 transition-opacity group-hover/resolved:opacity-100 group-focus-visible/resolved:opacity-100 pointer-coarse:opacity-100"
    >
      Show thread
      <CaretDownIcon size={12} weight="bold" />
    </span>
  </button>
{:else}
<!-- The same card as a thread in the Diff tab (DiffThreadComment), with the
     anchored file and hunk as its head. -->
<div
  class="overflow-hidden rounded-xl border border-border/70 bg-background text-sm shadow-sm"
>
  <div
    class="flex items-center gap-2 border-b border-border/60 px-2 py-1"
  >
    {#if diffHunk}
      <Button
        type="button"
        variant="ghost"
        class="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground after:absolute after:size-10 hover:bg-muted hover:text-foreground"
        aria-expanded={diffOpen}
        aria-label={diffOpen
          ? `Collapse diff for ${fileName(thread.filePath)}`
          : `Expand diff for ${fileName(thread.filePath)}`}
        title={diffOpen ? "Collapse diff" : "Expand diff"}
        onclick={toggleDiff}
      >
        {#if diffOpen}
          <CaretDownIcon size={14} weight="bold" />
        {:else}
          <CaretRightIcon size={14} weight="bold" />
        {/if}
      </Button>
    {/if}
    <Button
      type="button"
      variant="ghost"
      class="min-h-10 min-w-0 flex-1 justify-start cursor-pointer truncate rounded-md text-left  text-foreground hover:text-primary"
      onclick={() => onJump?.(thread.filePath, thread.line)}
    >
      <span class="text-muted-foreground">{dirName(thread.filePath)}</span>{fileName(thread.filePath)}{thread.line !== null ? `:${thread.line}` : ""}
    </Button>
  </div>

    <!-- The diff GitHub anchored the thread to (first comment's hunk),
         rendered through the same @pierre/diffs engine as the Diff tab. -->
    {#if diffHunk && diffOpen}
      <div class="border-b border-border/60">
        {#if collapsedDiffPreview && collapsedDiffPreview.hiddenBeforeLineCount > 0}
          <div class="flex min-h-8 items-center gap-2 px-3 py-1">
            <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
            <Button
              type="button"
              variant="ghost"
              class="relative h-6 cursor-pointer rounded-md py-1 pr-2.5 pl-1.5 text-review-control text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
              aria-expanded={diffBeforeExpanded}
              onclick={() => (diffBeforeExpanded = !diffBeforeExpanded)}
            >
              <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
              {#if diffBeforeExpanded}
                <CaretDownIcon size={14} /> Collapse earlier lines
              {:else}
                <CaretUpIcon size={14} /> Show {collapsedDiffPreview.hiddenBeforeLineCount} earlier {collapsedDiffPreview.hiddenBeforeLineCount === 1 ? "line" : "lines"}
              {/if}
            </Button>
            <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
          </div>
        {/if}
        {#if diffNearViewport}
          <GuideFileDiff
            patch={hunkToPatch(
              thread.filePath,
              visibleDiffPreview?.hunk ?? diffHunk,
            )}
            filePath={thread.filePath}
            hunkSeparators="simple"
          />
        {:else}
          <!-- Holds about the diff's height so the page does not jump when
               it mounts. -->
          <div
            class="h-[calc(var(--lines)*1.25rem+0.5rem)]"
            style:--lines={diffLineCount(visibleDiffPreview?.hunk ?? diffHunk)}
            aria-hidden="true"
            use:nearViewport={() => (diffNearViewport = true)}
          ></div>
        {/if}
        {#if collapsedDiffPreview && collapsedDiffPreview.hiddenAfterLineCount > 0}
          <div class="flex min-h-8 items-center gap-2 px-3 py-1">
            <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
            <Button
              type="button"
              variant="ghost"
              class="relative h-6 cursor-pointer rounded-md py-1 pr-1.5 pl-2.5 text-review-control text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
              aria-expanded={diffAfterExpanded}
              onclick={() => (diffAfterExpanded = !diffAfterExpanded)}
            >
              <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
              {#if diffAfterExpanded}
                Collapse later lines <CaretUpIcon size={14} />
              {:else}
                Show {collapsedDiffPreview.hiddenAfterLineCount} later {collapsedDiffPreview.hiddenAfterLineCount === 1 ? "line" : "lines"} <CaretDownIcon size={14} />
              {/if}
            </Button>
            <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
          </div>
        {/if}
      </div>
    {/if}

    <div class="p-3">
      <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {#if thread.isResolved}
          <CheckCircleIcon class="size-3.5 shrink-0 text-(--solus-art-positive)" />
        {:else}
          <CircleIcon class="size-3.5 shrink-0" />
        {/if}
        <!-- A thread that folds by default folds again from its status. -->
        {#if startsFolded}
          <button
            type="button"
            class="cursor-pointer rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-expanded="true"
            onclick={() => (unfolded = false)}
          >
            {statusLabel}
          </button>
        {:else}
          <span>{statusLabel}</span>
        {/if}
        {#if thread.isOutdated}
          <span>outdated</span>
        {/if}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          class="ml-auto cursor-pointer"
          onclick={toggleResolved}
        >
          {thread.isResolved ? "Unresolve" : "Resolve"}
        </Button>
      </div>

      <!-- Each comment hangs from an avatar in a gutter, with a hairline
           between comments: a long bot comment otherwise runs into the next
           author's row, and the thread reads as one message. -->
      <div class="mt-3 divide-y divide-border/60">
        {#each thread.comments as comment (comment.id)}
          <article class="flex min-w-0 gap-2.5 py-3 first:pt-0 last:pb-1">
            <span class="mt-px shrink-0">
              <PrAvatar
                name={comment.author}
                url={comment.authorAvatarUrl}
                size="size-6 text-[10px]"
              />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                <span class="truncate text-sm font-semibold text-foreground">{comment.author}</span>
                <span class="shrink-0">
                  {formatTimeAgoFromTimestamp(new Date(comment.createdAt).getTime())}
                </span>
              </div>
              <div class="mt-0.5">
                <CommentMarkdown source={comment.body} />
              </div>
            </div>
          </article>
        {/each}
      </div>

      <!-- Reply aligns with the comment bodies, past the avatar gutter. -->
      {#if replying}
        <!-- Forced 400 weight so typed text never reads bold. -->
        <CommentComposer
          surface="embedded"
          class="mt-2 pl-8.5"
          initialValue={replyText}
          onFormValueChange={(markdown) => (replyText = markdown)}
          onSave={submitReply}
          onCancel={cancelReply}
          submitLabel={busy ? "Replying…" : "Reply"}
          disabled={busy}
          maxHeight={140}
          placeholder="Reply"
          ariaLabel="Reply to this conversation"
          editorClass="min-h-16 rounded-lg border border-input bg-background px-2.5 py-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32 [&_.cm-content]:![font-weight:400]"
        />
      {:else}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          class="mt-2 ml-6.5 cursor-pointer"
          onclick={() => (replying = true)}
        >
          Reply
        </Button>
      {/if}
    </div>
</div>
{/if}
