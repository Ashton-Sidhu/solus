<script lang="ts">
  import {
    CheckCircleIcon,
    CaretDownIcon,
    CaretRightIcon,
    ArrowBendUpLeftIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { Button } from "../ui/button";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { hunkToPatch, fileName, dirName } from "./lib/activity-data";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { toasts } from "../../contexts";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { ReviewThread, ReviewComment } from "../../../shared/providers";

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

  // Comment bodies are GitHub markdown — same pipeline + prose scale as the
  // activity timeline's conversation rows.
  const bodyProseClass =
    "github-markdown prose-cloud text-[0.8125rem] leading-relaxed text-(--solus-text-secondary) [--solus-font-weight-body:400] [&>:first-child]:mt-0 [&>:last-child]:mb-0";

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
    "rounded-lg border border-(--solus-art-border) bg-transparent px-2.5 transition-colors focus-within:border-(--solus-accent) [&_.solus-md-editor_.ProseMirror]:![min-height:2.5rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![left:0.875rem]";

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
      toasts.error(
        `Reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      toasts.error(
        `Couldn't update thread: ${err instanceof Error ? err.message : String(err)}`,
      );
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

<div class="overflow-hidden rounded-xl bg-(--solus-art-surface) shadow-[0_0_0_1px_var(--solus-art-border)]">
  <div class="flex items-center gap-2 border-b border-(--solus-art-border) px-3 py-2">
    {#if diffHunk && !collapsed}
      <Button
        type="button"
        variant="ghost"
        class="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[color,background-color,scale] duration-150 ease-out after:absolute after:size-10 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
        aria-expanded={diffOpen}
        aria-label={diffOpen
          ? `Collapse diff for ${fileName(thread.filePath)}`
          : `Expand diff for ${fileName(thread.filePath)}`}
        title={diffOpen ? "Collapse diff" : "Expand diff"}
        onclick={toggleDiff}
      >
        {#if diffOpen}
          <CaretDownIcon size={13} weight="bold" />
        {:else}
          <CaretRightIcon size={13} weight="bold" />
        {/if}
      </Button>
    {/if}
    <Button
      type="button"
      variant="ghost"
      class="min-h-10 min-w-0 flex-1 justify-start cursor-pointer truncate rounded-md text-left font-mono text-[0.75rem] text-(--solus-text-secondary) transition-[color,scale] duration-150 ease-out hover:text-(--solus-accent) active:scale-[0.96]"
      onclick={() => onJump?.(thread.filePath, thread.line)}
    >
      <span class="text-(--solus-text-tertiary)">{dirName(thread.filePath)}</span>{fileName(thread.filePath)}{thread.line !== null ? `:${thread.line}` : ""}
    </Button>
    {#if thread.isOutdated}
      <span class="shrink-0 rounded-full bg-(--solus-art-raised) px-1.5 py-0.5 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
        >Outdated</span
      >
    {/if}
    {#if thread.isResolved}
      <span
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium text-(--solus-art-positive)"
      >
        <CheckCircleIcon size={11} weight="fill" class="shrink-0" /> Resolved
      </span>
    {/if}
  </div>

  {#if collapsed}
    <Button
      type="button"
      variant="ghost"
      class="flex min-h-10 w-full justify-start cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left transition-[background-color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) active:scale-[0.96]"
      onclick={() => (showResolved = true)}
      aria-expanded="false"
    >
      <CheckCircleIcon size={13} weight="fill" class="shrink-0 text-(--solus-art-positive)" />
      <span class="text-[0.8125rem] font-medium text-(--solus-text-secondary)">
        Marked as resolved
      </span>
      <span class="ml-auto inline-flex items-center gap-1 text-xs text-(--solus-text-tertiary)">
        Show thread
        <CaretDownIcon size={11} weight="bold" />
      </span>
    </Button>
  {:else}
    <!-- The diff GitHub anchored the thread to (first comment's hunk),
         rendered through the same @pierre/diffs engine as the Diff tab. -->
    {#if diffHunk && diffOpen}
      <div class="border-b border-(--solus-art-border)">
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
            <PrAvatar name={comment.author} size="size-6 text-[0.625rem]" />
            {#if ci < thread.comments.length - 1}
              <span class="mt-1 w-px flex-1 bg-(--solus-art-border)"></span>
            {/if}
          </div>
          <div class="min-w-0 flex-1 pb-3">
            <div class="mb-0.5 flex items-baseline gap-1.5 text-[0.75rem]">
              <span class="font-semibold text-(--solus-text-primary)">{comment.author}</span>
              <span class="text-(--solus-text-tertiary)"
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
          <MarkdownEditor
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
              class="min-h-10 cursor-pointer rounded-lg px-3 text-xs font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
              onclick={cancelReply}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || !replyText.trim()}
              class="min-h-10 cursor-pointer rounded-lg bg-(--solus-accent) px-3 text-xs font-semibold text-(--solus-on-accent,#fff) transition-[opacity,scale] duration-150 ease-out hover:opacity-90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
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
            class="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg py-1 pr-3 pl-2.5 text-xs font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
            onclick={() => (replying = true)}
          >
            <ArrowBendUpLeftIcon size={13} class="shrink-0" /> Reply
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            class="inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
            onclick={toggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
          {#if thread.isResolved}
            <Button
              type="button"
              variant="ghost"
              class="ml-auto inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
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
