<script lang="ts">
  import { X as CloseIcon, ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import type { ReviewLensComment } from "@solus/contracts/review";
  import { CommentComposer } from "../ui/comment-composer";
  import { Button } from "../ui/button";
  import {
    cardWidthFor,
    PIN_SIZE,
    pinFromPointer,
    placeCommentCard,
  } from "../artifact/lib/artifact-comments";

  /**
   * Lens comments over the render: the pins, the composer where a new pin was
   * dropped, and the card of the one open comment. A lens comment has no
   * replies; it has a way to the pull request instead (docs/plans/review-lenses.md).
   * The layer lets pointer events through to the render until the pin tool is
   * armed; then it takes the next click as a pin.
   */
  interface Props {
    comments: ReviewLensComment[];
    armed: boolean;
    draftPin: { x: number; y: number } | null;
    openCommentId: string | null;
    /** Absent on a target that is not a pull request. */
    pullRequest?: {
      canPost: boolean;
      postReason?: string;
      /** Why this comment cannot become a draft line comment, or null. */
      draftRefusal: (comment: ReviewLensComment) => string | null;
      /** False once the draft was sent with a review or removed in the diff. */
      hasDraft: (draftId: string) => boolean;
      /** The patch a line is checked against has loaded. */
      diffReady: boolean;
    };
    busy: boolean;
    onAdd: (pin: { x: number; y: number }, label: string, body: string) => void;
    onEdit: (commentId: string, body: string) => void;
    onResolve: (commentId: string, resolved: boolean) => void;
    onDelete: (commentId: string) => void;
    onPost: (commentId: string) => void;
    onRetract: (commentId: string) => void;
    onAddDraft: (commentId: string) => void;
    onRemoveDraft: (commentId: string) => void;
  }

  let {
    comments,
    armed = $bindable(false),
    draftPin = $bindable(null),
    openCommentId = $bindable(null),
    pullRequest,
    busy,
    onAdd,
    onEdit,
    onResolve,
    onDelete,
    onPost,
    onRetract,
    onAddDraft,
    onRemoveDraft,
  }: Props = $props();

  let layerEl = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  const box = $derived({ width, height });
  let cardHeight = $state(180);
  let composerHeight = $state(132);
  let editing = $state(false);
  let confirmingPost = $state(false);

  const openComment = $derived(
    openCommentId === null ? null : (comments.find((comment) => comment.id === openCommentId) ?? null),
  );
  const cardWidth = $derived(cardWidthFor(box));
  const cardPlacement = $derived(openComment ? placeCommentCard(openComment, cardHeight, box) : null);
  const composerPlacement = $derived(draftPin ? placeCommentCard({ pin: draftPin }, composerHeight, box) : null);
  const draftLabel = $derived(String(comments.length + 1));

  function handleLayerClick(event: MouseEvent) {
    if (!armed || !layerEl) return;
    if (event.target instanceof Element && event.target.closest("[data-lens-pin], [data-lens-card]")) return;
    draftPin = pinFromPointer(event.clientX, event.clientY, layerEl.getBoundingClientRect());
    openCommentId = null;
    armed = false;
  }

  function open(commentId: string) {
    draftPin = null;
    editing = false;
    confirmingPost = false;
    openCommentId = openCommentId === commentId ? null : commentId;
  }

  function close() {
    openCommentId = null;
    editing = false;
    confirmingPost = false;
  }

  export function layerRect(): DOMRect | null {
    return layerEl?.getBoundingClientRect() ?? null;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={layerEl}
  bind:clientWidth={width}
  bind:clientHeight={height}
  class="absolute inset-0 {armed ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}"
  data-testid="lens-comment-layer"
  data-armed={armed || undefined}
  onclick={handleLayerClick}
>
  {#each comments as comment, index (comment.id)}
    <button
      type="button"
      data-lens-pin
      class="pointer-events-auto absolute flex items-center justify-center rounded-full border-2 border-(--background) bg-(--solus-accent) text-[11px] font-semibold leading-none text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)] transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) pointer-coarse:text-xs"
      class:opacity-50={!!comment.resolvedAt}
      style="left:{comment.pin.x * width - PIN_SIZE / 2}px;top:{comment.pin.y * height - PIN_SIZE / 2}px;width:{PIN_SIZE}px;height:{PIN_SIZE}px"
      aria-label="Open comment {index + 1}: {comment.body}"
      title={comment.body}
      onclick={() => open(comment.id)}
    >
      {index + 1}
    </button>
  {/each}

  {#if draftPin && composerPlacement}
    <div
      data-lens-card
      class="pointer-events-auto absolute z-[8] drop-shadow-[0_1rem_2.375rem_rgba(60,40,25,0.42)]"
      style="left:{composerPlacement.left}px;top:{composerPlacement.top}px;width:{cardWidth}px"
      bind:clientHeight={composerHeight}
    >
      <CommentComposer
        anchorLabel="Pin {draftLabel}"
        onSave={(text) => {
          const pin = draftPin;
          if (pin) onAdd(pin, draftLabel, text);
          draftPin = null;
        }}
        onCancel={() => (draftPin = null)}
        placeholder="Comment on the lens…"
        submitOn="enter"
      />
    </div>
  {/if}

  {#if openComment && cardPlacement}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      data-lens-card
      role="dialog"
      aria-label="Lens comment"
      tabindex="-1"
      class="pointer-events-auto absolute z-[8] flex flex-col gap-2 rounded-2xl bg-(--solus-popover-bg) px-3 py-2.5 text-workspace-chrome shadow-[var(--solus-popover-shadow)]"
      style="left:{cardPlacement.left}px;top:{cardPlacement.top}px;width:{cardWidth}px"
      bind:clientHeight={cardHeight}
      onkeydown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
      data-testid="lens-comment-card"
    >
      <div class="flex min-w-0 items-center gap-1.5 text-xs text-(--solus-text-tertiary)">
        <span class="min-w-0 truncate" style="font-family:var(--solus-code-font-family)">
          {openComment.codeAnchor ? `${openComment.codeAnchor.path}:${openComment.codeAnchor.line}` : `Pin ${openComment.label}`}
        </span>
        <button
          type="button"
          class="ml-auto flex size-5 shrink-0 items-center justify-center rounded hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) pointer-coarse:size-10"
          aria-label="Close comment"
          onclick={close}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {#if openComment.quote}
        <p class="line-clamp-2 border-l-2 border-(--solus-container-border) pl-2 text-xs text-(--solus-text-secondary)">
          {openComment.quote}
        </p>
      {/if}
      {#if editing}
        <CommentComposer
          initialValue={openComment.body}
          surface="embedded"
          submitLabel="Save"
          onSave={(text) => {
            onEdit(openComment.id, text);
            editing = false;
          }}
          onCancel={() => (editing = false)}
        />
      {:else}
        <p class="whitespace-pre-wrap break-words text-(--solus-text-primary)">{openComment.body}</p>
      {/if}

      {#if pullRequest}
        {@const posted = openComment.posted}
        {#if posted?.kind === "conversation"}
          <div class="flex items-center gap-1.5 text-xs text-(--solus-text-secondary)">
            <a
              href={posted.url}
              target="_blank"
              rel="noreferrer"
              class="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              Posted to the pull request <ExternalLinkIcon size={11} aria-hidden="true" />
            </a>
            <Button variant="ghost" size="xs" class="ml-auto" disabled={busy} onclick={() => onRetract(openComment.id)}>
              Retract
            </Button>
          </div>
        {:else if posted?.kind === "draft-line"}
          <div class="flex items-center gap-1.5 text-xs text-(--solus-text-secondary)">
            {#if pullRequest.hasDraft(posted.draftId)}
              <span>In your review draft</span>
              <Button variant="ghost" size="xs" class="ml-auto" disabled={busy} onclick={() => onRemoveDraft(openComment.id)}>
                Remove from draft
              </Button>
            {:else}
              <span>Sent with a review, or removed from the draft</span>
            {/if}
          </div>
        {:else if confirmingPost}
          {@const refusal = openComment.codeAnchor ? pullRequest.draftRefusal(openComment) : null}
          <div class="flex flex-wrap items-center gap-1.5 text-xs text-(--solus-text-secondary)">
            <span class="min-w-0">
              {#if refusal}{refusal}{/if}
              Post this publicly on the pull request?
            </span>
            <span class="flex-1"></span>
            <Button variant="ghost" size="xs" onclick={() => (confirmingPost = false)}>Cancel</Button>
            <Button
              size="xs"
              disabled={busy}
              onclick={() => {
                confirmingPost = false;
                onPost(openComment.id);
              }}
            >
              Post
            </Button>
          </div>
        {/if}
      {/if}

      {#if !editing}
        <div class="flex items-center gap-1 border-t border-(--solus-container-border) pt-1.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onclick={() => {
              onResolve(openComment.id, !openComment.resolvedAt);
              if (!openComment.resolvedAt) close();
            }}
          >
            {openComment.resolvedAt ? "Reopen" : "Resolve"}
          </Button>
          <Button variant="ghost" size="xs" disabled={busy} onclick={() => (editing = true)}>Edit</Button>
          <Button
            variant="ghost"
            size="xs"
            class="text-destructive"
            disabled={busy || openComment.posted?.kind === "conversation"}
            title={openComment.posted?.kind === "conversation" ? "Retract the pull-request comment first" : undefined}
            onclick={() => {
              onDelete(openComment.id);
              close();
            }}
          >
            Delete
          </Button>
          {#if pullRequest && !openComment.posted && !confirmingPost}
            <!-- One action. A comment on a real line in the diff joins the pending
                 review; anything else is a public conversation comment, so that
                 path asks first. While the diff loads, the line cannot be checked. -->
            {@const refusal = pullRequest.draftRefusal(openComment)}
            {#if openComment.codeAnchor && !pullRequest.diffReady}
              <Button variant="outline" size="xs" class="ml-auto" disabled title="The diff is still loading.">Post to PR</Button>
            {:else if refusal === null}
              <Button
                variant="outline"
                size="xs"
                class="ml-auto"
                disabled={busy || !pullRequest.canPost}
                title={pullRequest.canPost
                  ? "Add as a line comment to your pending review. It goes out with Submit review."
                  : pullRequest.postReason}
                onclick={() => onAddDraft(openComment.id)}
              >
                Post to PR
              </Button>
            {:else}
              <Button
                variant="outline"
                size="xs"
                class="ml-auto"
                disabled={busy || !pullRequest.canPost}
                title={pullRequest.canPost ? "Post as a conversation comment" : pullRequest.postReason}
                onclick={() => (confirmingPost = true)}
              >
                Post to PR
              </Button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
