<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { ChatCircleTextIcon, XIcon, ArrowUpIcon } from "phosphor-svelte";
  import type { Editor } from "@tiptap/core";
  import type { PlanComment } from "../../../shared/types";
  import { uuid } from "../../../shared/uuid";
  import { portal } from "../portal";
  import { tooltip } from "../../lib/tooltip";
  import { MarkdownTextarea } from "../ui/markdown-field";
  import { Button } from "../ui/button";
  import { toasts } from "../../contexts";
  import PlanCommentsRail from "../plan/PlanCommentsRail.svelte";
  import PlanCommentPopover from "../plan/PlanCommentPopover.svelte";
  import {
    addCommentMark,
    removeCommentMark,
    restoreCommentMarks,
    prosePosToTextOffset,
    findMarkElement,
    scrollAndFlashMark,
    flashMark,
    resolveHoveredComment,
    isUserSelection,
  } from "../plan/lib/comments";

  interface Props {
    editor: Editor | null;
    scrollContainer: HTMLDivElement | null;
    comments: PlanComment[];
    onAdd: (comment: PlanComment) => void;
    onEdit: (commentId: string, text: string) => void;
    onDelete: (commentId: string) => void;
    onSendToAgent: () => void | Promise<void>;
    /** Persist content edits before a comment mark is added (avoids mark leak). */
    flushSave?: () => Promise<void>;
    /** Bound to the shell so mark mutations never trigger an autosave. */
    suppressSave?: boolean;
  }

  let {
    editor,
    scrollContainer,
    comments,
    onAdd,
    onEdit,
    onDelete,
    onSendToAgent,
    flushSave,
    suppressSave = $bindable(false),
  }: Props = $props();

  let selectionRange = $state<{
    from: number;
    to: number;
    selectedText: string;
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null>(null);
  let commentInput = $state("");
  let commentFormAnchor = $state<{ left: number; top: number; width: number } | null>(null);
  let commentInputEl: HTMLTextAreaElement | null = $state(null);

  let hoveredComment = $state<PlanComment | null>(null);
  let hoveredAnchor = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

  // A clicked mark pins the popover open until dismissed (hover alone is fleeting
  // and easy to miss); pinned takes precedence over a transient hover.
  let pinnedComment = $state<PlanComment | null>(null);
  let pinnedAnchor = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  const popoverComment = $derived(pinnedComment ?? hoveredComment);
  const popoverAnchor = $derived(pinnedComment ? pinnedAnchor : hoveredAnchor);

  let railClosed = $state(false);
  let activeRailCommentId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);

  const railOpen = $derived(!railClosed && comments.length > 0);

  // Mirror the standard submit-to-agent flow (InputBar / diff feedback): guard
  // against double-sends while the chat tab is being opened.
  let submitting = $state(false);
  async function handleSend() {
    if (submitting || comments.length === 0) return;
    submitting = true;
    try {
      await onSendToAgent();
    } finally {
      submitting = false;
    }
  }

  // Wire selection tracking + initial mark restore whenever the editor changes.
  let wiredEditor: Editor | null = null;
  $effect(() => {
    const ed = editor;
    if (!ed || ed === wiredEditor) return;
    wiredEditor = ed;
    ed.on("selectionUpdate", () => {
      // Only surface the comment affordance for a real cursor selection — ignore
      // programmatic ones (find/replace, mark restore, agent rewrites).
      if (!isUserSelection(ed)) {
        selectionRange = null;
        return;
      }
      const { from, to } = ed.state.selection;
      if (from === to) {
        selectionRange = null;
        return;
      }
      const selectedText = ed.state.doc.textBetween(from, to, " ");
      if (selectedText.trim().length < 3) {
        selectionRange = null;
        return;
      }
      const startCoords = ed.view.coordsAtPos(from);
      const endCoords = ed.view.coordsAtPos(to);
      selectionRange = {
        from,
        to,
        selectedText: selectedText.trim(),
        top: startCoords.top,
        bottom: endCoords.bottom,
        left: startCoords.left,
        right: endCoords.right,
      };
    });
    suppressSave = true;
    restoreCommentMarks(ed, comments);
    suppressSave = false;
  });

  // Re-apply marks whenever the comment set changes (agent rewrites, deletes…).
  $effect(() => {
    const c = comments;
    const ed = editor;
    if (!ed) return;
    suppressSave = true;
    restoreCommentMarks(ed, c);
    suppressSave = false;
  });

  // Hover popover lives on the shell's scroll region (bound from the host).
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    el.addEventListener("pointerover", handleCommentHover);
    el.addEventListener("click", handleCommentClick);
    return () => {
      el.removeEventListener("pointerover", handleCommentHover);
      el.removeEventListener("click", handleCommentClick);
    };
  });

  $effect(() => {
    if (commentFormAnchor === null) return;
    void tick().then(() => commentInputEl?.focus());
  });

  function clearCommentDraft() {
    selectionRange = null;
    commentFormAnchor = null;
    commentInput = "";
  }

  function handleStartComment() {
    if (!selectionRange) return;
    commentFormAnchor = {
      left: selectionRange.left,
      top: selectionRange.bottom + 8,
      width: 500,
    };
    commentInput = "";
  }

  async function handleSaveComment() {
    if (!selectionRange || !commentInput.trim() || !editor) return;
    const container = scrollContainer;
    const savedScroll = container?.scrollTop ?? 0;

    await flushSave?.();

    const textOffset = prosePosToTextOffset(editor, selectionRange.from);
    const newComment: PlanComment = {
      id: uuid(),
      selectedText: selectionRange.selectedText,
      comment: commentInput.trim(),
      textOffset,
    };
    onAdd(newComment);

    const { from, to } = selectionRange;
    suppressSave = true;
    addCommentMark(editor, from, to, newComment.id);
    suppressSave = false;

    clearCommentDraft();
    railClosed = false;

    await tick();
    if (container) {
      container.scrollTop = savedScroll;
      requestAnimationFrame(() => {
        container.scrollTop = savedScroll;
      });
    }
  }

  function handleCommentHover(e: MouseEvent) {
    const resolved = resolveHoveredComment(e, comments);
    if (!resolved) {
      if (hoverTimeout) clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => (hoveredComment = null), 350);
      return;
    }
    if (hoverTimeout) clearTimeout(hoverTimeout);
    hoveredComment = resolved.comment;
    hoveredAnchor = resolved.anchor;
  }

  // Clicking a highlighted span pins its popover; clicking bare text dismisses.
  function handleCommentClick(e: MouseEvent) {
    const resolved = resolveHoveredComment(e, comments);
    if (!resolved) {
      pinnedComment = null;
      return;
    }
    if (hoverTimeout) clearTimeout(hoverTimeout);
    hoveredComment = null;
    pinnedComment = resolved.comment;
    pinnedAnchor = resolved.anchor;
    activeRailCommentId = resolved.comment.id;
    railClosed = false;
    // Pulse the clicked mark for the same feedback as the plan modal.
    const mark = findMarkElement(scrollContainer, resolved.comment.id);
    if (mark) flashMark(mark);
  }

  function closePopover() {
    hoveredComment = null;
    pinnedComment = null;
  }

  function handleEditComment(comment: PlanComment) {
    hoveredComment = null;
    pinnedComment = null;
    railClosed = false;
    editingCommentId = comment.id;
    activeRailCommentId = comment.id;
  }

  function handleDeleteComment(commentId: string) {
    hoveredComment = null;
    pinnedComment = null;
    const deleted = comments.find((c) => c.id === commentId);
    onDelete(commentId);
    if (editingCommentId === commentId) editingCommentId = null;
    if (editor) {
      suppressSave = true;
      removeCommentMark(editor, commentId);
      suppressSave = false;
    }
    // Offer an undo: re-adding the comment lets the mark-restore effect re-anchor it.
    if (deleted) {
      toasts.undo("Comment deleted", () => {
        onAdd(deleted);
        railClosed = false;
      });
    }
  }

  function handleScrollToComment(commentId: string) {
    activeRailCommentId = commentId;
    const mark = findMarkElement(scrollContainer, commentId);
    if (!mark || !scrollContainer) return;
    scrollAndFlashMark(scrollContainer, mark);
  }

  function handleHoverRailComment(commentId: string | null) {
    if (!scrollContainer) return;
    if (commentId) {
      findMarkElement(scrollContainer, commentId)?.classList.add("plan-comment-active");
    } else {
      scrollContainer
        .querySelectorAll("mark.plan-comment-active")
        .forEach((m) => m.classList.remove("plan-comment-active"));
    }
  }
