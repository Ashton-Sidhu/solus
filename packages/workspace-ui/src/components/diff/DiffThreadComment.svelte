<script lang="ts">
  import {
    CircleCheck as CheckCircleIcon,
    MessageCircle as ChatCircleIcon,
    CornerUpLeft as ArrowBendUpLeftIcon,
    ChevronDown as CaretDownIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { ReviewComment } from "@solus/contracts/providers";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { toasts } from "../../lib/toasts";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { MarkdownTextarea } from "../ui/markdown-field";
  import { Button } from "../ui/button";
  import SinceReviewMarker from "../pr-review/SinceReviewMarker.svelte";
  import type { DiffReviewThread } from "./lib/interdiff-annotations";

  // A GitHub PR review thread rendered inline in the diff, anchored at its line.
  // Distinct from DiffInlineComment (an editable local draft): this is an existing
  // conversation pulled from the host — author(s), body, resolved/outdated state.
  // When reply/resolve callbacks are supplied (PR review surface) it gains the
  // same reply + resolve affordances as the Activity tab, mutating the shared
  // thread object so both surfaces stay in sync.
  let {
    thread,
    collapsed = false,
    onReply,
    onToggleResolve,
    onSetCollapsed,
  }: {
    thread: DiffReviewThread;
    /** Whether the resolved thread is collapsed to its summary bar. Owned by the
     *  host (DiffStream) so toggling re-measures the diff layout, and so the
     *  state survives the annotation remount that re-measure triggers. */
    collapsed?: boolean;
    onReply?: (threadId: string, body: string) => Promise<ReviewComment>;
    onToggleResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onSetCollapsed?: (threadId: string, collapsed: boolean) => void;
  } = $props();

  const interactive = $derived(!!onReply || !!onToggleResolve);

  // Comment bodies are GitHub markdown — the same `.prose-pr` typography as the
  // PR description and the Activity tab's thread cards, stepped down to this
  // card's 12px type by the compact modifier. Sizes/colour can't be set with
  // utilities here: the `.prose-cloud` rules are unlayered and win.
  const bodyProseClass =
    "github-markdown prose-cloud prose-pr prose-pr-compact mt-0.5";

  let replying = $state(false);
  let replyText = $state("");
  let replyEl = $state<HTMLTextAreaElement | null>(null);
  let busy = $state(false);

  function initials(name: string): string {
    return (name.slice(0, 2) || "?").toUpperCase();
  }

  function startReply() {
    replying = true;
    replyText = "";
    setTimeout(() => replyEl?.focus(), 30);
  }

  function cancelReply() {
    replying = false;
    replyText = "";
  }

  async function submitReply() {
    const body = replyText.trim();
    if (!body || busy || !onReply) return;
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

  async function toggleResolve() {
    if (busy || !onToggleResolve) return;
    const next = !thread.isResolved;
    busy = true;
    try {
      await onToggleResolve(thread.id, next);
      thread.isResolved = next;
      // Collapse on resolve, re-open on unresolve. Routed through the host so the
      // diff re-measures and reflows around the changed annotation height.
      onSetCollapsed?.(thread.id, next);
    } catch (err) {
      toasts.error("Couldn't update thread", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
  }
</script>

{#if thread.reviewContext === "interdiff-match"}
  <SinceReviewMarker {thread} />
{:else}
<div
  class="mx-3 my-1.5 overflow-hidden rounded-lg border-l-[0.1875rem] border-(--solus-accent) bg-(--solus-popover-bg) shadow-[0_0_0_0.0625rem_var(--solus-container-border)]"
>
  <div class="flex items-center gap-1.5 border-b border-(--solus-container-border) px-2.5 py-1.5">
    <ChatCircleIcon size={12} weight="fill" class="shrink-0 text-(--solus-text-tertiary)" />
    <span class="text-xs font-medium text-(--solus-text-tertiary) uppercase">
      {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
    </span>
    <div class="ml-auto flex items-center gap-1">
      {#if thread.isOutdated}
        <span class="rounded bg-(--solus-accent-light) px-1.5 py-0.5 text-xs font-medium text-(--solus-text-tertiary)">
          Outdated
        </span>
      {/if}
      {#if thread.isResolved}
        <span
          class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-(--solus-art-positive)"
          style="background:color-mix(in srgb, var(--solus-art-positive) 16%, transparent)"
        >
          <CheckCircleIcon size={10} weight="fill" /> Resolved
        </span>
      {/if}
    </div>
  </div>

  {#if thread.isResolved && collapsed}
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-(--solus-surface-hover)"
      onclick={() => onSetCollapsed?.(thread.id, false)}
      aria-expanded="false"
    >
      <CheckCircleIcon size={13} weight="fill" class="shrink-0 text-(--solus-art-positive)" />
      <span class="text-xs font-medium text-(--solus-text-secondary)">
        Marked as resolved
      </span>
      <span class="ml-auto inline-flex items-center gap-1 text-xs text-(--solus-text-tertiary)">
        Show thread
        <CaretDownIcon size={10} weight="bold" />
      </span>
    </button>
  {:else}
  <div class="flex flex-col gap-2 px-2.5 py-2">
    {#each thread.comments as comment (comment.id)}
      <div class="flex gap-2">
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full bg-(--solus-accent) text-xs font-medium text-(--solus-on-accent,#fff)"
        >
          {initials(comment.author)}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="text-xs font-medium text-(--solus-text-primary)">{comment.author}</span>
            <span class="text-xs text-(--solus-text-tertiary)">
              {formatTimeAgoFromTimestamp(new Date(comment.createdAt).getTime())}
            </span>
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
  </div>

  {#if interactive}
    <div class="border-t border-(--solus-container-border) px-2.5 py-2">
      {#if replying}
        <!-- Bare field: the first line starts at the top edge, so the mic rides
             half of the `leading-4` below it. -->
        <div class="flex flex-col gap-1.5" style="--rc-mic-line-center:0.5rem">
          <MarkdownTextarea
            bind:ref={replyEl}
            bind:value={replyText}
            bare
            mic
            placeholder="Reply… ⌘↵"
            rows={1}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelReply();
              }
            }}
            onSubmit={submitReply}
            class="min-h-8 max-h-30 overflow-y-auto rounded-md border border-(--solus-container-border) bg-(--solus-input-pill-bg) pl-2"
          />
          <div class="flex items-center justify-end gap-1.5">
            <Button variant="ghost" size="sm" onclick={cancelReply} class="text-(--solus-text-tertiary)">
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !replyText.trim()} onclick={submitReply}>
              Reply
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center gap-1">
          {#if onReply}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
              onclick={startReply}
            >
              <ArrowBendUpLeftIcon size={12} /> Reply
            </button>
          {/if}
          {#if onToggleResolve}
            <button
              type="button"
              disabled={busy}
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
              onclick={toggleResolve}
            >
              {#if thread.isResolved}
                Unresolve
              {:else}
                <CheckCircleIcon size={12} /> Resolve
              {/if}
            </button>
          {/if}
          {#if thread.isResolved}
            <button
              type="button"
              class="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
              onclick={() => onSetCollapsed?.(thread.id, true)}
            >
              Hide
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {/if}
</div>
{/if}
