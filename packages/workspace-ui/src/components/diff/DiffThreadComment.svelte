<script lang="ts">
  import { CircleCheck as CheckCircleIcon, Circle as CircleIcon } from "@lucide/svelte";
  import GithubMarkdown from '../github-markdown/GithubMarkdown.svelte';
  import type { ReviewComment } from "@solus/contracts/providers";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import { CommentComposer } from "../ui/comment-composer";
  import { Button } from "../ui/button";
  import PrAvatar from "../prs/PrAvatar.svelte";
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
     *  state survives file recycling without remounting the comment. */
    collapsed?: boolean;
    onReply?: (threadId: string, body: string) => Promise<ReviewComment>;
    onToggleResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onSetCollapsed?: (threadId: string, collapsed: boolean) => void;
  } = $props();

  const statusLabel = $derived(
    `${thread.isResolved ? "Resolved" : "Open"} · ${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`,
  );

  let replying = $state(false);
  let replyText = $state("");
  let busy = $state(false);

  function startReply() {
    replying = true;
    replyText = "";
  }

  function cancelReply() {
    replying = false;
    replyText = "";
  }

  async function submitReply(body: string) {
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
<!-- The card sits inside the diff's light DOM, which is set in the code font.
     Conversation is prose, so the card restates the UI face. -->
<div
  class="mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 font-[family-name:var(--solus-font-family)] text-sm leading-normal text-foreground shadow-sm"
>
  <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    {#if thread.isResolved}
      <CheckCircleIcon class="size-3.5 shrink-0 text-(--solus-art-positive)" />
    {:else}
      <CircleIcon class="size-3.5 shrink-0" />
    {/if}
    <!-- Only a resolved thread folds; the host owns that state so the diff
         re-measures around the changed height. -->
    {#if thread.isResolved && onSetCollapsed}
      <button
        type="button"
        class="cursor-pointer rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-expanded={!collapsed}
        onclick={() => onSetCollapsed?.(thread.id, !collapsed)}
      >
        {statusLabel}
      </button>
    {:else}
      <span>{statusLabel}</span>
    {/if}
    {#if thread.isOutdated}
      <span>outdated</span>
    {/if}
    {#if onToggleResolve}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy}
        class="ml-auto cursor-pointer"
        onclick={toggleResolve}
      >
        {thread.isResolved ? "Unresolve" : "Resolve"}
      </Button>
    {/if}
  </div>

  {#if !(thread.isResolved && collapsed)}
    <!-- Each comment hangs from an avatar in a gutter, with a hairline between
         comments: a long bot comment otherwise runs into the next author's
         row, and the thread reads as one message. -->
    <div class="mt-3 divide-y divide-border/60">
      {#each thread.comments as comment (comment.id)}
        <article class="flex min-w-0 gap-2.5 py-3 first:pt-0 last:pb-1">
          <span class="mt-px shrink-0">
            <PrAvatar name={comment.author} url={comment.authorAvatarUrl} size="size-6 text-[10px]" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
              <span class="truncate text-sm font-semibold text-foreground">{comment.author}</span>
              <span class="shrink-0">
                {formatTimeAgoFromTimestamp(new Date(comment.createdAt).getTime())}
              </span>
            </div>
            <!-- GitHub markdown: the `.prose-pr` typography of the PR description,
                 stepped down by the compact modifier. The `.prose-cloud` rules are
                 unlayered, so utilities cannot size this body. -->
            <div class="mt-0.5 github-markdown prose-cloud prose-pr prose-pr-compact">
              <GithubMarkdown source={comment.body} />
            </div>
          </div>
        </article>
      {/each}
    </div>

    <!-- Reply aligns with the comment bodies, past the avatar gutter. -->
    {#if onReply}
      {#if replying}
        <CommentComposer
          surface="embedded"
          class="mt-2 pl-8.5"
          initialValue={replyText}
          onFormValueChange={(markdown) => (replyText = markdown)}
          onSave={submitReply}
          onCancel={cancelReply}
          submitLabel={busy ? "Replying…" : "Reply"}
          disabled={busy}
          placeholder="Reply"
          ariaLabel="Reply to this conversation"
          maxHeight={120}
          editorClass="min-h-16 rounded-lg border border-input bg-background px-2.5 py-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32 [&_.cm-content]:![font-weight:400]"
        />
      {:else}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          class="mt-2 ml-6.5 cursor-pointer"
          onclick={startReply}
        >
          Reply
        </Button>
      {/if}
    {/if}
  {/if}
</div>
{/if}
