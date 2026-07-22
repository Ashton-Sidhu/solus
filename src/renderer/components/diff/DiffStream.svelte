<script lang="ts">
  import { mount, unmount, onMount, untrack } from "svelte";
  import {
    CodeView,
    type CodeViewDiffItem,
    type DiffLineAnnotation,
    type FileDiffMetadata,
    type SelectedLineRange,
    type SelectionSide,
  } from "@pierre/diffs";
  import type { DiffComment } from "../../../shared/types";
  import type { ReviewComment } from "../../../shared/providers";
  import {
    DIFFS_THEME_CSS,
    DIFF_FIND_HIGHLIGHT_CSS,
  } from "../../lib/diffTheme";
  import { DiffFindHighlighter } from "../../lib/diff-find-highlight";
  import type { DiffFindMatch } from "../../lib/diff-state.svelte";
  import { detectMovedBlocks } from "../../lib/diff-moves";
  import { decorateMovedLines } from "../../lib/diff-move-highlight";
  import {
    getDiffThemeName,
    onDiffWorkerPoolReady,
    setDiffWorkerPoolTheme,
    setDiffWorkerPoolLineDiffType,
  } from "../../lib/diff-worker-pool";
  import { getIcon, buildIcon, replaceIDs } from "@iconify/svelte";
  import { runtime } from "../../contexts";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import DiffCommentForm from "./DiffCommentForm.svelte";
  import DiffInlineComment from "./DiffInlineComment.svelte";
  import DiffThreadComment from "./DiffThreadComment.svelte";
  import { getInlineCommentDraft } from "./diff-comment-draft.store.svelte";
  import { DiffCollapseState, appendDiffErgonomicsLabel } from "./lib/diff-ergonomics";
  import type { DiffReviewThread } from "./lib/interdiff-annotations";

  type AnnotationMeta =
    | { kind: "comment"; comment: DiffComment }
    | { kind: "thread"; thread: DiffReviewThread }
    | { kind: "draft" };

  const DRAFT_META: AnnotationMeta = { kind: "draft" };
  const ACTION_BAR_SCROLL_GUTTER = 88;
  // File-header height. Mirrors the CSS in diffTheme.ts (DIFFS_THEME_CSS) — keep
  // the three tiers in sync so virtualization/sticky math matches the painted
  // header: desktop (>1100px), compact laptops / iPad + keyboard (≤1100px), and
  // phones / narrow windows (≤767px).
  const DIFF_HEADER_HEIGHT = 32;
  const DIFF_HEADER_HEIGHT_COMPACT = 30;
  const DIFF_HEADER_HEIGHT_PHONE = 28;
  const diffHeaderHeight = $derived(
    runtime.isMobileViewport
      ? DIFF_HEADER_HEIGHT_PHONE
      : runtime.isCompactViewport
        ? DIFF_HEADER_HEIGHT_COMPACT
        : DIFF_HEADER_HEIGHT,
  );

  function mapSide(side: SelectionSide | undefined): "old" | "new" {
    return side === "deletions" ? "old" : "new";
  }

  interface Props {
    fileDiffs: FileDiffMetadata[];
    isBinaryFile: (path: string) => boolean;
    isDark: boolean;
    diffStyle: "unified" | "split";
    tokenHighlight: boolean;
    comments: DiffComment[];
    /** GitHub PR review threads, anchored at their line. Interactive (reply /
     *  resolve) when the thread callbacks below are supplied. */
    reviewThreads: DiffReviewThread[];
    onThreadReply?: (threadId: string, body: string) => Promise<ReviewComment>;
    onThreadResolve?: (threadId: string, resolved: boolean) => Promise<void>;
    onDraftSave: (text: string) => void;
    onDraftCancel: () => void;
    onDraftValueChange: (value: string) => void;
    canOpenInEditor: boolean;
    onOpenInEditor: (path: string) => void;
    onLineRange: (
      filePath: string,
      start: number,
      end: number,
      side: "old" | "new",
    ) => void;
    onLineSelect?: (
      filePath: string,
      start: number,
      end: number,
      side: "old" | "new",
    ) => void;
    onLineClearSelect?: (filePath: string) => void;
    onEditComment: (c: DiffComment) => void;
    onDeleteComment: (id: string) => void;
  }

  let {
    fileDiffs,
    isBinaryFile,
    isDark,
    diffStyle,
    tokenHighlight,
    comments,
    reviewThreads,
    onThreadReply,
    onThreadResolve,
    onDraftSave,
    onDraftCancel,
    onDraftValueChange,
    canOpenInEditor,
    onOpenInEditor,
    onLineRange,
    onLineSelect,
    onLineClearSelect,
    onEditComment,
    onDeleteComment,
  }: Props = $props();

  // The in-progress draft, provided by the owning DiffPanel.
  const draft = getInlineCommentDraft();

  // Prefer the live draft text, falling back to the edited comment's body —
  // mirrors DiffPanel's former `pendingFormValue || editingInitialValue()`.
  const draftInitialValue = $derived(
    draft.value ||
      (draft.editingCommentId
        ? (comments.find((c) => c.id === draft.editingCommentId)?.comment ?? "")
        : ""),
  );

  let rootEl: HTMLDivElement | null = $state(null);
  let draftFormWrapper: HTMLDivElement | null = $state(null);
  let codeView: CodeView<AnnotationMeta> | null = $state(null);

  // Flips true once the lazy (~12MB) brand-icon collection has registered, so
  // file-type badges can upgrade from the monochrome extension fallback to the
  // vibrant logo. See the rebuild effect below.
  let iconsReady = $state(false);

  const collapseState = new DiffCollapseState();
  let mountedComments: ReturnType<typeof mount>[] = [];

  const moveAnalysis = $derived(detectMovedBlocks(fileDiffs));
  // Review threads collapse to a "Marked as resolved" bar once resolved. A
  // resolved thread is collapsed by default; this set tracks the ones the user
  // explicitly expanded again ("Show thread"). Bumping the nonce drives Effect B
  // to re-run syncAllAnnotations so the virtualizer re-measures the shrunk/grown
  // annotation and the diff reflows — with overflow:"wrap" the library skips its
  // annotation ResizeObserver, so a bare height change never reclaims the space.
  const expandedThreads = new Set<string>();
  let threadLayoutNonce = $state(0);

  function isThreadCollapsed(thread: ReviewThread): boolean {
    return thread.isResolved && !expandedThreads.has(thread.id);
  }

  function setThreadCollapsed(threadId: string, collapsed: boolean) {
    if (collapsed) expandedThreads.delete(threadId);
    else expandedThreads.add(threadId);
    threadLayoutNonce++;
  }

  // Find-in-diff: character-span highlighting via the CSS Custom Highlight API.
  // Ranges are (re)built only for currently rendered hosts, so the repaint is
  // wired to both onPostRender (item recycle/update) and a scroll subscription.
  const findHighlighter = new DiffFindHighlighter();
  let unsubscribeFindScroll: (() => void) | null = null;
  let findRepaintRaf = 0;

  function scheduleFindRepaint() {
    if (findRepaintRaf) return;
    findRepaintRaf = requestAnimationFrame(() => {
      findRepaintRaf = 0;
      if (!codeView) return;
      findHighlighter.repaint(codeView.getRenderedItems(), diffStyle);
    });
  }

  const commentsByPath = $derived.by(() => {
    const m = new Map<string, DiffComment[]>();
    for (const c of comments) {
      const arr = m.get(c.filePath) ?? [];
      arr.push(c);
      m.set(c.filePath, arr);
    }
    return m;
  });

  // Only line-anchored threads can render in the diff; outdated threads (line ===
  // null) have no anchor in the current diff and stay in the Activity timeline.
  const threadsByPath = $derived.by(() => {
    const m = new Map<string, DiffReviewThread[]>();
    for (const t of reviewThreads) {
      if (t.line == null) continue;
      const arr = m.get(t.filePath) ?? [];
      arr.push(t);
      m.set(t.filePath, arr);
    }
    return m;
  });

  function hasTextHunks(fileDiff: FileDiffMetadata): boolean {
    return fileDiff.hunks.length > 0;
  }

  function buildAnnotations(
    filePath: string,
  ): DiffLineAnnotation<AnnotationMeta>[] {
    const fileComments = (commentsByPath.get(filePath) ?? []).filter(
      (c) => c.id !== draft.editingCommentId,
    );
    const out = fileComments.map((c) => ({
      side: (c.side === "old" ? "deletions" : "additions") as SelectionSide,
      lineNumber: c.endLine,
      metadata: { kind: "comment", comment: c } as AnnotationMeta,
    })) as DiffLineAnnotation<AnnotationMeta>[];
    for (const thread of threadsByPath.get(filePath) ?? []) {
      out.push({
        side: (thread.side === "LEFT"
          ? "deletions"
          : "additions") as SelectionSide,
        lineNumber: thread.line as number,
        metadata: { kind: "thread", thread } as AnnotationMeta,
      } as DiffLineAnnotation<AnnotationMeta>);
    }
    if (draft.filePath === filePath && draft.range) {
      out.push({
        side: (draft.range.side === "old"
          ? "deletions"
          : "additions") as SelectionSide,
        lineNumber: draft.range.endLine,
        metadata: DRAFT_META as AnnotationMeta,
      } as DiffLineAnnotation<AnnotationMeta>);
    }
    return out;
  }

  function nextVersion(item: CodeViewDiffItem<AnnotationMeta>): number {
    return typeof item.version === "number" ? item.version + 1 : 1;
  }

  // Files with no text hunks still get a stream item because CodeView can render
  // the FileDiffMetadata returned directly from parsePatchFiles.
  type PlaceholderKind = "binary" | "empty";
  let placeholderByPath = new Map<string, PlaceholderKind>();

  // Build structural items (no annotations — those are applied separately).
  function buildStructuralItems(): CodeViewDiffItem<AnnotationMeta>[] {
    placeholderByPath = new Map();
    return fileDiffs.map((fileDiff) => {
      const moved = moveAnalysis.byFile.get(fileDiff.name);
      const collapsed = collapseState.prepare(fileDiff, moved);
      if (!hasTextHunks(fileDiff)) {
        placeholderByPath.set(
          fileDiff.name,
          isBinaryFile(fileDiff.name) ? "binary" : "empty",
        );
      }
      return {
        id: fileDiff.name,
        type: "diff" as const,
        fileDiff: collapseState.displayFile(fileDiff),
        annotations: [],
        collapsed: untrack(() => collapsed),
      };
    });
  }

  // Push the current annotation state into every item imperatively.
  function syncAllAnnotations() {
    if (!codeView) return;
    mountedComments.forEach((i) => unmount(i));
    mountedComments = [];
    for (const fileDiff of fileDiffs) {
      const item = codeView.getItem(fileDiff.name);
      if (!item || item.type !== "diff") continue;
      item.annotations = buildAnnotations(fileDiff.name);
      item.version = nextVersion(item);
      codeView.updateItem(item);
    }
  }

  function toggleCollapse(filePath: string) {
    if (!codeView) return;
    const item = codeView.getItem(filePath);
    if (!item || item.type !== "diff") return;

    const itemTop = codeView.getTopForItem(filePath);
    const wasCollapsed = item.collapsed === true;

    const file = fileDiffs.find((candidate) => candidate.name === filePath);
    if (wasCollapsed && file && collapseState.expandFormat(file)) item.fileDiff = file;
    collapseState.setCollapsed(filePath, !wasCollapsed);
    item.collapsed = !wasCollapsed;
    item.version = nextVersion(item);
    if (!codeView.updateItem(item)) return;

    // If the header has scrolled past the top, bring it back into view
    if (itemTop != null && itemTop < codeView.getScrollTop()) {
      codeView.scrollTo({ type: "item", id: filePath, align: "start" });
    }

  }
  function expandFormatHunks(filePath: string) {
    if (!codeView) return;
    const file = fileDiffs.find((candidate) => candidate.name === filePath);
    const item = codeView.getItem(filePath);
    if (!file || !item || item.type !== "diff" || !collapseState.expandFormat(file)) return;
    item.fileDiff = file;
    item.version = nextVersion(item);
    codeView.updateItem(item);
  }
  function baseName(path: string): string {
    return path.split("/").pop() ?? path;
  }
  function dirName(path: string): string {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(0, i + 1) : "";
  }
  function ext(path: string): string {
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : "·";
  }

  // File-type badge for the header: a vibrant brand logo for known languages,
  // falling back to a monochrome extension chip. Built as raw SVG (not a mounted
  // Icon component) because virtualization rebuilds headers on scroll-in and gives
  // us no destroy hook to unmount with — plain DOM is GC'd with the discarded
  // header. replaceIDs keeps each logo's gradient ids unique across the document.
  function buildTypeBadge(filePath: string): HTMLElement {
    const span = document.createElement("span");
    const iconName = fileTypeIcon(filePath);
    const data = iconName ? getIcon(iconName) : null;
    if (data) {
      const built = buildIcon(data, { width: 14, height: 14 });
      span.className = "diff-type-badge";
      span.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ` +
        `viewBox="${built.attributes.viewBox}" aria-hidden="true">` +
        `${replaceIDs(built.body)}</svg>`;
      return span;
    }
    span.className = "diff-type-badge diff-type-badge-ext";
    span.textContent = ext(filePath);
    return span;
  }

  // The header's left group, replacing the library's native title chrome (hidden
  // via diffTheme CSS): collapse chevron + file-type badge + a dir/name split path
  // (dir muted, filename emphasized) matching the PR review guide's diff cards.
  function buildHeaderPrefix(filePath: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "diff-file-header";
    wrap.appendChild(buildCollapseButton(filePath));
    wrap.appendChild(buildTypeBadge(filePath));

    const path = document.createElement("span");
    path.className = "diff-file-path";

    const prevName = fileDiffs.find((f) => f.name === filePath)?.prevName;
    if (prevName && prevName !== filePath) {
      const rename = document.createElement("span");
      rename.className = "diff-file-rename";
      rename.textContent = `${baseName(prevName)} → `;
      path.appendChild(rename);
    }

    const dir = dirName(filePath);
    if (dir) {
      const dirEl = document.createElement("span");
      dirEl.className = "diff-file-dir";
      dirEl.textContent = dir;
      path.appendChild(dirEl);
    }
    const nameEl = document.createElement("span");
    nameEl.className = "diff-file-name";
    nameEl.textContent = baseName(filePath);
    path.appendChild(nameEl);

    wrap.appendChild(path);
    return wrap;
  }

  const CHEVRON_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function buildCollapseButton(filePath: string): HTMLElement {
    const item = codeView?.getItem(filePath);
    const isCollapsed = item?.collapsed === true;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `collapse-button${isCollapsed ? "" : " is-open"}`;
    button.setAttribute("aria-expanded", String(!isCollapsed));
    button.setAttribute(
      "aria-label",
      isCollapsed ? "Expand diff" : "Collapse diff",
    );
    button.innerHTML = CHEVRON_SVG;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCollapse(filePath);
    });
    return button;
  }

  function buildOpenInEditorButton(filePath: string): HTMLElement | null {
    if (!canOpenInEditor) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "open-editor-btn header-action-btn";
    button.setAttribute("aria-label", "Open file in editor");
    button.setAttribute("title", "Open file in editor");
    button.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 256 256">` +
      `<path d="M224,104a8,8,0,0,1-16,0V59.32l-82.34,82.34a8,8,0,0,1-11.32-11.32L196.68,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z"></path>` +
      `</svg>`;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpenInEditor(filePath);
    });
    return button;
  }

  const COPY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path></svg>`;
  const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>`;

  // Copy the file's repo-relative path from the diff header.
  function buildCopyPathButton(filePath: string): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "header-action-btn copy-path-btn";
    button.setAttribute("aria-label", "Copy file path");
    button.setAttribute("title", "Copy path");
    button.innerHTML = COPY_SVG;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(filePath).then(() => {
        button.innerHTML = CHECK_SVG;
        button.setAttribute("title", "Copied!");
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          button.innerHTML = COPY_SVG;
          button.setAttribute("title", "Copy path");
        }, 1400);
      });
    });
    return button;
  }

  const PLACEHOLDER_LABELS: Record<PlaceholderKind, string> = {
    binary: "Binary file — no text diff",
    empty: "No text changes",
  };

  function buildHeaderMetadata(filePath: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "header-actions";
    const file = fileDiffs.find((candidate) => candidate.name === filePath);
    const moved = moveAnalysis.byFile.get(filePath);
    const unreviewed = collapseState.isUnreviewed(filePath);
    if (file) appendDiffErgonomicsLabel(wrap, file, moved, unreviewed,
      collapseState.hasCollapsedFormat(file) ? () => expandFormatHunks(filePath) : null);
    const kind = placeholderByPath.get(filePath);
    if (kind) {
      const label = document.createElement("span");
      label.className = "diff-placeholder-label";
      label.setAttribute("data-testid", "diff-placeholder-label");
      label.textContent = PLACEHOLDER_LABELS[kind];
      wrap.appendChild(label);
    }
    wrap.appendChild(buildCopyPathButton(filePath));
    const openBtn = buildOpenInEditorButton(filePath);
    if (openBtn) wrap.appendChild(openBtn);
    return wrap;
  }

  // Paint each file's item an opaque container background so the inter-file gap
  // (the scroll container's --solus-edge-bg showing through) reads as a subtle
  // separator. Items recycle on scroll, so this is reapplied from onPostRender.
  function paintItemBackgrounds() {
    for (const item of codeView?.getRenderedItems() ?? []) {
      item.element.style.backgroundColor = "var(--solus-container-bg)";
      if (collapseState.isUnreviewed(item.id)) item.element.dataset.solusUnreviewed = "";
      else delete item.element.dataset.solusUnreviewed;
    }
  }

  function syncStickyContainerBackground() {
    const container = rootEl?.firstElementChild;
    const stickyContainer = container?.children[1];
    if (container instanceof HTMLElement) {
      container.style.backgroundColor = "var(--solus-edge-bg)";
    }
    if (stickyContainer instanceof HTMLElement) {
      stickyContainer.style.backgroundColor = "transparent";
    }
    paintItemBackgrounds();
  }

  function buildOptions() {
    return {
      theme: getDiffThemeName(isDark),
      themeType: isDark ? ("dark" as const) : ("light" as const),
      diffStyle,
      diffIndicators: "bars" as const,
      // Token (word-level) highlighting within changed lines; "none" falls back
      // to plain line-level backgrounds when the user toggles it off.
      lineDiffType: "none" as const,
      lineHoverHighlight: "number" as const,
      overflow: "wrap" as const,
      hunkSeparators: "metadata" as const,
      disableFileHeader: false,
      disableErrorHandling: true,
      enableLineSelection: true,
      enableGutterUtility: true,
      stickyHeaders: true,
      layout: {
        paddingTop: 0,
        paddingBottom: ACTION_BAR_SCROLL_GUTTER,
        gap: 8,
      },
      itemMetrics: { diffHeaderHeight },
      unsafeCSS: `${DIFFS_THEME_CSS}\n${DIFF_FIND_HIGHLIGHT_CSS}`,
      onPostRender: () => {
        paintItemBackgrounds();
        if (codeView) decorateMovedLines(codeView.getRenderedItems(), moveAnalysis, diffStyle);
        scheduleFindRepaint();
      },
      renderHeaderPrefix: (
        _props: unknown,
        context: { item: { id: string } },
      ) => buildHeaderPrefix(context.item.id),
      renderHeaderMetadata: (
        _props: unknown,
        context: { item: { id: string } },
      ) => buildHeaderMetadata(context.item.id),
      renderAnnotation: (annotation: { metadata: AnnotationMeta }) => {
        if (annotation.metadata.kind === "draft") {
          return draftFormWrapper ?? document.createElement("div");
        }
        if (annotation.metadata.kind === "thread") {
          const target = document.createElement("div");
          const instance = mount(DiffThreadComment, {
            target,
            props: {
              thread: annotation.metadata.thread,
              collapsed: isThreadCollapsed(annotation.metadata.thread),
              onReply: onThreadReply,
              onToggleResolve: onThreadResolve,
              onSetCollapsed: setThreadCollapsed,
            },
          });
          mountedComments.push(instance);
          return target;
        }
        const target = document.createElement("div");
        const instance = mount(DiffInlineComment, {
          target,
          props: {
            comment: annotation.metadata.comment,
            variant: "minimal",
            onEdit: onEditComment,
            onDelete: onDeleteComment,
          },
        });
        mountedComments.push(instance);
        return target;
      },
      onGutterUtilityClick: (
        range: SelectedLineRange,
        context: { item: { id: string } },
      ) => {
        onLineRange(
          context.item.id,
          Math.min(range.start, range.end),
          Math.max(range.start, range.end),
          mapSide(range.side),
        );
      },
      onLineSelected: (
        range: SelectedLineRange | null,
        context: { item: { id: string } },
      ) => {
        if (range) {
          onLineSelect?.(
            context.item.id,
            Math.min(range.start, range.end),
            Math.max(range.start, range.end),
            mapSide(range.side),
          );
        } else {
          onLineClearSelect?.(context.item.id);
        }
      },
    };
  }

  onMount(() => {
    if (!rootEl) return;
    let disposed = false;

    // Register the brand-icon collection so header type badges can resolve their
    // logos offline; flips `iconsReady` once loaded (see the rebuild effect).
    void ensureIconCollections().then(() => {
      if (!disposed) iconsReady = true;
    });

    const unsubscribe = onDiffWorkerPoolReady((workerPool) => {
      if (disposed || !rootEl || codeView) return;

      void setDiffWorkerPoolTheme(isDark).then(() => {
        if (disposed || !rootEl || codeView) return;
        // Pass the shared, initialized worker pool so Shiki tokenization runs off
        // the main thread (with an LRU AST cache) instead of blocking scroll frames.
        codeView = new CodeView<AnnotationMeta>(buildOptions(), workerPool);
        codeView.setup(rootEl);
        // Virtualization recycles pooled nodes on scroll, so highlight ranges
        // must be rebuilt as matches scroll in/out of the rendered window.
        unsubscribeFindScroll = codeView.subscribeToScroll(() =>
          scheduleFindRepaint(),
        );
        syncStickyContainerBackground();
      });
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (findRepaintRaf) cancelAnimationFrame(findRepaintRaf);
      findRepaintRaf = 0;
      unsubscribeFindScroll?.();
      unsubscribeFindScroll = null;
      findHighlighter.destroy();
      mountedComments.forEach((i) => unmount(i));
      mountedComments = [];
      codeView?.cleanUp();
      codeView = null;
    };
  });

  // Push diffStyle/isDark/header-height/token-highlight changes to the live
  // CodeView. Theme and lineDiffType are driven through the shared worker pool
  // (its render options win over per-instance options and it re-renders every
  // attached instance); setOptions covers the main-thread fallback when no pool
  // is attached.
  $effect(() => {
    void diffStyle;
    void isDark;
    void diffHeaderHeight;
    void tokenHighlight;
    if (!codeView) return;
    void setDiffWorkerPoolTheme(isDark);
    void setDiffWorkerPoolLineDiffType(tokenHighlight);
    untrack(() => codeView?.setOptions(buildOptions()));
    untrack(() => syncStickyContainerBackground());
  });

  // Effect A — runs when the parsed diff file list changes.
  // Rebuilds the item list, then syncs annotations via updateItem.
  $effect(() => {
    if (!codeView) return;
    void moveAnalysis;
    codeView.setItems(buildStructuralItems());
    untrack(() => syncAllAnnotations());
    untrack(() => syncStickyContainerBackground());
  });

  // Effect B — runs when annotation state changes (comments, draft, selection).
  // Applies targeted updateItem calls instead of rebuilding the full list.
  $effect(() => {
    void comments;
    void reviewThreads;
    void draft.filePath;
    void draft.range;
    void draft.editingCommentId;
    void threadLayoutNonce;
    if (!codeView) return;
    untrack(() => syncAllAnnotations());
    untrack(() => syncStickyContainerBackground());
  });

  // When the lazy brand-icon collection finishes registering, rebuild the
  // already-rendered headers once so their type badges upgrade from the
  // extension fallback to the vibrant logo. (Headers mounted after this — via
  // setItems in Effect A — pick up the icons directly.)
  $effect(() => {
    if (!iconsReady) return;
    const cv = codeView;
    if (!cv) return;
    untrack(() => {
      for (const fileDiff of fileDiffs) {
        const item = cv.getItem(fileDiff.name);
        if (!item || item.type !== "diff") continue;
        item.version = nextVersion(item);
        cv.updateItem(item);
      }
    });
  });

  export function getFocusedFile(): string | null {
    if (!codeView) return null;
    const rendered = codeView.getRenderedItems();
    if (!rendered.length) return null;
    const scrollTop = codeView.getScrollTop();
    let focused = rendered[0];
    let bestTop = -Infinity;
    for (const item of rendered) {
      const top = codeView.getTopForItem(item.id);
      if (top !== undefined && top <= scrollTop + 40 && top > bestTop) {
        bestTop = top;
        focused = item;
      }
    }
    return focused.id;
  }

  export function scrollToFile(path: string) {
    codeView?.scrollTo({ type: "item", id: path, align: "start" });
  }

  // Collapse or expand every file in one shot (toolbar "expand/collapse all").
  export function setAllCollapsed(collapsed: boolean) {
    if (!codeView) return;
    for (const fileDiff of fileDiffs) {
      const item = codeView.getItem(fileDiff.name);
      if (!item || item.type !== "diff") continue;
      const formatExpanded = !collapsed && collapseState.expandFormat(fileDiff);
      if ((item.collapsed === true) === collapsed && !formatExpanded) continue;
      collapseState.setCollapsed(fileDiff.name, collapsed);
      if (formatExpanded) item.fileDiff = fileDiff;
      item.collapsed = collapsed;
      item.version = nextVersion(item);
      codeView.updateItem(item);
    }
  }

  export function scrollToLine(
    filePath: string,
    lineNo: number,
    side: "old" | "new",
  ) {
    codeView?.scrollTo({
      type: "line",
      id: filePath,
      lineNumber: lineNo,
      side: (side === "old" ? "deletions" : "additions") as SelectionSide,
      align: "center",
    });
  }

  // ── Find-in-diff exports
  export function setFindMatches(matches: DiffFindMatch[]) {
    findHighlighter.setMatches(matches);
    scheduleFindRepaint();
  }

  export function setFindActive(match: DiffFindMatch | null) {
    findHighlighter.setActive(match);
    scheduleFindRepaint();
  }

  export function clearFind() {
    findHighlighter.clear();
  }

  export function clearSelectedLines() {
    codeView?.setSelectedLines(null);
  }

  // Expand a collapsed file so a match in it can be scrolled to and painted.
  export function ensureExpanded(path: string) {
    if (!codeView) return;
    const item = codeView.getItem(path);
    if (!item || item.type !== "diff") return;
    const file = fileDiffs.find((candidate) => candidate.name === path);
    const formatExpanded = !!file && collapseState.expandFormat(file);
    if (item.collapsed !== true && !formatExpanded) return;
    collapseState.setCollapsed(path, false);
    if (formatExpanded && file) item.fileDiff = file;
    item.collapsed = false;
    item.version = nextVersion(item);
    codeView.updateItem(item);
  }
</script>

<div
  bind:this={rootEl}
  class="diff-stream-root flex-1 min-h-0 min-w-0 relative"
  style="scrollbar-width:thin"
></div>

<!--
  Draft form portal — Svelte owns this element's lifecycle, but @pierre/diffs
  adopts (relocates) it between diff lines when a draft annotation is active.
  While idle, display:none keeps it invisible wherever it sits in the DOM.
-->
<div bind:this={draftFormWrapper} class="solus-inline-draft-portal">
  {#if draft.filePath && draft.range}
    <DiffCommentForm
      onSave={onDraftSave}
      onCancel={onDraftCancel}
      rangeLabel={draft.rangeLabel}
      initialValue={draftInitialValue}
      onFormValueChange={onDraftValueChange}
    />
  {/if}
</div>

<style>
  .diff-stream-root {
    overflow-y: auto;
    overscroll-behavior-y: contain;
    /* The diff component reads these vars for its code font; set them here in the
       light DOM (not the injected shadow CSS) so they inherit across the shadow
       boundary and stay live as the "Code font size" setting / screen scale change.
       Driven off our rem-based code-font token so the diff scales with both. */
    --diffs-font-family: var(--solus-code-font-family);
    --diffs-font-size: var(--solus-code-font-size, 0.75rem);
    --diffs-line-height: calc(var(--solus-code-font-size, 0.75rem) * 1.6);
    font-size: var(--solus-code-font-size, 0.75rem);
    line-height: 1.6;
  }

  :global(.collapse-button) {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--solus-text-tertiary);
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.3125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
      color 160ms ease,
      background-color 160ms ease;
    transform: rotate(0deg);
    cursor: pointer;
  }

  :global(.collapse-button.is-open) {
    transform: rotate(90deg);
  }

  :global(.collapse-button:hover) {
    color: var(--solus-file-header-name);
    background: var(--solus-surface-hover);
  }

  :global(.collapse-button:active) {
    transform: rotate(0deg) scale(0.96);
  }

  :global(.collapse-button.is-open:active) {
    transform: rotate(90deg) scale(0.96);
  }

  /* Custom header prefix (light-DOM slotted content) — collapse chevron +
     file-type badge + dir/name split path, matching the PR review guide. */
  :global(.diff-file-header) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    overflow: hidden;
  }

  :global(.diff-type-badge) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  :global(.diff-type-badge svg) {
    display: block;
    width: 14px;
    height: 14px;
  }

  :global(.diff-type-badge-ext) {
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    background: var(--solus-accent-light);
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1.4;
  }

  :global(.diff-file-path) {
    display: flex;
    align-items: baseline;
    min-width: 0;
    font-family: var(--solus-code-font-family);
    font-size: 0.8125rem;
    letter-spacing: -0.005em;
  }

  :global(.diff-file-dir) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--solus-text-tertiary);
  }

  :global(.diff-file-name) {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--solus-text-primary);
  }

  :global(.diff-file-rename) {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--solus-text-tertiary);
    opacity: 0.7;
  }

  :global(.header-actions) {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
  }

  :global(.diff-placeholder-label) {
    font-size: 0.625rem;
    font-style: italic;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
    margin-right: 0.375rem;
    flex-shrink: 0;
  }

  :global(.diff-ergonomics-label) {
    border: 0; background: transparent; padding: 0; margin-right: 0.375rem;
    color: var(--solus-text-tertiary);
    font-size: 0.625rem; font-style: italic; white-space: nowrap;
  }

  :global(button.diff-ergonomics-label) { cursor: pointer; }
  :global(.diff-ergonomics-label.is-unreviewed) {
    color: var(--solus-accent); font-style: normal; font-weight: 600;
  }

  :global([data-solus-unreviewed]) {
    box-shadow: inset 0.125rem 0 0 color-mix(in srgb, var(--solus-accent) 70%, transparent);
  }

  :global(.header-action-btn) {
    border: 0;
    background: transparent;
    padding: 0;
    opacity: 0.7;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.3125rem;
    color: var(--solus-text-tertiary);
    transition:
      opacity 160ms ease,
      background-color 160ms ease,
      color 160ms ease;
    cursor: pointer;
  }

  :global(.header-action-btn:hover) {
    opacity: 1 !important;
    color: var(--solus-accent);
    background: var(--solus-surface-hover);
  }

  :global(.header-action-btn:focus-visible) {
    opacity: 1 !important;
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  :global(.solus-inline-draft-portal) {
    display: none;
  }

  :global([data-annotation-slot] > .solus-inline-draft-portal) {
    display: block;
    padding: 0.5rem 0.75rem 0.625rem;
  }
</style>
