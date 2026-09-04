<script lang="ts">
  import {
    CircleCheck as CheckCircleIcon,
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    ChevronUp as CaretUpIcon,
    CornerUpLeft as ArrowBendUpLeftIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CommentComposer } from "../ui/comment-composer";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { Button } from "../ui/button";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import {
    activityDiffPreview,
    dirName,
    fileName,
    hunkToPatch,
  } from "./lib/activity-data";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
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
    onJump,
    onReply,
    onResolve,
  }: {
    thread: ReviewThread;
    /** Complete containing hunk from the PR patch, when it has loaded. */
    fullDiffHunk?: string;
    /** Jump to the thread's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  const firstComment = $derived(thread.comments[0]);
  const diffHunk = $derived(fullDiffHunk ?? firstComment?.diffHunk);

  // Comment bodies are GitHub markdown — same pipeline + `.prose-pr`
  // typography as the PR description and the timeline's conversation rows.
  const bodyProseClass =
    "github-markdown prose-cloud prose-pr prose-pr-activity";

  let replying = $state(false);
  let replyText = $state("");
  let busy = $state(false);
  // A resolved thread collapses to a "Marked as resolved" bar (hiding its diff
  // hunk + conversation), matching the inline Diff tab. This tracks whether the
  // user re-expanded it; always re-collapses on resolve.
  let showResolved = $state(false);
  const collapsed = $derived(thread.isResolved && !showResolved);
  let diffOpen = $state(true);
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
      if (thread.isResolved) showResolved = false;
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
  <!-- A resolved thread is a settled fact, not an open surface: one prose line
       on the spine in the same voice as a commit row (the spine node already
       carries the green check), so a run of resolved threads reads as a list
       rather than a stack of empty cards. The row opens the full card. -->
  <button
    type="button"
    class="group/resolved flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pt-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    onclick={() => (showResolved = true)}
    aria-expanded="false"
  >
    <span class="min-w-0 flex-1 truncate">
      <span class="font-medium text-foreground">{firstComment?.author}</span>
      commented on
      <span class="text-foreground">{fileName(thread.filePath)}{thread.line !== null ? `:${thread.line}` : ""}</span>
      · resolved{#if thread.isOutdated} · outdated{/if}{#if firstComment}
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
<div
  class="overflow-hidden rounded-2xl border border-border bg-card [.is-laptop-display_&]:rounded-xl"
>
  <div
    class="flex items-center gap-2 border-b border-border px-3 py-2 [.is-laptop-display_&]:px-2.5 [.is-laptop-display_&]:py-1.5"
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
    {#if thread.isOutdated}
      <span class="shrink-0 rounded-full bg-muted px-1.5 py-0.5  font-medium text-muted-foreground"
        >Outdated</span
      >
    {/if}
    {#if thread.isResolved}
      <span
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] py-0.5 pr-1.5 pl-1  font-medium text-(--solus-art-positive)"
      >
        <CheckCircleIcon size={14} weight="fill" class="shrink-0" /> Resolved
      </span>
    {/if}
  </div>

    <!-- The diff GitHub anchored the thread to (first comment's hunk),
         rendered through the same @pierre/diffs engine as the Diff tab. -->
    {#if diffHunk && diffOpen}
      <div class="border-b border-border">
        {#if collapsedDiffPreview && collapsedDiffPreview.hiddenBeforeLineCount > 0}
          <div class="flex min-h-8 items-center gap-2 px-3 py-1 [.is-laptop-display_&]:px-2.5">
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
        <GuideFileDiff
          patch={hunkToPatch(
            thread.filePath,
            visibleDiffPreview?.hunk ?? diffHunk,
          )}
          filePath={thread.filePath}
          hunkSeparators="simple"
        />
        {#if collapsedDiffPreview && collapsedDiffPreview.hiddenAfterLineCount > 0}
          <div class="flex min-h-8 items-center gap-2 px-3 py-1 [.is-laptop-display_&]:px-2.5">
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

    <div
      class="flex flex-col px-3 py-2.5 [.is-laptop-display_&]:px-2.5 [.is-laptop-display_&]:py-2"
    >
      {#each thread.comments as comment, ci (comment.id)}
        <div class="flex gap-2.5">
          <!-- Avatar + connector line linking stacked replies together -->
          <div class="flex flex-col items-center">
            <PrAvatar
              name={comment.author}
              url={comment.authorAvatarUrl}
              size="size-6 "
            />
            {#if ci < thread.comments.length - 1}
              <span class="mt-1 w-px flex-1 bg-border"></span>
            {/if}
          </div>
          <div class="min-w-0 flex-1 pb-3">
            <div class="mb-0.5 flex items-baseline gap-1.5 ">
              <span class="font-medium text-foreground">{comment.author}</span>
              <span class="text-muted-foreground"
                >{formatTimeAgoFromTimestamp(new Date(comment.createdAt).getTime())}</span
              >
            </div>
            <div class={bodyProseClass}>
              <SvelteMarkdown
                source={comment.body}
                extensions={githubMarkdownExtensions}
                renderers={githubMarkdownRenderers}
                sanitizeUrl={remoteMarkdownSanitizeUrl}
              />
            </div>
          </div>
        </div>
      {/each}

      {#if replying}
        <!-- The reply field reads like the message composer: bordered
             transparent card, forced 400 weight so typed text never reads
             bold. -->
        <CommentComposer
          surface="embedded"
          initialValue={replyText}
          onFormValueChange={(markdown) => (replyText = markdown)}
          onSave={submitReply}
          onCancel={cancelReply}
          submitLabel={busy ? "Replying…" : "Reply"}
          disabled={busy}
          maxHeight={140}
          placeholder="Reply…"
          editorClass="rounded-lg border border-input bg-card px-2.5 transition-colors focus-within:border-ring [&_.cm-content]:![min-height:2.5rem] [&_.cm-content]:![padding:0.5rem_0] [&_.cm-content]:![font-weight:400]"
        />
      {:else}
        <div class="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            class="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg py-1 pr-3 pl-2.5  font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            onclick={() => (replying = true)}
          >
            <ArrowBendUpLeftIcon size={14} class="shrink-0" /> Reply
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            class="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg px-3 py-1  font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onclick={toggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
          {#if thread.isResolved}
            <Button
              type="button"
              variant="ghost"
              class="ml-auto inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg px-3 py-1  font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onclick={() => (showResolved = false)}
            >
              Hide
            </Button>
          {/if}
        </div>
      {/if}
    </div>
</div>
{/if}
