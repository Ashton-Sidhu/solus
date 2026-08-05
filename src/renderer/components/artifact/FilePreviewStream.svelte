<script lang="ts">
  import { mount, onMount, unmount, untrack } from "svelte";
  import {
    File as PierreFile,
    type FileContents,
    type FileOptions,
    type LineAnnotation,
    type SelectedLineRange,
  } from "@pierre/diffs";
  import { Editor } from "@pierre/diffs/edit";
  import type { DiffComment, IpcContext } from "../../../shared/types";
  import { DIFFS_THEME_CSS } from "../../lib/diffTheme";
  import {
    getDiffThemeName,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
  } from "../../lib/diff-worker-pool";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import DiffCommentForm from "../diff/DiffCommentForm.svelte";
  import DiffInlineComment from "../diff/DiffInlineComment.svelte";
  import DiffActionBar from "../diff/DiffActionBar.svelte";
  import { InlineCommentDraft } from "../diff/diff-comment-draft.store.svelte";
  import {
    fileContentVersion,
    isolateFileCommentEvents,
    rangeFromRemappedAnchor,
    selectedTextForFileRange,
  } from "./lib/file-comments";
  import {
    fileFindPosition,
    isFileFindShortcut,
    shouldRestoreFileEditorFocus,
  } from "./lib/file-find";

  export type FileSaveState =
    | "idle"
    | "dirty"
    | "saving"
    | "saved"
    | "error"
    | "conflict";

  const LINKED_LINE_CSS = `
    [data-solus-linked-line] {
      --diffs-line-bg: var(--solus-accent-light) !important;
      background-color: var(--solus-accent-light) !important;
    }
    [data-column-number][data-solus-linked-line] {
      color: var(--solus-accent) !important;
      box-shadow: inset 2px 0 var(--solus-accent);
    }
  `;

  // Pierre owns file-editor search behavior inside its shadow root. Restyle that
  // widget to the same geometry and visual language as Solus's shared FindBar;
  // the editor's extra whole-word and regex controls remain available.
  const FILE_EDITOR_FIND_CSS = `
    :host {
      --diffs-editor-match-bg: var(--solus-diff-find-active-bg);
      --diffs-editor-match-highlight-bg: var(--solus-diff-find-bg);
    }
    [data-search-panel] {
      position: fixed;
      top: var(--solus-file-find-top, 8px);
      right: auto;
      left: var(--solus-file-find-left, 0);
      width: var(--solus-file-find-width, 100%);
    }
    [data-search-panel] [data-editor-widget] {
      width: min(22rem, calc(100% - 1.5rem));
      min-width: 0;
      margin-inline: auto 0.75rem;
      padding: 0.375rem;
      border: 0.0625rem solid var(--solus-popover-border);
      border-radius: 0.625rem;
      background: var(--solus-popover-bg);
      box-shadow: var(--solus-popover-shadow);
      backdrop-filter: blur(1.25rem) saturate(1.1);
      -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
    }
    [data-search-grid],
    [data-search-grid][data-mode="find"] {
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      grid-template-areas: "find matches nav close";
      gap: 0.1875rem;
    }
    [data-search-grid][data-mode="replace"] {
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      grid-template-areas:
        "find matches nav close"
        "replace actions actions actions";
      gap: 0.25rem 0.1875rem;
    }
    [data-search-grid] [data-input-box] {
      width: auto;
      min-width: 0;
    }
    [data-input-box] input {
      height: 1.625rem;
      color: var(--solus-text-primary);
      background: var(--solus-surface-hover);
      border: 0;
      border-radius: 0.375rem;
      padding-inline: 0.5rem;
      font-size: 0.75rem;
      line-height: 1.625rem;
      box-shadow: none;
    }
    [data-input-box] input:focus-visible {
      outline: 0.0625rem solid var(--solus-accent-border);
    }
    [data-input-box][data-find] input {
      padding-inline-end: 4.5rem;
    }
    [data-matches] {
      min-width: 3.25rem;
      padding-inline: 0.25rem;
      color: var(--solus-text-tertiary);
      text-align: right;
      font-size: 0.6875rem;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
      line-height: 1.5rem;
    }
    [data-search-icon] {
      --diffs-search-icon-size: 1.5rem;
      color: var(--solus-text-tertiary);
      border-radius: 0.375rem;
      transition:
        scale var(--duration-quick) var(--ease-premium),
        background var(--duration-quick) var(--ease-premium),
        color var(--duration-quick) var(--ease-premium);
    }
    [data-search-icon]:not(:disabled):hover {
      color: var(--solus-text-primary);
      background: var(--solus-surface-hover);
    }
    [data-search-icon]:not(:disabled):active {
      scale: 0.96;
    }
    [data-search-icon][aria-pressed="true"] {
      color: var(--solus-accent);
      background: var(--solus-accent-light);
    }
    [data-search-icon]:focus-visible {
      outline: 0.125rem solid var(--solus-accent-border);
      outline-offset: 0.0625rem;
    }
    [data-search-close] {
      --diffs-search-icon-size: 1.5rem;
      grid-area: close;
      position: static;
      color: var(--solus-text-tertiary);
      background: transparent;
      transform: none;
    }
    [data-search-close]:not(:disabled):hover {
      color: var(--solus-text-primary);
      background: var(--solus-surface-hover);
    }
    @media (prefers-reduced-motion: reduce) {
      [data-search-icon] {
        transition: none;
      }
    }
  `;

  function installFileEditorFindStyles() {
    const fileElement = rootEl?.firstElementChild;
    const shadowRoot = fileElement?.shadowRoot;
    if (!shadowRoot) return;
    let style = shadowRoot.querySelector<HTMLStyleElement>(
      "style[data-solus-file-find-css]",
    );
    if (!style) {
      style = document.createElement("style");
      style.dataset.solusFileFindCss = "";
      shadowRoot.append(style);
    }
    style.textContent = FILE_EDITOR_FIND_CSS;
    syncFileEditorFindPosition();
    watchFileFindFocus(shadowRoot);
  }

  function watchFileFindFocus(shadowRoot: ShadowRoot) {
    fileFindPanelObserver?.disconnect();
    let wasFindOpen = !!shadowRoot.querySelector("[data-search-panel]");
    fileFindPanelObserver = new MutationObserver(() => {
      const isFindOpen = !!shadowRoot.querySelector("[data-search-panel]");
      if (!wasFindOpen && isFindOpen) {
        requestAnimationFrame(() => {
          const input = shadowRoot.querySelector<HTMLInputElement>("[data-search]");
          input?.focus({ preventScroll: true });
          input?.select();
        });
      } else if (shouldRestoreFileEditorFocus(wasFindOpen, isFindOpen)) {
        requestAnimationFrame(() => {
          if (rootEl?.isConnected) editor?.focus({ preventScroll: true });
        });
      }
      wasFindOpen = isFindOpen;
    });
    fileFindPanelObserver.observe(shadowRoot, { childList: true, subtree: true });
  }

  function syncFileEditorFindPosition() {
    const fileElement = rootEl?.firstElementChild;
    const paneElement = rootEl?.closest<HTMLElement>("[data-file-editor-pane]");
    if (!(fileElement instanceof HTMLElement) || !paneElement) return;
    const position = fileFindPosition(paneElement.getBoundingClientRect());
    fileElement.style.setProperty("--solus-file-find-top", `${position.top}px`);
    fileElement.style.setProperty("--solus-file-find-left", `${position.left}px`);
    fileElement.style.setProperty("--solus-file-find-width", `${position.width}px`);
  }

  function isolateFileFindEvents(event: KeyboardEvent) {
    if (isFileFindShortcut(event)) {
      event.stopPropagation();
      return;
    }
    const findPanel = event
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.searchPanel !== undefined,
      );
    if (event.key !== "Escape" || !findPanel) return;
    event.preventDefault();
    event.stopPropagation();
    if (findPanel.isConnected) {
      findPanel.querySelector<HTMLButtonElement>("[data-search-close]")?.click();
    }
  }

  interface Props {
    api?: typeof window.solus;
    ctx: IpcContext;
    cwd: string;
    filePath: string;
    displayPath: string;
    contents: string;
    isDark: boolean;
    isReadOnly?: boolean;
    line?: number;
    /**
     * Bumped by the caller each time a reveal is *requested*, so asking for the
     * same file and line twice (walking search results in one file, clicking
     * the same hit after dismissing it) scrolls and highlights again. Comparing
     * `line` alone cannot see a repeated request.
     */
    revealEpoch?: number;
    onSaveStateChange?: (state: FileSaveState) => void;
  }

  let {
    api = window.solus,
    ctx,
    cwd,
    filePath,
    displayPath,
    contents,
    isDark,
    isReadOnly = false,
    line,
    revealEpoch = 0,
    onSaveStateChange,
  }: Props = $props();

  type AnnotationMeta =
    | { kind: "comment"; comment: DiffComment; lineSpan: number }
    | { kind: "draft"; lineSpan: number };

  const workspace = getWorkspaceContext();
  const targetTabId = $derived(ctx.session.tabId);
  const targetTab = $derived(workspace.tabs[targetTabId]);
  const commentPath = $derived(displayPath || filePath);
  const comments = $derived<DiffComment[]>(targetTab?.diffComments ?? []);
  const fileComments = $derived(
    comments.filter((comment) => comment.filePath === commentPath),
  );
  const annotationVersion = $derived(
    fileComments
      .map(
        (comment) =>
          `${comment.id}:${comment.startLine}:${comment.endLine}:${comment.comment}`,
      )
      .join("|"),
  );
  const draft = new InlineCommentDraft();

  let rootEl: HTMLDivElement | null = $state(null);
  let draftFormWrapper: HTMLDivElement | null = $state(null);
  let draftForm: ReturnType<typeof DiffCommentForm> | null = $state(null);
  let fileInstance: PierreFile<AnnotationMeta> | null = null;
  let editor: Editor<AnnotationMeta> | null = null;
  let detachEditor: (() => void) | null = null;
  let fileFindPanelObserver: MutationObserver | null = null;
  let mountedComments: ReturnType<typeof mount>[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedContents = "";
  let latestContents = "";
  let saveGeneration = 0;
  let linkedLineRequestKey = "";
  let linkedLineDismissed = false;
  let renderedCommentPath = untrack(() => displayPath || filePath);

  useScope("file-editor");
  useKeybinding("file-editor.save", () => {
    if (isReadOnly) return;
    void flushSave();
  });

  function setSaveState(state: FileSaveState) {
    onSaveStateChange?.(state);
  }

  function syncContainerBackground() {
    const container = rootEl?.firstElementChild;
    if (container instanceof HTMLElement) {
      container.style.backgroundColor = "var(--solus-container-bg)";
    }
  }

  function buildOptions(): FileOptions<AnnotationMeta> {
    return {
      theme: getDiffThemeName(isDark),
      themeType: isDark ? "dark" : "light",
      useTokenTransformer: true,
      lineHoverHighlight: "disabled",
      overflow: "wrap",
      disableFileHeader: true,
      disableErrorHandling: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      unsafeCSS: `${DIFFS_THEME_CSS}\n${LINKED_LINE_CSS}`,
      onPostRender: (_container, _instance, phase) => {
        if (phase !== "unmount") requestAnimationFrame(markLinkedLine);
      },
      renderAnnotation: (annotation) => {
        if (annotation.metadata.kind === "draft") {
          return draftFormWrapper ?? document.createElement("div");
        }
        const target = document.createElement("div");
        const instance = mount(DiffInlineComment, {
          target,
          props: {
            comment: annotation.metadata.comment,
            onEdit: editComment,
            onDelete: deleteComment,
          },
        });
        mountedComments.push(instance);
        return target;
      },
      onGutterUtilityClick: openDraftForRange,
      onLineSelected: (range) => {
        if (range) openDraftForRange(range);
      },
    };
  }

  function buildAnnotations(): LineAnnotation<AnnotationMeta>[] {
    const annotations: LineAnnotation<AnnotationMeta>[] = fileComments
      .filter((comment) => comment.id !== draft.editingCommentId)
      .map((comment) => ({
        lineNumber: comment.endLine,
        metadata: {
          kind: "comment" as const,
          comment,
          lineSpan: comment.endLine - comment.startLine,
        },
      }));
    if (draft.filePath === commentPath && draft.range) {
      annotations.push({
        lineNumber: draft.range.endLine,
        metadata: {
          kind: "draft",
          lineSpan: draft.range.endLine - draft.range.startLine,
        },
      });
    }
    return annotations;
  }

  function unmountComments() {
    mountedComments.forEach((instance) => unmount(instance));
    mountedComments = [];
  }

  function syncAnnotations() {
    if (!fileInstance) return;
    unmountComments();
    fileInstance.render({
      file: buildFile(),
      lineAnnotations: buildAnnotations(),
      forceRender: true,
    });
    syncContainerBackground();
    if (draft.range) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => draftForm?.focusInput());
      });
    }
  }

  function persistDraft() {
    if (!draft.filePath || !draft.range) {
      workspace.setDiffCommentDraft(null, targetTabId);
      return;
    }
    workspace.setDiffCommentDraft(
      {
        filePath: draft.filePath,
        startLine: draft.range.startLine,
        endLine: draft.range.endLine,
        side: "new",
        editingCommentId: draft.editingCommentId,
        value: draft.value,
      },
      targetTabId,
    );
  }

  function openDraftForRange(range: SelectedLineRange) {
    const startLine = Math.min(range.start, range.end);
    const endLine = Math.max(range.start, range.end);
    const keepsValue =
      draft.filePath === commentPath && draft.editingCommentId === null;
    draft.filePath = commentPath;
    draft.range = { startLine, endLine, side: "new" };
    if (!keepsValue) {
      draft.editingCommentId = null;
      draft.value = "";
    }
    persistDraft();
  }

  function resetDraft() {
    draft.clear();
    workspace.setDiffCommentDraft(null, targetTabId);
    fileInstance?.setSelectedLines(null);
  }

  function saveComment(commentText: string) {
    if (!draft.range || !draft.filePath) return;
    if (draft.editingCommentId) {
      workspace.updateDiffComment(
        draft.editingCommentId,
        commentText,
        targetTabId,
      );
      resetDraft();
      editor?.focus();
      return;
    }
    workspace.addDiffComment(
      {
        id: crypto.randomUUID(),
        filePath: draft.filePath,
        startLine: draft.range.startLine,
        endLine: draft.range.endLine,
        side: "new",
        selectedCode: selectedTextForFileRange(latestContents, draft.range),
        comment: commentText,
        createdAt: Date.now(),
      },
      targetTabId,
    );
    resetDraft();
    editor?.focus();
  }

  function editComment(comment: DiffComment) {
    draft.filePath = comment.filePath;
    draft.range = {
      startLine: comment.startLine,
      endLine: comment.endLine,
      side: "new",
    };
    draft.editingCommentId = comment.id;
    draft.value = comment.comment;
    persistDraft();
    fileInstance?.setSelectedLines({
      start: comment.startLine,
      end: comment.endLine,
    });
  }

  function deleteComment(commentId: string) {
    const index = comments.findIndex((comment) => comment.id === commentId);
    const comment = comments[index];
    if (!comment) return;
    if (draft.editingCommentId === commentId) resetDraft();
    workspace.removeDiffComment(commentId, targetTabId);
    toasts.undo("Comment removed", () => {
      workspace.restoreDiffComment(comment, index, targetTabId);
    });
  }

  function savePendingDraft() {
    const value = draft.value.trim();
    if (value) saveComment(value);
  }

  function updateDraftValue(value: string) {
    draft.value = value;
    workspace.updateDiffCommentDraftValue(value, targetTabId);
  }

  function applyRemappedAnnotations(
    nextContents: string,
    annotations: LineAnnotation<AnnotationMeta>[] | undefined,
  ) {
    for (const annotation of annotations ?? []) {
      const range = rangeFromRemappedAnchor(
        annotation.lineNumber,
        annotation.metadata.lineSpan,
      );
      if (annotation.metadata.kind === "draft") {
        if (!draft.range) continue;
        draft.range = { ...range, side: "new" };
        persistDraft();
        continue;
      }
      const comment = annotation.metadata.comment;
      comment.startLine = range.startLine;
      comment.endLine = range.endLine;
      comment.selectedCode = selectedTextForFileRange(nextContents, range);
    }
  }

  function buildFile(value = latestContents): FileContents {
    return {
      name: displayPath || filePath,
      contents: value,
      cacheKey: `${filePath}:${fileContentVersion(value)}`,
    };
  }

  function syncLinkedLineRequest() {
    const nextKey = line ? `${filePath}:${line}:${revealEpoch}` : "";
    if (nextKey === linkedLineRequestKey) return;
    linkedLineRequestKey = nextKey;
    linkedLineDismissed = false;
  }

  function clearLinkedLineMarker(shadowRoot: ShadowRoot) {
    for (const element of shadowRoot.querySelectorAll("[data-solus-linked-line]")) {
      element.removeAttribute("data-solus-linked-line");
    }
  }

  function markLinkedLine(): Element | null {
    syncLinkedLineRequest();
    const shadowRoot = rootEl?.firstElementChild?.shadowRoot;
    if (!shadowRoot) return null;

    clearLinkedLineMarker(shadowRoot);
    if (!line || linkedLineDismissed) return null;

    const lineElement = shadowRoot.querySelector(`[data-line="${line}"]`);
    const gutterElement = shadowRoot.querySelector(`[data-column-number="${line}"]`);
    lineElement?.setAttribute("data-solus-linked-line", "");
    gutterElement?.setAttribute("data-solus-linked-line", "");
    return lineElement;
  }

  function dismissLinkedLine() {
    syncLinkedLineRequest();
    linkedLineDismissed = true;
    const shadowRoot = rootEl?.firstElementChild?.shadowRoot;
    if (shadowRoot) clearLinkedLineMarker(shadowRoot);
  }

  function revealLinkedLine() {
    if (!line || !rootEl) {
      markLinkedLine();
      return;
    }
    requestAnimationFrame(() => {
      const lineElement = markLinkedLine();
      lineElement?.scrollIntoView({ block: "center" });
    });
  }

  async function flushSave() {
    if (isReadOnly) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const contentsToSave = latestContents;
    if (contentsToSave === lastSavedContents) return;

    const generation = ++saveGeneration;
    setSaveState("saving");
    const result = await api.writeFile(ctx, {
      path: filePath,
      cwd,
      contents: contentsToSave,
      expectedContents: lastSavedContents,
    });
    if (generation !== saveGeneration) return;
    if (result.ok) {
      lastSavedContents = contentsToSave;
      setSaveState("saved");
    } else if (result.conflict) {
      setSaveState("conflict");
      toasts.error(`${displayPath || filePath} changed on disk. Reload before saving.`);
    } else {
      setSaveState("error");
      toasts.error(`Save failed: ${displayPath || filePath} — ${result.error}`);
    }
  }

  function scheduleSave(nextContents: string) {
    if (isReadOnly) return;
    latestContents = nextContents;
    setSaveState("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushSave();
    }, 500);
  }

  onMount(() => {
    if (!rootEl) return;
    let disposed = false;
    rootEl.addEventListener("pointerdown", dismissLinkedLine);
    rootEl.addEventListener("keydown", isolateFileFindEvents);
    const paneElement = rootEl.closest<HTMLElement>("[data-file-editor-pane]");
    const findPositionObserver = paneElement
      ? new ResizeObserver(syncFileEditorFindPosition)
      : null;
    if (paneElement) findPositionObserver?.observe(paneElement);
    window.addEventListener("resize", syncFileEditorFindPosition);
    requestAnimationFrame(syncFileEditorFindPosition);
    const stopCommentFormEvents = draftFormWrapper
      ? isolateFileCommentEvents(draftFormWrapper)
      : () => {};

    const unsubscribe = onDiffWorkerPoolReady(() => {
      if (disposed || !rootEl || fileInstance) return;
      void setDiffWorkerPoolTheme(isDark).then(() => {
        if (disposed || !rootEl || fileInstance) return;
        // No worker pool: the shared diff pool's render options win over a
        // File's per-instance options and it intentionally omits
        // `useTokenTransformer`, which the @pierre/diffs editor requires for an
        // editable AST. Rendering on the main thread honors our
        // `useTokenTransformer: true` so the editor can attach and accept input.
        const persistedDraft = targetTab?.diffCommentDraft;
        if (persistedDraft?.filePath === commentPath) {
          draft.filePath = persistedDraft.filePath;
          draft.range = {
            startLine: persistedDraft.startLine,
            endLine: persistedDraft.endLine,
            side: "new",
          };
          draft.editingCommentId = persistedDraft.editingCommentId;
          draft.value = persistedDraft.value;
        }
        fileInstance = new PierreFile<AnnotationMeta>(buildOptions());
        fileInstance.render({
          file: buildFile(contents),
          containerWrapper: rootEl,
          lineAnnotations: buildAnnotations(),
        });
        if (!isReadOnly) {
          editor = new Editor<AnnotationMeta>({
            onAttach: installFileEditorFindStyles,
            onChange: (file, annotations) => {
              scheduleSave(file.contents);
              applyRemappedAnnotations(
                file.contents,
                annotations as LineAnnotation<AnnotationMeta>[] | undefined,
              );
            },
          });
          detachEditor = editor.edit(fileInstance);
        }
        syncContainerBackground();
        revealLinkedLine();
      });
    });

    return () => {
      disposed = true;
      rootEl?.removeEventListener("pointerdown", dismissLinkedLine);
      rootEl?.removeEventListener("keydown", isolateFileFindEvents);
      findPositionObserver?.disconnect();
      window.removeEventListener("resize", syncFileEditorFindPosition);
      fileFindPanelObserver?.disconnect();
      fileFindPanelObserver = null;
      stopCommentFormEvents();
      unsubscribe();
      void flushSave();
      detachEditor?.();
      detachEditor = null;
      editor?.cleanUp();
      editor = null;
      unmountComments();
      fileInstance?.cleanUp();
      fileInstance = null;
    };
  });

  $effect(() => {
    void isDark;
    if (!fileInstance) return;
    void setDiffWorkerPoolTheme(isDark);
    untrack(() => fileInstance?.setOptions(buildOptions()));
    untrack(() => fileInstance?.setThemeType(isDark ? "dark" : "light"));
    untrack(() => syncContainerBackground());
  });

  $effect(() => {
    void annotationVersion;
    void draft.range;
    void draft.editingCommentId;
    void draft.filePath;
    if (!fileInstance) return;
    untrack(syncAnnotations);
  });

  $effect(() => {
    void filePath;
    void displayPath;
    void contents;
    const nextCommentPath = displayPath || filePath;
    if (renderedCommentPath !== nextCommentPath) {
      if (draft.value.trim()) untrack(savePendingDraft);
      else if (draft.range) untrack(resetDraft);
      renderedCommentPath = nextCommentPath;
    }
    lastSavedContents = contents;
    latestContents = contents;
    setSaveState("idle");
    if (!fileInstance) return;
    fileInstance.setOptions(buildOptions());
    unmountComments();
    fileInstance.render({
      file: buildFile(contents),
      lineAnnotations: buildAnnotations(),
      forceRender: true,
    });
    untrack(() => syncContainerBackground());
    untrack(() => revealLinkedLine());
  });

  $effect(() => {
    if (!fileInstance) return;
    revealLinkedLine();
  });
