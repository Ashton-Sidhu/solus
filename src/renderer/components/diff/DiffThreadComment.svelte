<script lang="ts">
  import {
    CheckCircleIcon,
    ChatCircleIcon,
    ArrowBendUpLeftIcon,
    CaretDownIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { ReviewComment } from "../../../shared/providers";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { toasts } from "../../contexts";
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

  // Comment bodies are GitHub markdown — same pipeline as the Activity tab's
  // thread cards, scaled to the inline card's 12px type.
  const bodyProseClass =
    "github-markdown prose-cloud mt-0.5 text-[0.75rem] leading-relaxed text-(--solus-text-secondary) [--solus-font-weight-body:400] [&>:first-child]:mt-0 [&>:last-child]:mb-0";

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
      toasts.error(
        `Reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      toasts.error(
        `Couldn't update thread: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    <span class="text-[0.625rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
      {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
    </span>
    <div class="ml-auto flex items-center gap-1">
      {#if thread.isOutdated}
        <span class="rounded bg-(--solus-accent-light) px-1.5 py-0.5 text-[0.5625rem] font-semibold text-(--solus-text-tertiary)">
          Outdated
        </span>
      {/if}
      {#if thread.isResolved}
        <span
          class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold text-(--solus-art-positive)"
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
      <span class="text-[0.6875rem] font-medium text-(--solus-text-secondary)">
        Marked as resolved
      </span>
      <span class="ml-auto inline-flex items-center gap-1 text-[0.625rem] text-(--solus-text-tertiary)">
        Show thread
        <CaretDownIcon size={10} weight="bold" />
      </span>
    </button>
  {:else}
  <div class="flex flex-col gap-2 px-2.5 py-2">
    {#each thread.comments as comment (comment.id)}
      <div class="flex gap-2">
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full bg-(--solus-accent) text-[0.5rem] font-semibold text-(--solus-on-accent,#fff)"
        >
          {initials(comment.author)}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="text-[0.6875rem] font-semibold text-(--solus-text-primary)">{comment.author}</span>
            <span class="text-[0.625rem] text-(--solus-text-tertiary)">
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
        <div class="flex flex-col gap-1.5">
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
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
              onclick={startReply}
            >
              <ArrowBendUpLeftIcon size={12} /> Reply
            </button>
          {/if}
          {#if onToggleResolve}
            <button
              type="button"
              disabled={busy}
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
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
              class="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
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