</script>

<!-- Floating "Comment" button at the selection -->
{#if selectionRange && !commentFormAnchor}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal={document.body}
    data-floating-comment
    data-solus-ui
    class="fixed"
    style="left:{(selectionRange.left + selectionRange.right) / 2}px;top:{selectionRange.top}px;z-index:10001;transform:translate(-50%, calc(-100% - 0.375rem))"
    transition:fly={{ y: 4, duration: 120, opacity: 0 }}
  >
    <Button
      variant="outline"
      size="sm"
      onmousedown={(e) => e.preventDefault()}
      onclick={handleStartComment}
      class="border-(--solus-popover-border) bg-(--solus-popover-bg) text-(--solus-accent) shadow-(--solus-popover-shadow) backdrop-blur-[1.25rem] hover:-translate-y-[0.0625rem] hover:border-(--solus-accent) hover:bg-(--solus-accent) hover:text-(--solus-text-on-accent)"
      data-testid="add-comment"
      title="Add comment"
    >
      <ChatCircleTextIcon size={13} />
      Comment
    </Button>
  </div>
{/if}

<!-- Inline comment form -->
{#if commentFormAnchor}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal={document.body}
    data-inline-comment-form
    data-solus-ui
    class="fixed cl-form-position"
    style="--cf-left:{commentFormAnchor.left}px;--cf-top:{commentFormAnchor.top}px;--cf-width:{commentFormAnchor.width}px;z-index:10001"
  >
    <div class="cl-form">
      <MarkdownTextarea
        bind:ref={commentInputEl}
        bind:value={commentInput}
        bare
        placeholder="Add comment…"
        rows={1}
        submitOn="enter"
        onSubmit={handleSaveComment}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) e.stopPropagation();
          if (e.key === "Escape") {
            e.stopPropagation();
            clearCommentDraft();
          }
        }}
      />
      <div class="cl-form__actions">
        <Button variant="ghost" size="icon-xs" onclick={clearCommentDraft} class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)" title="Cancel (Esc)">
          <XIcon size={13} />
        </Button>
        <Button
          size="sm"
          onclick={handleSaveComment}
          disabled={!commentInput.trim()}
          data-testid="submit-comment"
        >
          Comment
        </Button>
      </div>
    </div>
  </div>
{/if}

