<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { fly } from "svelte/transition";
  import type { Editor } from "@tiptap/core";
  import type { PlanComment, PlanCommentReply } from "@solus/contracts/types";
  import { uuid } from "@solus/contracts/uuid";
  import { portal } from "../portal";
  import { CommentComposer } from "../ui/comment-composer";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import type { BindingId } from "../../lib/keybindings/manifest";
  import PlanCommentsRail from "../plan/PlanCommentsRail.svelte";
  import PlanCommentPopover from "../plan/PlanCommentPopover.svelte";
  import { commentMarkPositions, measureAnchors, type MeasuredAnchor } from "./lib/anchors";
  import {
    addCommentMark,
    removeCommentMark,
    restoreCommentMarks,
    prosePosToTextOffset,
    findMarkElement,
    scrollAndFlashMark,
    resolveHoveredComment,
  } from "../plan/lib/comments";

  interface Props {
    editor: Editor | null;
    scrollContainer: HTMLDivElement | null;
    comments: PlanComment[];
    onAdd: (comment: PlanComment) => void;
    onEdit: (commentId: string, text: string) => void;
    onDelete: (commentId: string) => void;
    onReply: (commentId: string, reply: PlanCommentReply) => void;
    onResolve: (commentId: string, resolved: boolean) => void;
    onRead: (commentId: string) => void;
    /** Shortcut that opens the form on the live selection. Each host owns its
     *  own scope, so the binding is named by the host rather than assumed. */
    startCommentBinding: BindingId;
    /** Action bar pinned below the threads. The margin holds whatever the
     *  surface does with a round of feedback — send it, or nothing at all. */
    footer?: Snippet;
    /** Persist content edits before a comment mark is added (avoids mark leak). */
    flushSave?: () => Promise<void>;
    /** Bound to the shell so mark mutations never trigger an autosave. */
    suppressSave?: boolean;
    /** True while the live selection can anchor a comment. Read by the host so
     *  the selection bubble only offers Comment when it would actually work —
     *  the affordance moved to the bubble, the rules stayed here. */
    canComment?: boolean;
    /** Whether the margin threads are shown. Bindable so the host can put the
     *  toggle in the document header, where the design keeps it. */
    railOpen?: boolean;
    /** True once the pane is too narrow to hold a margin without eating the
     *  measure. The rail folds away and threads open as a popover on the run
     *  instead — the measure is protected before the margin is. */
    railFolded?: boolean;
    /** Document position of each thread's mark, published so the outline can
     *  say how many threads a section holds. */
    threadAnchors?: { id: string; pos: number }[];
  }

  let {
    editor,
    scrollContainer,
    comments,
    onAdd,
    onEdit,
    onDelete,
    onReply,
    onResolve,
    onRead,
    startCommentBinding,
    footer,
    flushSave,
    suppressSave = $bindable(false),
    canComment = $bindable(false),
    railOpen = $bindable(true),
    railFolded = false,
    threadAnchors = $bindable([]),
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
  let commentFormAnchor = $state<{ left: number; top: number; width: number } | null>(null);

  // Published to the host, which owns the selection bubble the Comment action
  // now lives on. The rules for what can carry a comment stay here.
  $effect(() => {
    canComment = !!selectionRange && !commentFormAnchor;
  });

  // Only ever open in the folded layout, where there is no margin to focus a
  // card in. With the rail up, clicking a highlight focuses its card — one
  // thread must never have two places it can be read.
  let popoverComment = $state<PlanComment | null>(null);
  let popoverAnchor = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  let activeRailCommentId = $state<string | null>(null);
  let hoveredRailCommentId = $state<string | null>(null);
  let hoveredMarkId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);

  const railVisible = $derived(railOpen && comments.length > 0 && !railFolded);

  /**
   * Focus is mutual, and so is hover: the focused thread's highlight is deepened
   * in the text, so the conversation the margin is showing is findable in the
   * prose without reading the margin — and hovering either end previews the
   * other. Hover is not a state, so it never survives the pointer leaving.
   */
  const highlightedCommentId = $derived(
    hoveredRailCommentId ?? hoveredMarkId ?? activeRailCommentId,
  );
  const focusedCardId = $derived(hoveredMarkId ?? activeRailCommentId);

  // Hovering a highlight lights up its card in the margin — the reverse of the
  // rail's own hover, which deepens the highlight.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    const onOver = (e: MouseEvent) => {
      hoveredMarkId = resolveHoveredComment(e, comments)?.comment.id ?? null;
    };
    el.addEventListener("pointerover", onOver);
    return () => el.removeEventListener("pointerover", onOver);
  });

  $effect(() => {
    const el = scrollContainer;
    // Marks are re-created whenever the doc or the comment set changes, so the
    // class has to be re-applied on both.
    void comments;
    void editor?.state.doc;
    const id = highlightedCommentId;
    if (!el) return;
    void tick().then(() => {
      el.querySelectorAll("mark.plan-comment-active").forEach((m) =>
        m.classList.remove("plan-comment-active"),
      );
      if (id) findMarkElement(el, id)?.classList.add("plan-comment-active");
    });
  });

  // Where each highlight sits, in the scroll container's own box. Re-measured
  // on scroll, on resize, and whenever the comment set or the document
  // changes — the three things that can move a mark.
  let anchors = $state<MeasuredAnchor[]>([]);
  // False while the rail is moving: cards keep following their anchors, but
  // connectors are suppressed so nothing flickers across the margin.
  let settled = $state(true);
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function remeasure() {
    anchors = measureAnchors(scrollContainer, comments);
    threadAnchors = commentMarkPositions(editor);
  }

  function markMoving() {
    settled = false;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => (settled = true), 140);
  }

  $effect(() => {
    // Re-read on every change that can move a mark. The count, not the array:
    // a thread is added by pushing into the same array, so reading `comments`
    // alone never re-runs this and the new card is left without an anchor.
    void comments.length;
    void editor?.state.doc;
    void scrollContainer;
    void tick().then(remeasure);
  });

  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    // One rAF per frame — a fast scroll must not run a layout read per event.
    let pending = false;
    const onScroll = () => {
      markMoving();
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        remeasure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      markMoving();
      remeasure();
    });
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
    };
  });

  useKeybinding(() => startCommentBinding, () => startComment(), {
    enabled: () => canComment,
  });

  // Wire selection tracking + initial mark restore whenever the editor changes.
  let wiredEditor: Editor | null = null;
  $effect(() => {
    const ed = editor;
    if (!ed || ed === wiredEditor) return;
    wiredEditor = ed;
    ed.on("selectionUpdate", () => {
      // Focus is the whole gate, and it is the same rule the selection bubble
      // draws itself by — so Comment is never missing from a bubble that is on
      // screen. The programmatic selections this has to ignore (find/replace,
      // mark restore, agent rewrites) all move the selection while the caret
      // lives somewhere else.
      if (!ed.view.hasFocus()) {
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

  // Both listeners ride the shell's scroll region (bound from the host), which
  // is also the gate: they only ever fire for this document's own text.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    el.addEventListener("click", handleCommentClick);
    el.addEventListener("keydown", handleThreadKeys);
    return () => {
      el.removeEventListener("click", handleCommentClick);
      el.removeEventListener("keydown", handleThreadKeys);
    };
  });

  function clearCommentDraft() {
    selectionRange = null;
    commentFormAnchor = null;
  }

  /** Called by the host when the selection bubble's Comment action is used. */
  export function startComment() {
    if (!selectionRange) return;
    // Clamped to the window: a document in a right-hand pane makes its
    // selections sit near the screen edge, where an unclamped form opens off it.
    const width = Math.min(500, window.innerWidth - 32);
    commentFormAnchor = {
      left: Math.max(16, Math.min(selectionRange.left, window.innerWidth - width - 16)),
      top: selectionRange.bottom + 8,
      width,
    };
  }

  async function handleSaveComment(text: string) {
    if (!selectionRange || !editor) return;
    const container = scrollContainer;
    const savedScroll = container?.scrollTop ?? 0;

    await flushSave?.();

    const textOffset = prosePosToTextOffset(editor, selectionRange.from);
    const newComment: PlanComment = {
      id: uuid(),
      selectedText: selectionRange.selectedText,
      comment: text,
      textOffset,
      author: "you",
      createdAt: Date.now(),
      readAt: Date.now(),
    };
    onAdd(newComment);

    const { from, to } = selectionRange;
    suppressSave = true;
    addCommentMark(editor, from, to, newComment.id);
    suppressSave = false;

    clearCommentDraft();
    railOpen = true;

    await tick();
    if (container) {
      container.scrollTop = savedScroll;
      requestAnimationFrame(() => {
        container.scrollTop = savedScroll;
      });
    }
  }

  /**
   * Clicking a highlight focuses its thread — and does *not* scroll, because
   * the reader is already looking at the right line. Clicking bare prose lets
   * the thread go. Folded, where there is no margin, the thread opens on the
   * run instead.
   */
  function handleCommentClick(e: MouseEvent) {
    // The margin is a layer inside the same scroller, so a click on a card
    // reaches this handler too — and must not read as "clicked bare prose",
    // which would unfocus the thread the reader has just opened.
    if (e.target instanceof Element && e.target.closest(".plan-comments-rail")) return;
    const resolved = resolveHoveredComment(e, comments);
    if (!resolved) {
      popoverComment = null;
      activeRailCommentId = null;
      return;
    }
    railOpen = true;
    activeRailCommentId = resolved.comment.id;
    onRead(resolved.comment.id);
    popoverComment = railFolded ? resolved.comment : null;
    popoverAnchor = clampPopoverAnchor(resolved.anchor);
  }

  /**
   * ⌥↑ / ⌥↓ walk the threads in document order and bring each anchor into view;
   * Esc lets the current one go and returns nothing. Document order comes off
   * the measured anchors, so it is the order the reader sees rather than the
   * order the threads were written in.
   */
  const orderedThreadIds = $derived(
    [...anchors].sort((a, b) => a.anchorTop - b.anchorTop).map((a) => a.id),
  );

  function handleThreadKeys(e: KeyboardEvent) {
    if (e.key === "Escape" && activeRailCommentId) {
      e.preventDefault();
      e.stopPropagation();
      activeRailCommentId = null;
      popoverComment = null;
      return;
    }
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const ids = orderedThreadIds;
    if (ids.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const current = activeRailCommentId ? ids.indexOf(activeRailCommentId) : -1;
    const next =
      e.key === "ArrowDown"
        ? Math.min(ids.length - 1, current + 1)
        : Math.max(0, (current === -1 ? 0 : current) - 1);
    railOpen = true;
    handleScrollToComment(ids[next]);
  }

  /** Keep the folded popover 12px clear of the window's right edge. */
  function clampPopoverAnchor(anchor: { x: number; y: number }) {
    const halfWidth = 134;
    return { x: Math.min(anchor.x, window.innerWidth - 12 - halfWidth), y: anchor.y };
  }

  function closePopover() {
    popoverComment = null;
  }

  function handleEditComment(comment: PlanComment) {
    popoverComment = null;
    railOpen = true;
    editingCommentId = comment.id;
    activeRailCommentId = comment.id;
  }

  function handleDeleteComment(commentId: string) {
    popoverComment = null;
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
        railOpen = true;
      });
    }
  }

  function handleScrollToComment(commentId: string) {
    activeRailCommentId = commentId;
    // Focus is mutual: opening a thread marks it read, so its unread dot goes
    // out the moment the reader has actually looked at it.
    onRead(commentId);
    const mark = findMarkElement(scrollContainer, commentId);
    if (!mark || !scrollContainer) return;
    scrollAndFlashMark(scrollContainer, mark);
  }

  function handleReply(commentId: string, text: string) {
    onReply(commentId, { id: uuid(), author: "you", text, createdAt: Date.now() });
    activeRailCommentId = commentId;
  }

  function handleResolve(commentId: string, resolved: boolean) {
    onResolve(commentId, resolved);
    if (resolved && activeRailCommentId === commentId) activeRailCommentId = null;
  }

</script>

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
    <CommentComposer
      onSave={handleSaveComment}
      onCancel={clearCommentDraft}
      placeholder="Add comment…"
      submitOn="enter"
    />
  </div>
{/if}

<!-- Folded only: with no margin to hold the thread, it opens on the run it
     annotates. Dismissed by Escape or by clicking anywhere else in the text. -->
{#if popoverComment}
  <PlanCommentPopover
    comment={popoverComment}
    anchor={popoverAnchor}
    pinned
    onEdit={handleEditComment}
    onDelete={(c) => handleDeleteComment(c.id)}
    onClose={closePopover}
  />
{/if}

<!-- Comments rail (floating panel anchored to the right of the document) -->
{#if railVisible}
  <div class="cl-rail-sleeve" transition:fly={{ x: 264, duration: 200, opacity: 0 }}>
    <PlanCommentsRail
      {comments}
      activeCommentId={focusedCardId}
      {editingCommentId}
      placement="anchored"
      {anchors}
      {settled}
      onScrollTo={handleScrollToComment}
      onHover={(commentId) => (hoveredRailCommentId = commentId)}
      onResolve={handleResolve}
      onReply={handleReply}
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
      {footer}
    />
  </div>
{/if}

<style>
  .cl-form-position {
    left: var(--cf-left);
    top: var(--cf-top);
    width: var(--cf-width);
  }
  /* Threads live in the margin of the same page, so the sleeve is a plain
     track — no frame, no fill, and no rule between it and the text column. */
  /* The margin of the page, not a panel beside it: the sleeve is a column of
     the page block, and it sticks to the top of the reading viewport so cards
     can hold their anchors' lines while the text scrolls under them. */
  .cl-rail-sleeve {
    width: var(--solus-doc-rail-w);
    flex-shrink: 0;
    position: sticky;
    top: 0;
    align-self: flex-start;
    height: var(--doc-viewport-h, 100%);
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* The page's right gutter. The scrollbar rides outside it, on the
       viewport's edge, so nothing is drawn between the prose and its margin. */
    padding-right: 1.5rem;
    background: transparent;
  }
</style>