</script>

<div class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
  <div
    bind:this={rootEl}
    class="pierre-file-host relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain text-[length:var(--solus-code-font-size,0.7813rem)] leading-[1.6]"
  ></div>

  <div bind:this={draftFormWrapper} class="solus-inline-draft-portal">
    {#if draft.filePath === commentPath && draft.range}
      <DiffCommentForm
        bind:this={draftForm}
        onSave={saveComment}
        onCancel={resetDraft}
        rangeLabel={draft.rangeLabel}
        initialValue={draft.value}
        onFormValueChange={updateDraftValue}
      />
    {/if}
  </div>

  <DiffActionBar tabId={targetTabId} filePath={commentPath} />
</div>

<style>
  .pierre-file-host {
    --diffs-font-family: var(--solus-code-font-family);
    --diffs-font-size: var(--solus-code-font-size, 0.75rem);
    --diffs-line-height: calc(var(--solus-code-font-size, 0.75rem) * 1.6);
  }
  .pierre-file-host :global(diffs-component) {
    display: block;
  }
  :global(.solus-inline-draft-portal) {
    display: none;
  }
  :global([data-annotation-slot] > .solus-inline-draft-portal) {
    display: block;
    padding: 0.5rem 0.75rem 0.625rem;
    user-select: text;
    -webkit-user-select: text;
  }
  :global([data-annotation-slot] > .solus-inline-draft-portal textarea) {
    caret-color: var(--solus-text-primary) !important;
    user-select: text !important;
    -webkit-user-select: text !important;
  }
</style>
