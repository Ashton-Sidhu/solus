<script lang="ts">
  import {
    CheckCircleIcon,
    CaretDownIcon,
    CaretRightIcon,
    ArrowBendUpLeftIcon,
  } from "phosphor-svelte";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import { hunkToPatch, fileName, dirName } from "./lib/activity-data";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
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

<div class="overflow-hidden rounded-xl border border-(--solus-art-border) bg-white dark:bg-white/3">
  <div class="flex items-center gap-2 border-b border-(--solus-art-border) px-3 py-2">
    {#if diffHunk && !collapsed}
      <button
        type="button"
        class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[color,background-color,scale] duration-150 ease-out hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) active:scale-[0.92]"
        aria-expanded={diffOpen}
        aria-label={diffOpen
          ? `Collapse diff for ${fileName(thread.filePath)}`
          : `Expand diff for ${fileName(thread.filePath)}`}
        use:tooltip={diffOpen ? "Collapse diff" : "Expand diff"}
        onclick={toggleDiff}
      >
        {#if diffOpen}
          <CaretDownIcon size={13} weight="bold" />
        {:else}
          <CaretRightIcon size={13} weight="bold" />
        {/if}
      </button>
    {/if}
    <button
      type="button"
      class="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-accent)"
      onclick={() => onJump?.(thread.filePath, thread.line)}
    >
      <span class="text-(--solus-text-tertiary)">{dirName(thread.filePath)}</span>{fileName(thread.filePath)}{thread.line !== null ? `:${thread.line}` : ""}
    </button>
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
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-(--solus-accent-light)"
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
    </button>
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
            <p class="text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-(--solus-text-secondary)">
              {comment.body}
            </p>
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
            <button
              type="button"
              class="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
              onclick={cancelReply}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !replyText.trim()}
              class="cursor-pointer rounded-md bg-(--solus-accent) px-2.5 py-1 text-xs font-semibold text-(--solus-on-accent,#fff) hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onclick={submitReply}
            >
              {busy ? "Replying…" : "Reply"}
            </button>
          </div>
        </div>
      {:else}
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 pl-1.5 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
            onclick={() => (replying = true)}
          >
            <ArrowBendUpLeftIcon size={13} class="shrink-0" /> Reply
          </button>
          <button
            type="button"
            disabled={busy}
            class="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) disabled:cursor-not-allowed disabled:opacity-50"
            onclick={toggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </button>
          {#if thread.isResolved}
            <button
              type="button"
              class="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
              onclick={() => (showResolved = false)}
            >
              Hide
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