<!-- Comment popover (opens on hover, pins open on click) -->
{#if popoverComment}
  <PlanCommentPopover
    comment={popoverComment}
    anchor={popoverAnchor}
    pinned={!!pinnedComment}
    onEdit={handleEditComment}
    onDelete={(c) => handleDeleteComment(c.id)}
    onClose={closePopover}
    onHoverEnter={() => { if (hoverTimeout) clearTimeout(hoverTimeout); }}
  />
{/if}

<!-- Comments rail (floating panel anchored to the right of the document) -->
{#if railOpen}
  <div class="cl-rail-sleeve" transition:fly={{ x: 264, duration: 200, opacity: 0 }}>
    <PlanCommentsRail
      {comments}
      activeCommentId={hoveredComment?.id ?? activeRailCommentId}
      {editingCommentId}
      onScrollTo={handleScrollToComment}
      onHover={handleHoverRailComment}
      onStartEdit={(commentId) => {
        editingCommentId = commentId;
        activeRailCommentId = commentId;
      }}
      onSaveEdit={(commentId, text) => {
        onEdit(commentId, text);
        editingCommentId = null;
      }}
      onCancelEdit={() => (editingCommentId = null)}
      onDelete={handleDeleteComment}
      onClose={() => (railClosed = true)}
    >
      {#snippet footer()}
        <div class="cl-send-bar">
          <span class="cl-send-bar__hint">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </span>
          <span class="inline-flex" use:tooltip={"Send to agent"}>
            <Button
              size="icon"
              class="rounded-full"
              data-testid="send-comments"
              disabled={submitting}
              onclick={handleSend}
              aria-label="Send comments to agent"
            >
              <ArrowUpIcon size={16} weight="bold" />
            </Button>
          </span>
        </div>
      {/snippet}
    </PlanCommentsRail>
  </div>
{/if}

<style>
  .cl-form-position {
    left: var(--cf-left);
    top: var(--cf-top);
    width: var(--cf-width);
  }
  .cl-form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    border-radius: 0.625rem;
    border: 0.0625rem solid var(--solus-accent-border);
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.25rem);
    -webkit-backdrop-filter: blur(1.25rem);
  }
  .cl-form__actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.375rem;
  }
  /* The rail renders a self-framed floating card, so the sleeve stays a
     transparent track — no extra border/fill to double-frame it. */
  .cl-rail-sleeve {
    /* Container-relative (cqi) so the rail scales with the document shell width
       rather than the viewport — a narrow split pane gets a narrow rail instead
       of one sized off the full screen, keeping the editor usable. */
    width: clamp(12rem, 24cqi, 16.5rem);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: transparent;
  }
  /* Submit lives at the bottom of the comments rail and uses the canonical accent
     send button shared with the input bar and diff-feedback composer, so sending
     comments to the agent looks and feels identical to every other page. */
  .cl-send-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
  }
  .cl-send-bar__hint {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
</style>
