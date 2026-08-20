<script lang="ts">
  import {
    CircleCheck as CheckCircleIcon,
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    CornerUpLeft as ArrowBendUpLeftIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CommentEditor } from "../ui/comment-editor";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { Button } from "../ui/button";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { hunkToPatch, fileName, dirName } from "./lib/activity-data";
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
    onJump,
    onReply,
    onResolve,
  }: {
    thread: ReviewThread;
    /** Jump to the thread's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  const diffHunk = $derived(thread.comments[0]?.diffHunk);

  // Comment bodies are GitHub markdown — same pipeline + `.prose-pr`
  // typography as the PR description and the timeline's conversation rows.
  const bodyProseClass = "github-markdown prose-cloud prose-pr";

  let replying = $state(false);
  let replyText = $state("");
  let busy = $state(false);
  // A resolved thread collapses to a "Marked as resolved" bar (hiding its diff
  // hunk + conversation), matching the inline Diff tab. This tracks whether the
  // user re-expanded it; always re-collapses on resolve.
  let showResolved = $state(false);
  const collapsed = $derived(thread.isResolved && !showResolved);
  let diffOpen = $state(true);

  // Markdown reply input styled like the message composer: forced 400 weight so
  // typed text never reads bold; bordered transparent field.
  const replyFieldClass =
    "rounded-lg border border-input bg-card px-2.5 transition-colors focus-within:border-ring [&_.cm-content]:![min-height:2.5rem] [&_.cm-content]:![padding:0.5rem_0] [&_.cm-content]:![font-weight:400]";

  function cancelReply() {
    replying = false;
    replyText = "";
  }

  async function submitReply() {
    const body = replyText.trim();
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

  // Match the composer's affordances: ⌘↵ sends, Esc discards the reply.
  function onReplyKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submitReply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelReply();
    }
  }
</script>

<div class="text-xs overflow-hidden rounded-2xl border border-border bg-card">
  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
    {#if diffHunk && !collapsed}
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

  {#if collapsed}
    <Button
      type="button"
      variant="ghost"
      class="flex min-h-10 w-full justify-start cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left hover:bg-muted"
      onclick={() => (showResolved = true)}
      aria-expanded="false"
    >
      <CheckCircleIcon size={20} weight="fill" class="shrink-0 text-(--solus-art-positive)" />
      <span class="text-sm font-medium text-foreground">
        Marked as resolved
      </span>
      <span class="ml-auto inline-flex items-center gap-1  text-muted-foreground">
        Show thread
        <CaretDownIcon size={14} weight="bold" />
      </span>
    </Button>
  {:else}
    <!-- The diff GitHub anchored the thread to (first comment's hunk),
         rendered through the same @pierre/diffs engine as the Diff tab. -->
    {#if diffHunk && diffOpen}
      <div class="border-b border-border">
        <GuideFileDiff
          patch={hunkToPatch(thread.filePath, diffHunk)}
          filePath={thread.filePath}
        />
      </div>
    {/if}

    <div class="flex flex-col px-3 py-2.5">
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
        <div class="flex flex-col gap-1.5">
          <CommentEditor
            value={replyText}
            onValueChange={(md) => (replyText = md)}
            onKeyDown={onReplyKey}
            enterInsertsNewline
            hidePlaceholderOnFocus
            maxHeight={140}
            placeholder="Reply…"
            class={replyFieldClass}
          />
          <div class="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              class="min-h-10 cursor-pointer rounded-lg px-3  font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onclick={cancelReply}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || !replyText.trim()}
              class="h-[30px] cursor-pointer rounded-lg border-0 bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              onclick={submitReply}
            >
              {busy ? "Replying…" : "Reply"}
            </Button>
          </div>
        </div>
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
  {/if}
</div>
