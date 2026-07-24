<script lang="ts">
  import "./PlanModal.css";

  import type { Editor } from "@tiptap/core";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { uuid } from "../../../shared/uuid";
  import {
    XIcon,
    ChatCircleTextIcon,
    CheckIcon,
    CopyIcon,
    BookmarkSimpleIcon,
    CaretDownIcon,
    CheckCircleIcon,
    XCircleIcon,
    ArrowUpRightIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import { runtime, getWorkspaceContext, getPlanStore, toasts } from "../../contexts";
  import PlanActionBar from "./PlanActionBar.svelte";
  import DocumentShell from "../document-shell/DocumentShell.svelte";
  import { CommentMark } from "../editor/commentMark";
  import PlanCommentsRail from "./PlanCommentsRail.svelte";
  import type { Plan, PlanComment } from "../../../shared/types";
  import { portal } from "../portal";
  import {
    prosePosToTextOffset,
    restoreCommentMarks,
    findMarkElement,
    addCommentMark,
    removeCommentMark,
    scrollAndFlashMark,
    flashMark,
    resolveHoveredComment,
    isUserSelection,
  } from "./lib/comments";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { MarkdownTextarea } from "../ui/markdown-field";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { ArrowSquareOutIcon, ArrowsOutSimpleIcon } from "phosphor-svelte";
  import type { PaneSlot } from "../../contexts/workspace/pane-view.store.svelte";

  const commentExtensions = [CommentMark];

  interface Props {
    plan: Plan;
    inline?: boolean;
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
    onClose?: () => void;
  }

  let { plan, inline = false, slot = "primary", onOpenInSplit, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const isMobile = $derived(runtime.isMobileViewport);
  const comments = $derived(plan.comments);
  const isBookmarked = $derived(plan.bookmarked);
  const isPreview = $derived(!!planStore.previewDescriptor);

  const planRevisions = $derived(planStore.plansForSession(plan.sessionId));
  const revisionCount = $derived(planRevisions.length);
  const currentRevisionIndex = $derived(
    planRevisions.findIndex((p) => p.id === plan.id),
  );
  let revisionDropdownOpen = $state(false);
  let revisionTriggerEl = $state<HTMLButtonElement | null>(null);
  let revisionPanelPos = $state<{ top: number; left: number } | null>(null);

  // Overflow (⋯) menu holding the secondary header actions (Copy, Bookmark).
  let overflowOpen = $state(false);

  // Editor handles owned by the shell, surfaced here to drive comment features.
  let shell: DocumentShell | null = $state(null);
  let tiptapEditor: Editor | null = $state(null);
  let scrollContainer: HTMLDivElement | null = $state(null);
  let suppressSave = $state(false);

  // Comment creation state
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
  let commentFormAnchor = $state<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  let commentInputEl: HTMLTextAreaElement | null = $state(null);

  // Comments rail
  let commentsRailOpen = $state(false);
  let commentsRailInLayout = $state(false);
  let commentsRailPlanId = $state<string | null>(null);
  let activeRailCommentId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);
  // Comment whose mark is hovered in the editor — transiently highlights its
  // rail card without disturbing a pinned (scrolled-to) selection.
  let hoveredMarkId = $state<string | null>(null);

  $effect(() => {
    if (commentFormAnchor === null) return;
    void tick().then(() => commentInputEl?.focus());
  });

  // Hovering a comment mark in the document lights up its card in the rail.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    const onOver = (e: MouseEvent) => {
      const resolved = resolveHoveredComment(e, comments);
      hoveredMarkId = resolved ? resolved.comment.id : null;
    };
    el.addEventListener("pointerover", onOver);
    return () => el.removeEventListener("pointerover", onOver);
  });

  // Clicking a highlighted span surfaces its comment: open the rail (if hidden)
  // and select + flash the matching card so the comment text is visible.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const resolved = resolveHoveredComment(e, comments);
      if (!resolved) return;
      commentsRailOpen = true;
      activeRailCommentId = resolved.comment.id;
      // The clicked mark is already in view — flash it in place rather than
      // re-scrolling the document under the user.
      const mark = findMarkElement(scrollContainer, resolved.comment.id);
      if (mark) flashMark(mark);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  });

  // Re-apply comment marks whenever the comment set changes.
  $effect(() => {
    const c = comments;
    const editor = tiptapEditor;
    if (!editor || c.length === 0) return;
    suppressSave = true;
    restoreCommentMarks(editor, c);
    suppressSave = false;
  });

  $effect(() => {
    const previousPlanId = commentsRailPlanId;
    if (previousPlanId === plan.id) return;
    commentsRailPlanId = plan.id;
    if (previousPlanId === null) return;
    commentsRailOpen = !isMobile && comments.length > 0;
    activeRailCommentId = null;
    editingCommentId = null;
  });

  $effect(() => {
    if (commentsRailOpen) commentsRailInLayout = true;
  });

  // Dismiss floating comment / revision dropdown on outside click.
  $effect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (
        !t.closest("[data-floating-comment]") &&
        !t.closest("[data-inline-comment-form]")
      ) {
        clearCommentDraft();
      }
      if (
        revisionDropdownOpen &&
        !t.closest("[data-revision-panel]") &&
        t !== revisionTriggerEl &&
        !revisionTriggerEl?.contains(t)
      ) {
        revisionDropdownOpen = false;
        revisionPanelPos = null;
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  });

  function clearCommentDraft() {
    selectionRange = null;
    commentFormAnchor = null;
    commentInput = "";
  }

  async function handleToggleBookmark() {
    await planStore.toggleBookmark(plan.id);
  }

  function closeModal() {
    if (isPreview) {
      // A previewed plan opened in split lives in the secondary pane — its X must
      // close only that pane (R1), not dismiss the whole preview back to the gallery.
      if (slot === "secondary") {
        planStore.dismissPreview();
        onClose?.();
      } else {
        session.closePlanPreview();
      }
    } else if (onClose) onClose();
    else session.closePlanModal();
  }

  function handleEscape() {
    if (commentFormAnchor) clearCommentDraft();
    else if (editingCommentId) editingCommentId = null;
    else closeModal();
  }

  useKeybinding(
    "plan-modal.start-comment",
    () => {
      if (selectionRange && !commentFormAnchor) handleStartComment();
    },
    { enabled: () => !!(selectionRange && !commentFormAnchor) },
  );
  useKeybinding("plan-modal.toggle-bookmark", () => handleToggleBookmark());
  useKeybinding("plan-modal.toggle-comments", () => {
    commentsRailOpen = !commentsRailOpen;
  });
  useKeybinding(
    "plan-modal.resume",
    () => {
      if (isPreview) {
        const d = planStore.previewDescriptor;
        if (d) session.resumeSessionFromDescriptor(d);
      }
    },
    { enabled: () => isPreview },
  );
  useKeybinding("plan-modal.new-tab", () => {
    void session.createTab();
  });

  function handleSave(md: string) {
    planStore.updateContent(plan.id, md);
    return planStore.flushContentSave(plan.id);
  }

  // Wire comment selection + initial mark restore once the shell's editor is ready.
  function handleEditorReady(editor: Editor) {
    editor.on("selectionUpdate", () => {
      // Only surface the comment affordance for a real cursor selection — ignore
      // programmatic ones (find/replace, mark restore, agent rewrites).
      if (!isUserSelection(editor)) {
        selectionRange = null;
        return;
      }
      const { from, to } = editor.state.selection;
      if (from === to) {
        selectionRange = null;
        return;
      }
      const selectedText = editor.state.doc.textBetween(from, to, " ");
      if (selectedText.trim().length < 3) {
        selectionRange = null;
        return;
      }
      const startCoords = editor.view.coordsAtPos(from);
      const endCoords = editor.view.coordsAtPos(to);
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
    restoreCommentMarks(editor, plan.comments);
    suppressSave = false;
  }

  // --- Comments ---

  function handleStartComment() {
    if (!selectionRange || !scrollContainer) return;
    const formWidth = Math.min(500, window.innerWidth - 32);
    commentFormAnchor = {
      left: Math.min(selectionRange.left, window.innerWidth - formWidth - 16),
      top: selectionRange.bottom + 8,
      width: formWidth,
    };
    commentInput = "";
  }

  async function handleSaveComment() {
    if (!selectionRange || !commentInput.trim() || !tiptapEditor) return;
    const container = scrollContainer;
    const savedScroll = container?.scrollTop ?? 0;

    // Persist any pending content edits before the comment mark is added.
    await shell?.flushSave();

    const textOffset = prosePosToTextOffset(tiptapEditor, selectionRange.from);
    const newComment: PlanComment = {
      id: uuid(),
      selectedText: selectionRange.selectedText,
      comment: commentInput.trim(),
      textOffset,
    };
    planStore.addComment(plan.id, newComment);

    const { from, to } = selectionRange;
    suppressSave = true;
    addCommentMark(tiptapEditor, from, to, newComment.id);
    suppressSave = false;

    clearCommentDraft();
    commentsRailOpen = true;

    await tick();
    if (container) {
      container.scrollTop = savedScroll;
      requestAnimationFrame(() => {
        container.scrollTop = savedScroll;
      });
    }
  }

  function handleSaveCommentEdit(commentId: string, text: string) {
    planStore.updateComment(plan.id, commentId, text);
    editingCommentId = null;
  }

  function handleCancelCommentEdit() {
    editingCommentId = null;
  }

  function handleDeleteComment(commentId: string) {
    const deleted = comments.find((c) => c.id === commentId);
    planStore.removeComment(plan.id, commentId);
    if (editingCommentId === commentId) editingCommentId = null;
    if (tiptapEditor) {
      suppressSave = true;
      removeCommentMark(tiptapEditor, commentId);
      suppressSave = false;
    }
    // Offer an undo: re-adding the comment lets the mark-restore effect re-anchor it.
    if (deleted) {
      toasts.undo("Comment deleted", () => {
        planStore.addComment(plan.id, deleted);
        commentsRailOpen = true;
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
      const mark = findMarkElement(scrollContainer, commentId);
      mark?.classList.add("plan-comment-active");
    } else {
      scrollContainer
        .querySelectorAll("mark.plan-comment-active")
        .forEach((m) => m.classList.remove("plan-comment-active"));
    }
  }
</script>

<DocumentShell
  bind:this={shell}
  title="Review Plan"
  content={plan.content}
  {inline}
  iconOnlyHeaderActions={slot === "secondary"}
  editorClass="plan-document-editor"
  rootClass="plan-shell"
  scope="plan-modal"
  bindings={{ close: "plan-modal.close", save: "plan-modal.save", copy: "plan-modal.copy", googleUpload: "plan-modal.google-upload", find: "plan-modal.find" }}
  extraExtensions={commentExtensions}
  onSave={handleSave}
  onClose={closeModal}
  onEscape={handleEscape}
  onEditorReady={handleEditorReady}
  bind:tiptapEditor
  bind:scrollContainer
  bind:suppressSave
  rootTestId="plan-modal"
  closeTestId="plan-modal-close"
  scrollAriaLabel="Plan document"
  scrollClass={commentsRailInLayout ? "" : "plan-editor-scroll--no-rail"}
  placeholder="Start writing…"
>
  {#snippet headerMeta()}
    {#if revisionCount > 1}
      <div class="relative shrink-0">
        <button
          bind:this={revisionTriggerEl}
          type="button"
          onclick={() => {
            if (revisionDropdownOpen) {
              revisionDropdownOpen = false;
              revisionPanelPos = null;
            } else {
              const rect = revisionTriggerEl?.getBoundingClientRect();
              if (rect) revisionPanelPos = { top: rect.bottom + 6, left: rect.left };
              revisionDropdownOpen = true;
            }
          }}
          class="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-(--solus-container-border) bg-transparent px-2 py-0.5 text-[0.6875rem] text-(--solus-text-secondary) transition-[background,color,border-color] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) max-md:px-[0.3125rem] max-md:text-[0.625rem]"
        >
          v{currentRevisionIndex + 1} of {revisionCount}
          <CaretDownIcon size={10} />
        </button>
      </div>
    {/if}
  {/snippet}

  {#snippet headerActions({ copied, copy, googleUpload, uploading, uploaded })}
    <button
      type="button"
      onclick={() => (commentsRailOpen = !commentsRailOpen)}
      class="plan-soft-pill"
      class:plan-soft-pill--active={commentsRailOpen}
      title={commentsRailOpen ? "Hide comments (⌥M)" : "Show comments (⌥M)"}
      aria-label={commentsRailOpen ? "Hide comments" : "Show comments"}
    >
      <ChatCircleTextIcon size={13} />
      <span class="plan-soft-pill__label">Comments{comments.length > 0 ? ` (${comments.length})` : ""}</span>
    </button>
    <button
      type="button"
      onclick={handleToggleBookmark}
      class="plan-soft-pill plan-soft-pill--icon"
      class:plan-soft-pill--active={isBookmarked}
      title={isBookmarked ? "Bookmarked (⌥B)" : "Bookmark (⌥B)"}
      aria-label={isBookmarked ? "Bookmarked" : "Bookmark"}
    >
      <BookmarkSimpleIcon size={14} weight={isBookmarked ? "fill" : "regular"} class={isBookmarked ? "text-(--solus-accent)" : ""} />
    </button>
    {#if inline && onOpenInSplit}
      <button
        type="button"
        onclick={() => { onOpenInSplit?.(); }}
        class="plan-soft-pill plan-soft-pill--icon"
        data-testid="open-in-split"
        title={slot === "secondary" ? "Focus" : "Open in split"}
        aria-label={slot === "secondary" ? "Focus" : "Open in split"}
      >
        {#if slot === "secondary"}
          <ArrowsOutSimpleIcon size={14} />
        {:else}
          <ArrowSquareOutIcon size={14} />
        {/if}
      </button>
    {/if}
    <!-- Secondary actions (open session, Google Docs, copy) collapse into one overflow menu. -->
    <DropdownMenu.Root bind:open={overflowOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class="plan-soft-pill plan-soft-pill--icon" class:plan-soft-pill--active={overflowOpen} data-testid="work-actions-menu" title="More actions" aria-label="More actions">
            <DotsThreeIcon size={16} weight="bold" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="end" sideOffset={6} class="w-[190px]">
        {#if isPreview}
          <DropdownMenu.Item onSelect={() => { const d = planStore.previewDescriptor; if (d) session.resumeSessionFromDescriptor(d); }}>
            <ArrowUpRightIcon size={14} /><span class="flex-1 text-left">Open session</span>{#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥O</Kbd></span>{/if}
          </DropdownMenu.Item>
          <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        {/if}
        {#if googleUpload}
          <!-- Keep the menu open so the upload state stays visible. -->
          <DropdownMenu.Item data-testid="google-upload" disabled={uploading} closeOnSelect={false} onSelect={() => googleUpload?.()}>
            {#if uploaded}
              <CheckIcon size={14} /><span class="flex-1 text-left">Opened!</span>
            {:else}
              <ArrowSquareOutIcon size={14} /><span class="flex-1 text-left">{uploading ? "Uploading…" : "Open in Google Docs"}</span>
            {/if}
            {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥G</Kbd></span>{/if}
          </DropdownMenu.Item>
        {/if}
        {#if googleUpload}
          <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        {/if}
        <DropdownMenu.Item onSelect={copy}>
          {#if copied}<CheckIcon size={14} /><span class="flex-1 text-left">Copied!</span>{:else}<CopyIcon size={14} /><span class="flex-1 text-left">Copy plan</span>{/if}
          {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥C</Kbd></span>{/if}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}

  {#snippet rail()}
    {#if commentsRailOpen}
      <div
        class="plan-comments-rail-sleeve"
        transition:fly={{ x: 264, duration: 200, opacity: 0 }}
        onoutroend={() => {
          if (!commentsRailOpen) commentsRailInLayout = false;
        }}
      >
        <PlanCommentsRail
          {comments}
          activeCommentId={hoveredMarkId ?? activeRailCommentId}
          {editingCommentId}
          emptyHint="Select text or press ⌘M to add one."
          onScrollTo={handleScrollToComment}
          onHover={handleHoverRailComment}
          onStartEdit={(commentId) => {
            editingCommentId = commentId;
            activeRailCommentId = commentId;
          }}
          onSaveEdit={handleSaveCommentEdit}
          onCancelEdit={handleCancelCommentEdit}
          onDelete={handleDeleteComment}
          onClose={() => (commentsRailOpen = false)}
        />
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    <div class="plan-action-bar-sleeve shrink-0 px-5 pt-2 pb-3 max-md:px-3 max-md:pb-2">
      <PlanActionBar
        planId={plan.id}
        inlineCommentCount={comments.length}
        compact={isMobile}
        forceShowWorktreeToggle={isPreview}
        onDone={closeModal}
      />
    </div>
  {/snippet}

  {#snippet overlays()}
    <!-- Floating comment button at selection -->
    {#if selectionRange && !commentFormAnchor}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        use:portal={document.body}
        data-floating-comment
        data-solus-ui
        class="fixed"
        style="left:{(selectionRange.left + selectionRange.right) /
          2}px;top:{selectionRange.top}px;z-index:10001;transform:translate(-50%, calc(-100% - 0.375rem))"
        transition:fly={{ y: 4, duration: 120, opacity: 0 }}
      >
        <Button
          variant="outline"
          size="sm"
          onmousedown={(e) => e.preventDefault()}
          onclick={handleStartComment}
          class="border-(--solus-popover-border) bg-(--solus-popover-bg) text-(--solus-accent) shadow-(--solus-popover-shadow) backdrop-blur-[1.25rem] hover:-translate-y-[0.0625rem] hover:border-(--solus-accent) hover:bg-(--solus-accent) hover:text-(--solus-text-on-accent) active:translate-y-0 active:scale-[0.97] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
          title="Add comment (⌘M)"
        >
          <ChatCircleTextIcon size={13} />
          Comment
          <Kbd variant="inline" class="ml-[0.1875rem] opacity-45 max-md:hidden">⌘M</Kbd>
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
        class="fixed plan-comment-form-in plan-comment-form-position"
        style="--cf-left:{commentFormAnchor.left}px;--cf-top:{commentFormAnchor.top}px;--cf-width:{commentFormAnchor.width}px;z-index:10001"
      >
        <div class="plan-inline-comment-form flex flex-col gap-1.5 rounded-[0.625rem] border border-(--solus-accent-border) bg-(--solus-popover-bg) px-[0.625rem] pb-2 pt-2 shadow-(--solus-popover-shadow) backdrop-blur-[1.25rem] max-md:rounded-b-none">
          <MarkdownTextarea
            bind:ref={commentInputEl}
            bind:value={commentInput}
            bare
            mic
placeholder="Add comment…"
            rows={1}
            submitOn="enter"
            onSubmit={handleSaveComment}
            class="plan-inline-comment-form__textarea"
            onkeydown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) e.stopPropagation();
              if (e.key === "Escape") {
                e.stopPropagation();
                clearCommentDraft();
              }
            }}
          />
          <div class="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onclick={clearCommentDraft}
              class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
              title="Cancel (Esc)"
            >
              <XIcon size={13} />
            </Button>
            <Button
              size="sm"
              onclick={handleSaveComment}
              disabled={!commentInput.trim()}
            >
              Comment
            </Button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Revision dropdown panel -->
    {#if revisionDropdownOpen && revisionPanelPos}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        use:portal={document.body}
        data-solus-ui
        class="fixed"
        style="top:{revisionPanelPos.top}px;left:{revisionPanelPos.left}px;z-index:10002"
        data-revision-panel
        transition:fly={{ y: -4, duration: 140, opacity: 0 }}
      >
        <div class="min-w-[12.5rem] overflow-hidden rounded-[0.625rem] border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) backdrop-blur-[1.25rem] backdrop-saturate-[1.1]">
          {#each planRevisions as rev, i (rev.id)}
            <button
              type="button"
              onclick={() => {
                session.openPlanModal(rev.id);
                revisionDropdownOpen = false;
                revisionPanelPos = null;
              }}
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-[0.5625rem] py-1.5 text-left text-xs transition-[background] duration-(--duration-quick) ease-(--ease-premium) {rev.id === plan.id
                ? 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-soft)'
                : 'bg-transparent text-(--solus-text-primary) hover:bg-(--solus-surface-hover)'}"
            >
              <span class="font-semibold tabular-nums">v{i + 1}</span>
              <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] {rev.id === plan.id
                ? 'text-[color-mix(in_srgb,var(--solus-accent)_70%,var(--solus-text-secondary))]'
                : 'text-(--solus-text-tertiary)'}">
                {new Date(rev.timestamp).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {#if rev.status === "accepted"}
                <CheckCircleIcon size={11} weight="fill" class="text-(--solus-status-complete)" />
              {:else if rev.status === "rejected"}
                <XCircleIcon size={11} weight="fill" class="text-(--solus-text-tertiary)" />
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

  {/snippet}
</DocumentShell>
