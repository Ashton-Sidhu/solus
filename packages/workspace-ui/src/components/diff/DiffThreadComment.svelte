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
     *  state survives the annotation remount that re-measure triggers. */
    collapsed?: boolean;
    onReply?: (threadId: string, body: string) => Promise<ReviewComment>;
    onToggleResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onSetCollapsed?: (threadId: string, collapsed: boolean) => void;
  } = $props();

  const interactive = $derived(!!onReply || !!onToggleResolve);
  const firstComment = $derived(thread.comments[0]);

  // Comment bodies are GitHub markdown — the same `.prose-pr` typography as the
  // PR description and the Activity tab's thread cards, stepped down to this
  // card's 12px type by the compact modifier. Sizes/colour can't be set with
  // utilities here: the `.prose-cloud` rules are unlayered and win.
  const bodyProseClass =
    "github-markdown prose-cloud prose-pr prose-pr-compact";

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
     Conversation is prose, so the card restates the UI face and reads at the
     same 12px the Activity tab's thread cards use on a laptop display. -->
<div
  class="mx-3 my-1.5 overflow-hidden rounded-xl border border-border bg-card font-[family-name:var(--solus-font-family)] text-xs leading-normal text-foreground"
>
  {#if thread.isResolved && collapsed}
    <!-- A resolved thread is a settled fact: one line, in the voice of a
         commit row, that opens the full card. -->
    <button
      type="button"
      class="group/resolved flex min-h-8 w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      onclick={() => onSetCollapsed?.(thread.id, false)}
      aria-expanded="false"
    >
      <CheckCircleIcon size={13} class="shrink-0 text-(--solus-art-positive)" />
      <span class="min-w-0 flex-1 truncate">
        <span class="font-medium text-foreground">{firstComment?.author}</span>
        commented · resolved{#if thread.isOutdated} · outdated{/if}{#if firstComment}
          · {formatTimeAgoFromTimestamp(new Date(firstComment.createdAt).getTime())}{/if}
      </span>
      <span
        class="inline-flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/resolved:opacity-100 group-focus-visible/resolved:opacity-100 pointer-coarse:opacity-100"
      >
        Show thread
        <CaretDownIcon size={12} />
      </span>
    </button>
  {:else}
    <div class="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-muted-foreground">
      <ChatCircleIcon size={12} class="shrink-0" />
      <span>
        {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
      </span>
      <div class="ml-auto flex items-center gap-1">
        {#if thread.isOutdated}
          <span class="rounded-full bg-muted px-1.5 py-0.5 font-medium">Outdated</span>
        {/if}
        {#if thread.isResolved}
          <span
            class="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] py-0.5 pr-1.5 pl-1 font-medium text-(--solus-art-positive)"
          >
            <CheckCircleIcon size={12} class="shrink-0" /> Resolved
          </span>
        {/if}
      </div>
    </div>

    <div class="flex flex-col px-3 pt-2.5 pb-1">
      {#each thread.comments as comment, ci (comment.id)}
        <div class="flex gap-2.5">
          <!-- Avatar + connector line linking stacked replies together -->
          <div class="flex flex-col items-center">
            <PrAvatar name={comment.author} url={comment.authorAvatarUrl} size="size-5 text-xs" />
            {#if ci < thread.comments.length - 1}
              <span class="mt-1 w-px flex-1 bg-border"></span>
            {/if}
          </div>
          <div class="min-w-0 flex-1 pb-2.5">
            <div class="mb-0.5 flex items-baseline gap-1.5">
              <span class="font-medium text-foreground">{comment.author}</span>
              <span class="text-muted-foreground">
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
      <div class="border-t border-border px-2 py-1.5">
        {#if replying}
          <CommentComposer
            surface="embedded"
            initialValue={replyText}
            onFormValueChange={(markdown) => (replyText = markdown)}
            onSave={submitReply}
            onCancel={cancelReply}
            submitLabel={busy ? "Replying…" : "Reply"}
            disabled={busy}
            placeholder="Reply… ⌘↵"
            maxHeight={120}
            editorClass="min-h-8 rounded-lg border border-input bg-card px-2.5 transition-colors focus-within:border-ring [&_.cm-content]:![font-weight:400]"
          />
        {:else}
          <div class="flex items-center gap-0.5">
            {#if onReply}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                class="cursor-pointer font-medium text-muted-foreground"
                onclick={startReply}
              >
                <ArrowBendUpLeftIcon size={12} class="shrink-0" /> Reply
              </Button>
            {/if}
            {#if onToggleResolve}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                class="cursor-pointer font-medium text-muted-foreground"
                onclick={toggleResolve}
              >
                {#if thread.isResolved}
                  Unresolve
                {:else}
                  <CheckCircleIcon size={12} class="shrink-0" /> Resolve
                {/if}
              </Button>
            {/if}
            {#if thread.isResolved}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                class="ml-auto cursor-pointer font-medium text-muted-foreground"
                onclick={() => onSetCollapsed?.(thread.id, true)}
              >
                Hide
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
{/if}
