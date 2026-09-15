<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { fly } from "svelte/transition";
  import type { Editor } from "@tiptap/core";
  import type { PlanComment, PlanCommentReply } from "@solus/contracts/types";
  import type { DocCommentThread } from "@solus/contracts/work-comments";
  import { uuid } from "@solus/contracts/uuid";
  import { portal } from "../portal";
  import ExternalCommentsStatus from "../work/ExternalCommentsStatus.svelte";
  import { CommentComposer } from "../ui/comment-composer";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import type { BindingId } from "../../lib/keybindings/manifest";
  import PlanCommentsRail from "../plan/PlanCommentsRail.svelte";
  import { commentMarkPositions, measureAnchors, type MeasuredAnchor } from "./lib/anchors";
  import { drawerFrame, type PaneBox } from "./lib/rail-layout";
  import {
    addCommentMark,
    removeCommentMark,
    restoreCommentMarks,
    prosePosToTextOffset,
    findMarkElement,
    findMarkElements,
    scrollAndFlashMark,
    resolveHoveredComment,
  } from "../plan/lib/comments";

  interface Props {
    externalWorkId?: string;
    /** Threads that live in the linked external document. They share the one
     *  rail with the local ones rather than a panel of their own. */
    externalThreads?: DocCommentThread[];
    onAskExternalPrivately?: (thread: DocCommentThread) => void;
    onLocateExternalQuote?: (quote: string, threadId: string) => boolean;
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
     *  measure. The rail folds away and the same threads open as a drawer
     *  over the pane's edge instead — the measure is protected before the
     *  margin is. */
    railFolded?: boolean;
    /** Document position of each thread's mark, published so the outline can
     *  say how many threads a section holds. */
    threadAnchors?: { id: string; pos: number }[];
  }

  let {
    externalWorkId,
    externalThreads = [],
    onAskExternalPrivately,
    onLocateExternalQuote,
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

  let activeRailCommentId = $state<string | null>(null);
  let hoveredRailCommentId = $state<string | null>(null);
  let hoveredMarkId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);

  // Resolved external threads are out of the way until they are asked for. The
  // toggle sits in the rail's provider line, so one control governs the whole
  // margin rather than one part of it.
  let showExternalResolved = $state(false);
  const shownExternal = $derived(
    externalThreads.filter((thread) => !thread.deleted && (showExternalResolved || !thread.resolved)),
  );
  const threadCount = $derived(comments.length + shownExternal.length);

  const railVisible = $derived(railOpen && threadCount > 0 && !railFolded);
  // Folded there is no margin, so the same rail becomes a drawer over the
  // right edge of the reading pane — one comments surface at every width, and
  // one thread never has two places it can be read.
  const drawerVisible = $derived(railOpen && threadCount > 0 && railFolded);

  // The margin is open by default; the drawer is not, because it covers the
  // text it belongs to. Folding closes it, unfolding gives the margin back.
  let lastFolded: boolean | null = null;
  $effect(() => {
    if (lastFolded === railFolded) return;
    lastFolded = railFolded;
    railOpen = !railFolded;
  });

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
      el.querySelectorAll(".plan-comment-active").forEach((m) =>
        m.classList.remove("plan-comment-active"),
      );
      if (id) for (const part of findMarkElements(el, id)) part.classList.add("plan-comment-active");
    });
  });

  // Where each highlight sits, in the scroll container's own box. Re-measured
  // on scroll, on resize, and whenever the comment set or the document
  // changes — the three things that can move a mark.
  let anchors = $state<MeasuredAnchor[]>([]);
  // Which external threads annotate a passage of this text and which annotate
  // the document. The highlight plugin decides it: a thread it placed has an
  // anchor here, and one it could not — a comment on the page as a whole, a
  // detached one, a quote this copy no longer holds — does not.
  const anchoredIds = $derived(new Set(anchors.map((anchor) => anchor.id)));
  const inlineExternal = $derived(shownExternal.filter((thread) => anchoredIds.has(thread.id)));
  const pageExternal = $derived(shownExternal.filter((thread) => !anchoredIds.has(thread.id)));
  // The same sorting for local threads. A local thread whose quote is no longer
  // in the text has no mark to measure, and the anchored margin used to keep
  // it at `visibility: hidden` — counted in the header, findable nowhere. It
  // belongs to the Page view with every other thread that has no line.
  const inlineLocal = $derived(comments.filter((comment) => anchoredIds.has(comment.id)));
  const pageLocal = $derived(comments.filter((comment) => !anchoredIds.has(comment.id)));
  // Where the drawer sits when the rail is folded: over the right edge of the
  // reading pane, which is not the edge of the window once a document is in a
  // split.
  let drawerBox = $state<PaneBox | null>(null);
  let drawerEl: HTMLDivElement | null = $state(null);
  // False while the rail is moving: cards keep following their anchors, but
  // connectors are suppressed so nothing flickers across the margin.
  let settled = $state(true);
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function remeasure() {
    anchors = measureAnchors(scrollContainer, comments, shownExternal.map((thread) => thread.id));
    threadAnchors = commentMarkPositions(editor);
    const rect = scrollContainer?.getBoundingClientRect();
    drawerBox = rect
      ? drawerFrame(
          { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        )
      : null;
  }

  // The drawer covers the text, so it takes focus when it opens: Escape then
  // closes it from anywhere inside, and a reader on a screen reader lands on
  // the threads rather than on the prose they cover.
  $effect(() => {
    if (!drawerVisible) return;
    void tick().then(() => drawerEl?.focus({ preventScroll: true }));
  });

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
    void shownExternal.length;
    void editor?.state.doc;
    void scrollContainer;
    void tick().then(remeasure);
  });

  $effect(() => {
    const el = scrollContainer;
    if (!el || threadCount === 0) return;
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
   * the thread go. Folded, the same click opens the drawer on that card, and
   * bare prose closes the drawer again: the drawer covers the text, so the
   * text is the way out of it.
   */
  function handleCommentClick(e: MouseEvent) {
    // The margin is a layer inside the same scroller, so a click on a card
    // reaches this handler too — and must not read as "clicked bare prose",
    // which would unfocus the thread the reader has just opened.
    if (e.target instanceof Element && e.target.closest(".plan-comments-rail")) return;
    const externalId =
      e.target instanceof Element
        ? e.target.closest("[data-external-comment]")?.getAttribute("data-external-comment")
        : null;
    if (externalId) {
      railOpen = true;
      activeRailCommentId = externalId;
      return;
    }
    const resolved = resolveHoveredComment(e, comments);
    if (!resolved) {
      activeRailCommentId = null;
      if (railFolded) railOpen = false;
      return;
    }
    railOpen = true;
    activeRailCommentId = resolved.comment.id;
    onRead(resolved.comment.id);
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
    if (e.key === "Escape" && (activeRailCommentId || drawerVisible)) {
      e.preventDefault();
      e.stopPropagation();
      activeRailCommentId = null;
      if (railFolded) railOpen = false;
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

  function handleDeleteComment(commentId: string) {
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

<!-- One comments surface: a line of provider chrome, then the margin, local and
     external cards alike on the lines they annotate. -->
{#snippet threadSurface(placement: "stacked" | "anchored")}
  {#if externalWorkId && shownExternal.length > 0}
    <ExternalCommentsStatus
      workId={externalWorkId}
      showResolved={showExternalResolved}
      onToggleResolved={() => (showExternalResolved = !showExternalResolved)}
    />
  {/if}
  <PlanCommentsRail
  {externalWorkId}
  comments={inlineLocal}
  pageComments={pageLocal}
  externalThreads={inlineExternal}
  pageThreads={pageExternal}
  onClose={placement === "stacked" ? () => (railOpen = false) : undefined}
  onAskExternalPrivately={onAskExternalPrivately}
  onLocateExternalQuote={onLocateExternalQuote}
  activeCommentId={focusedCardId}
  {editingCommentId}
  {placement}
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
{/snippet}

<!-- Comments rail (the document's own margin, to the right of the text) -->
{#if railVisible}
  <div class="cl-rail-sleeve" transition:fly={{ x: 264, duration: 200, opacity: 0 }}>
    {@render threadSurface("anchored")}
  </div>
{/if}

<!-- Folded: no margin to hold cards on their lines, so the same surface becomes
     a drawer over the right edge of the reading pane — the side the margin
     lives on, sized to that pane's own box rather than the window. Escape,
     the header's close, or a click on the bare prose puts it away. -->
{#if drawerVisible && drawerBox}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={drawerEl}
    use:portal={document.body}
    data-solus-ui
    data-testid="comments-drawer"
    class="cl-rail-drawer fixed flex flex-col outline-none"
    style="left:{drawerBox.left}px;top:{drawerBox.top}px;width:{drawerBox.width}px;height:{drawerBox.height}px"
    role="complementary"
    aria-label="Comments"
    tabindex="-1"
    transition:fly={{ x: 24, duration: 200, opacity: 0 }}
    onkeydown={(e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      railOpen = false;
    }}
  >
    {@render threadSurface("stacked")}
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
  /* The provider line is one row at the head of the surface, so the margin
     below it takes the rest of the room rather than its own full height. */
  .cl-rail-sleeve :global(.plan-comments-rail),
  .cl-rail-drawer :global(.plan-comments-rail) {
    height: auto;
    flex: 1;
    min-height: 0;
  }
  /* Folded, the same surface is a drawer on the edge of the reading pane: the
     one place a thread can be read when there is no margin to hold it. Its
     threads stack and scroll inside it; the text under it does not move. */
  .cl-rail-drawer {
    padding: 0.75rem 0.875rem 0.875rem;
    border-left: 0.0625rem solid var(--solus-container-border);
    background: var(--solus-container-bg);
    box-shadow: var(--solus-popover-shadow);
    z-index: 10000;
  }
</style>
