<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { uuid } from "../../../shared/uuid";
  import { FileTree, prepareFileTreeInput } from "@pierre/trees";
  import type { FileDiffMetadata } from "@pierre/diffs";
  import DiffActionBar from "./DiffActionBar.svelte";
  import DiffToolbar, { type HeaderStats } from "./DiffToolbar.svelte";
  import DiffEmptyState from "./DiffEmptyState.svelte";
  import DiffErrorState from "./DiffErrorState.svelte";
  import DiffFileTreeColumn from "./DiffFileTreeColumn.svelte";
  import DiffLoadingSkeleton from "./DiffLoadingSkeleton.svelte";
  import DiffMobileFileSheet from "./DiffMobileFileSheet.svelte";
  import DiffCommentsPopover from "./DiffCommentsPopover.svelte";
  import DiffStream from "./DiffStream.svelte";
  import DiffFindBar from "./DiffFindBar.svelte";
  import { FILE_TREE_CHEVRON_CSS } from "../../lib/fileTreeTheme";
  import { DiffState, type DiffFindMatch } from "../../lib/diff-state.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    toGitStatusEntries,
    createRowDecorationRenderer,
    toTreeDisplayPath,
    diffFilePath,
    diffHeaderStats,
  } from "../../lib/diffTreeAdapter";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    InlineCommentDraft,
    setInlineCommentDraft,
  } from "../../contexts/diff-comment-draft.store.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { openInConfiguredEditor } from "../../lib/openExternalEditor";
  import { runtime } from "../../contexts/runtime.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import type { DiffComment, DiffScope } from "../../../shared/types";
  import type { ReviewThread, ReviewComment } from "../../../shared/providers";

  type ExternalDiffCommentSave = {
    id?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    side: "old" | "new";
    selectedCode: string;
    comment: string;
    createdAt?: number;
  };

  let {
    tabId,
    projectPath,
    worktreePath,
    worktreeBranch,
    targetBranch,
    isWorktree = false,
    onClose,
    maximized = false,
    onToggleMaximize,
    initialScope = { kind: "session" },
    externalComments = null,
    onExternalCommentSave,
    onExternalCommentDelete,
    reviewThreads = [],
    onThreadReply,
    onThreadResolve,
  }: {
    tabId: string;
    projectPath: string;
    worktreePath?: string;
    worktreeBranch: string;
    targetBranch: string;
    isWorktree?: boolean;
    onClose: () => void;
    maximized?: boolean;
    onToggleMaximize?: () => void;
    initialScope?: DiffScope;
    /** Optional externally-owned comment list for surfaces that persist comments
     *  outside the active tab while still reusing the diff UI. */
    externalComments?: DiffComment[] | null;
    onExternalCommentSave?: (comment: ExternalDiffCommentSave) => void;
    onExternalCommentDelete?: (id: string) => void;
    /** GitHub PR review threads to surface inline in the diff. Interactive when
     *  the reply / resolve callbacks below are supplied. */
    reviewThreads?: ReviewThread[];
    onThreadReply?: (threadId: string, body: string) => Promise<ReviewComment>;
    onThreadResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  const hasExternalCommentStore = $derived(externalComments !== null);

  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));

  // The in-progress inline-comment draft. Owned here and shared down to
  // DiffStream (this panel's only consumer) via context, so the selection /
  // editing / unsaved-text state isn't threaded through as props.
  const draft = new InlineCommentDraft();
  setInlineCommentDraft(draft);

  const diffState = new DiffState({
    session,
    getTabId: () => tabId,
  });
  const diff = $derived(diffState.diff);
  const loadError = $derived(diffState.loadError);

  // The skeleton is delayed, not floored: a load that resolves within
  // SKELETON_DELAY_MS never shows the skeleton at all, so cached/fast opens feel
  // instant instead of paying a fixed minimum. Once the skeleton does appear it
  // stays for SKELETON_MIN_MS so a load finishing just after the delay can't
  // flash it. The pre-skeleton window is covered by a blank branch in the
  // template (guarded on diffState.loading) so the empty state never flashes.
  const SKELETON_DELAY_MS = 120;
  const SKELETON_MIN_MS = 140;
  let showLoading = $state(false);
  let skeletonShownAt = 0;
  $effect(() => {
    if (diffState.loading) {
      const timer = setTimeout(() => {
        skeletonShownAt = performance.now();
        showLoading = true;
      }, SKELETON_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!showLoading) return;
    const remaining = SKELETON_MIN_MS - (performance.now() - skeletonShownAt);
    if (remaining <= 0) {
      showLoading = false;
    } else {
      const timer = setTimeout(() => {
        showLoading = false;
      }, remaining);
      return () => clearTimeout(timer);
    }
  });

  const turns = $derived(session.turnSnapshots[tabId] ?? []);
  let selectedScope = $state<DiffScope>({ kind: "session" });
  const selectedTurnIndex = $derived(
    selectedScope.kind === "turn" ? selectedScope.index : null,
  );
  const isWorkingTreeScope = $derived(selectedScope.kind === "working-tree");
  const initialScopeKey = $derived(
    initialScope.kind === "turn" ? `turn:${initialScope.index}` : initialScope.kind,
  );

  let panelWidth = $state(0);
  let commentsPopoverOpen = $state(false);
  let commentsAnchorEl: HTMLButtonElement | null = $state(null);
  let treeCollapsed = $state(false);
  let mobileTreeOpen = $state(false);
  let treeInstance: FileTree | null = $state(null);
  let streamRef: DiffStream | null = $state(null);
  let findBarRef: DiffFindBar | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state("");
  let findIndex = $state(0);
  let diffStyleState = $state<"unified" | "split">(
    (localStorage.getItem("solus-diff-style") as "unified" | "split") ||
      "unified",
  );
  // Token (word-level) highlighting inside changed lines. Defaults on; only an
  // explicit "off" stored value disables it.
  let tokenHighlightState = $state<boolean>(
    localStorage.getItem("solus-diff-token-highlight") !== "off",
  );
  const treeMaxWidth = $derived(Math.floor(panelWidth * 0.4));

  const TREE_AUTO_OPEN_WIDTH = 640;
  let prevAboveTreeThreshold: boolean | null = null;
  $effect(() => {
    if (runtime.isMobileViewport) {
      treeCollapsed = true;
      return;
    }
    const w = panelWidth;
    if (w === 0) return;
    const isAbove = w >= TREE_AUTO_OPEN_WIDTH;
    if (prevAboveTreeThreshold === isAbove) return;
    prevAboveTreeThreshold = isAbove;
    untrack(() => {
      treeCollapsed = !isAbove;
    });
  });

  function restoreDraftIfAny() {
    const saved = tab?.diffCommentDraft;
    if (!saved) return;
    draft.range = {
      startLine: saved.startLine,
      endLine: saved.endLine,
      side: saved.side,
    };
    draft.filePath = saved.filePath;
    draft.editingCommentId = saved.editingCommentId;
    draft.value = saved.value;
  }

  async function startLoad() {
    await diffState.refresh(selectedScope);
  }

  let mounted = false;
  let prevInitialScopeKey = untrack(() => initialScopeKey);
  $effect(() => {
    const key = initialScopeKey;
    if (!mounted) return;
    if (key === prevInitialScopeKey) return;
    prevInitialScopeKey = key;
    selectedScope = initialScope;
    draft.clear();
    void startLoad();
  });

  onMount(() => {
    mounted = true;
    selectedScope = initialScope;
    void session.refreshTurnSnapshots(tabId);
    void startLoad();
    restoreDraftIfAny();
    return () => diffState.dispose();
  });

  // Refresh when the snapshot list grows (a new turn was just snapshotted).
  let prevTurnCount = untrack(() => turns.length);
  $effect(() => {
    const count = turns.length;
    if (count !== prevTurnCount) {
      prevTurnCount = count;
      void startLoad();
    }
  });

  // Live mid-turn refresh: changedFiles is recomputed each time a Write/Edit
  // tool completes, so the panel can follow the agent instead of going stale
  // until the turn snapshot lands. Debounced and silent (no skeleton flash).
  const LIVE_REFRESH_DEBOUNCE_MS = 600;
  const changedFilesSignal = $derived((sess?.changedFiles ?? []).join("\n"));
  let prevChangedFilesSignal = untrack(() => changedFilesSignal);
  $effect(() => {
    const signal = changedFilesSignal;
    if (signal === prevChangedFilesSignal) return;
    prevChangedFilesSignal = signal;
    if (selectedScope.kind !== "session" && selectedScope.kind !== "working-tree") return;
    const timer = setTimeout(() => {
      void diffState.refresh(selectedScope, { silent: true });
    }, LIVE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  let manualRefreshing = $state(false);
  async function handleManualRefresh() {
    if (manualRefreshing) return;
    manualRefreshing = true;
    const startedAt = performance.now();
    await diffState.refresh(selectedScope, { silent: true });
    // Let the spinner complete at least one revolution so fast refreshes
    // still read as "something happened".
    const remaining = 400 - (performance.now() - startedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    manualRefreshing = false;
  }

  // Shared reset for tab switches and same-tab session resumes: clear all
  // selection/draft state and reload the diff for the new transcript.
  function resetForNewTranscript() {
    selectedScope = initialScope;
    draft.clear();
    diffState.dispose();
    void session.refreshTurnSnapshots(tabId);
    void startLoad();
  }

  let prevTabId = untrack(() => tabId);
  $effect(() => {
    if (tabId === prevTabId) return;
    prevTabId = tabId;
    commentsPopoverOpen = false;
    resetForNewTranscript();
    restoreDraftIfAny();
  });

  // Same-tab session resume: agentSessionId flips from the previous session to
  // the loaded one. The panel was already mounted (so onMount won't fire), and
  // local selection/draft state needs to be reset for the resumed transcript.
  let prevAgentSessionId = untrack(() => sess?.agentSessionId ?? null);
  $effect(() => {
    const current = sess?.agentSessionId ?? null;
    if (current === prevAgentSessionId) return;
    prevAgentSessionId = current;
    resetForNewTranscript();
  });

  const treeFiles = $derived(diff ? diffState.fileDiffs : []);

  const diffComments = $derived(
    externalComments ?? (tab?.diffComments?.slice() ?? []),
  );
  // Split view needs room for two columns; below the tree-open threshold the
  // panel can't fit them without squashing, so fall back to unified while
  // narrow. The user's stored preference is untouched and resumes when widened.
  const SPLIT_MIN_WIDTH = 640;
  const effectiveDiffStyle = $derived<"unified" | "split">(
    diffStyleState === "split" && panelWidth > 0 && panelWidth < SPLIT_MIN_WIDTH
      ? "unified"
      : diffStyleState,
  );

  const branchContext = $derived(
    isWorktree ? `${worktreeBranch} → ${targetBranch}` : undefined,
  );

  const headerStats = $derived.by((): HeaderStats | null => {
    if (!diff) return null;
    return diffHeaderStats(treeFiles);
  });

  async function handleTurnSelect(index: number | null) {
    selectedScope =
      index === null ? { kind: "session" } : { kind: "turn", index };
    draft.clear();
    await startLoad();
    await tick();
    const first = orderedFiles[0] ? diffFilePath(orderedFiles[0]) : undefined;
    if (first) {
      await tick();
      streamRef?.scrollToFile(first);
    }
  }

  function setDiffStyle(style: "unified" | "split") {
    diffStyleState = style;
    localStorage.setItem("solus-diff-style", style);
  }

  function toggleTokenHighlight() {
    tokenHighlightState = !tokenHighlightState;
    localStorage.setItem(
      "solus-diff-token-highlight",
      tokenHighlightState ? "on" : "off",
    );
  }

  let allCollapsed = $state(false);
  function toggleCollapseAll() {
    allCollapsed = !allCollapsed;
    streamRef?.setAllCollapsed(allCollapsed);
  }
  function openFileInEditor(path: string) {
    const fileRoot = worktreePath ?? projectPath;
    openInConfiguredEditor(session.ctxFor(tabId), {
      filePaths: [path],
      editorId: theme.defaultEditor,
      terminalId: theme.defaultTerminal,
      cwd: fileRoot,
    });
  }

  // Single entry point for both selection gestures — the gutter "+" button
  // (onLineRange) and dragging the line-number column (onLineSelect). Both open
  // the comment form so the behaviour is consistent regardless of where the drag
  // starts. Re-selecting within the same draft keeps any text already typed so
  // adjusting the range doesn't wipe the in-progress comment.
  function handleStreamLineRange(
    filePath: string,
    start: number,
    end: number,
    side: "old" | "new",
  ) {
    const sameDraft = draft.filePath === filePath && draft.editingCommentId === null;
    draft.range = { startLine: start, endLine: end, side };
    draft.filePath = filePath;
    if (!sameDraft) {
      draft.editingCommentId = null;
      draft.value = "";
    }
    persistDraft();
  }

  function handleLineClearSelect(_filePath: string) {
    if (!draft.filePath) {
      draft.range = null;
    }
  }

  function persistDraft() {
    if (!draft.filePath || !draft.range) {
      session.setDiffCommentDraft(null);
      return;
    }
    session.setDiffCommentDraft({
      filePath: draft.filePath,
      startLine: draft.range.startLine,
      endLine: draft.range.endLine,
      side: draft.range.side,
      editingCommentId: draft.editingCommentId,
      value: draft.value,
    });
  }

  function resetCommentForm() {
    draft.clear();
    session.setDiffCommentDraft(null);
    streamRef?.clearSelectedLines();
  }

  function handleSaveComment(comment: string) {
    if (hasExternalCommentStore && onExternalCommentSave) {
      if (draft.editingCommentId) {
        const existing = diffComments.find((c) => c.id === draft.editingCommentId);
        if (existing) onExternalCommentSave({ ...existing, comment });
        resetCommentForm();
        return;
      }
      if (!draft.range || !draft.filePath) return;
      const range = draft.range;
      const file = draft.filePath;
      onExternalCommentSave({
        filePath: file,
        startLine: range.startLine,
        endLine: range.endLine,
        side: range.side,
        selectedCode: diffState.selectedTextForRange(file, range),
        comment,
      });
      resetCommentForm();
      return;
    }
    if (draft.editingCommentId) {
      session.updateDiffComment(draft.editingCommentId, comment);
      draft.clear();
      session.setDiffCommentDraft(null);
      return;
    }
    if (!draft.range || !draft.filePath) return;

    const range = draft.range;
    const file = draft.filePath;

    const newComment: DiffComment = {
      id: uuid(),
      filePath: file,
      startLine: range.startLine,
      endLine: range.endLine,
      side: range.side,
      selectedCode: diffState.selectedTextForRange(file, range),
      comment,
      createdAt: Date.now(),
    };

    draft.clear();
    session.setDiffCommentDraft(null);
    session.addDiffComment(newComment);
  }

  function handleCancelComment() {
    draft.clear();
    session.setDiffCommentDraft(null);
  }

  function handleEditComment(c: DiffComment) {
    draft.range = {
      startLine: c.startLine,
      endLine: c.endLine,
      side: c.side,
    };
    draft.editingCommentId = c.id;
    draft.filePath = c.filePath;
    draft.value = c.comment;
    persistDraft();
  }

  // Deleting an inline comment is one mis-click away from losing review
  // feedback, so it's soft: remove immediately, then offer a brief undo toast
  // that restores the comment at its original position.
  function handleDeleteComment(id: string) {
    if (hasExternalCommentStore) {
      onExternalCommentDelete?.(id);
      return;
    }
    const list = tab?.diffComments;
    if (!list) return;
    const index = list.findIndex((c) => c.id === id);
    if (index === -1) return;
    const comment = list[index];
    session.removeDiffComment(id);
    toasts.undo("Comment deleted", () => session.restoreDiffComment(comment, index));
  }

  function navigateToComment(c: DiffComment) {
    draft.range = {
      startLine: c.startLine,
      endLine: c.endLine,
      side: c.side,
    };
    streamRef?.scrollToLine(c.filePath, c.endLine, c.side);
  }

  // Only line-anchored threads can be scrolled to; outdated ones (line === null)
  // have no anchor in the current diff and live in the Activity timeline.
  const navigableThreads = $derived(reviewThreads.filter((t) => t.line != null));

  function navigateToThread(t: ReviewThread) {
    if (t.line == null) return;
    const side = t.side === "LEFT" ? "old" : "new";
    draft.range = { startLine: t.line, endLine: t.line, side };
    streamRef?.scrollToLine(t.filePath, t.line, side);
  }

  // ── Find in diff ───────────────────────────────────────────────────────────
  // Matches are computed over diffState.fileDiffs order — exactly what DiffStream
  // paints — so next/prev cycle in visual top-to-bottom order. Recomputes
  // automatically on live mid-turn refresh (derived over reactive fileDiffs).
  const findMatches = $derived.by<DiffFindMatch[]>(() => {
    if (findQuery.trim().length === 0) return [];
    return diffState.findMatches(
      findQuery,
      diffState.fileDiffs.map((f) => f.name),
    );
  });
  const activeMatch = $derived<DiffFindMatch | null>(
    findMatches[findIndex] ?? null,
  );

  // Keep the active index inside the (possibly shrunk) match list.
  $effect(() => {
    const len = findMatches.length;
    if (findIndex >= len) findIndex = len === 0 ? 0 : len - 1;
    else if (findIndex < 0) findIndex = 0;
  });
  // Push match set + active match into the stream's highlighter.
  $effect(() => {
    streamRef?.setFindMatches(findMatches);
  });
  $effect(() => {
    streamRef?.setFindActive(activeMatch);
  });

  function openFind() {
    if (treeFiles.length === 0) return;
    findOpen = true;
    void tick().then(() => findBarRef?.focusInput());
  }

  function closeFind() {
    findOpen = false;
    findQuery = "";
    findIndex = 0;
    streamRef?.clearFind();
    requestInputFocus();
  }

  // Expand (if collapsed), scroll into view, and emphasize a match.
  async function revealMatch(match: DiffFindMatch) {
    streamRef?.ensureExpanded(match.path);
    await tick();
    streamRef?.scrollToLine(match.path, match.lineNo, match.side);
    streamRef?.setFindActive(match);
  }

  // Editing the query jumps to the first match (like browser/editor find), so
  // results are visible without an extra keypress. tick() lets the derived
  // recompute against the new query before we read it.
  async function revealFirstMatch() {
    await tick();
    const match = findMatches[0];
    if (match) await revealMatch(match);
  }

  async function findNav(dir: 1 | -1) {
    const total = findMatches.length;
    if (total === 0) return;
    findIndex = (((findIndex + dir) % total) + total) % total;
    await revealMatch(findMatches[findIndex]);
    findBarRef?.focusInput();
  }

  useScope("diff-panel");

  useKeybinding("diff-panel.close", () => {
    if (findOpen) {
      closeFind();
      return;
    }
    if (commentsPopoverOpen) {
      commentsPopoverOpen = false;
      return;
    }
    if (draft.filePath) handleCancelComment();
    else if (draft.range) draft.range = null;
    else onClose();
  });
  useKeybinding("diff-panel.next-file", () => cycleFile(1));
  useKeybinding("diff-panel.prev-file", () => cycleFile(-1));
  useKeybinding("diff-panel.start-comment", () => startCommentOnCurrentLine());
  useKeybinding("diff-panel.next-comment", () => cycleComment(1));
  useKeybinding("diff-panel.prev-comment", () => cycleComment(-1));
  useKeybinding("diff-panel.next-turn", () => cycleTurn(1));
  useKeybinding("diff-panel.prev-turn", () => cycleTurn(-1));
  useKeybinding("diff-panel.toggle-view", () =>
    setDiffStyle(diffStyleState === "unified" ? "split" : "unified"),
  );
  useKeybinding("diff-panel.toggle-token-hl", () => toggleTokenHighlight());
  useKeybinding("diff-panel.toggle-tree", () => toggleTreeCollapsed());
  useKeybinding("diff-panel.refresh", () => void handleManualRefresh());
  useKeybinding(
    "diff-panel.maximize",
    () => {
      if (onToggleMaximize) onToggleMaximize();
    },
    { enabled: () => !!onToggleMaximize },
  );
  useKeybinding("diff-panel.submit", () => submitFromShortcut());
  useKeybinding("diff-panel.find", () => openFind());

  async function submitFromShortcut() {
    handleBeforeSend();
    if (hasExternalCommentStore) return;
    const general = tab?.diffGeneralComment?.trim() ?? "";
    // Working-tree changes aren't bound to the current agent turn, so feedback
    // always spawns a fresh session — matching the action bar's only send target.
    const sent = isWorkingTreeScope
      ? await session.submitDiffFeedbackToNewSession({
          generalComment: general,
          filePath: draft.filePath,
          diffText: diffState.patch,
          branchContext,
        })
      : session.submitDiffFeedback(general);
    if (sent) onClose();
  }

  function cycleFile(dir: 1 | -1) {
    const paths = orderedFiles.map((f) => diffFilePath(f));
    if (paths.length === 0) return;
    const current = streamRef?.getFocusedFile();
    const idx = current ? paths.indexOf(current) : -1;
    const next = ((idx === -1 ? 0 : idx + dir) + paths.length) % paths.length;
    draft.clear();
    streamRef?.scrollToFile(paths[next]);
    syncTreeTo(paths[next]);
  }

  function cycleTurn(dir: 1 | -1) {
    if (isWorkingTreeScope) return;
    if (turns.length === 0) return;
    if (selectedTurnIndex === null) {
      void handleTurnSelect(
        dir === 1 ? turns[0].index : turns[turns.length - 1].index,
      );
      return;
    }
    const idx = turns.findIndex((t) => t.index === selectedTurnIndex);
    const next = idx + dir;
    if (next < 0 || next >= turns.length) void handleTurnSelect(null);
    else void handleTurnSelect(turns[next].index);
  }

  function cycleComment(dir: 1 | -1) {
    if (diffComments.length === 0) return;
    const current = streamRef?.getFocusedFile();
    const idx = diffComments.findIndex(
      (c) =>
        c.filePath === current &&
        draft.range?.startLine === c.startLine &&
        draft.range?.endLine === c.endLine &&
        draft.range?.side === c.side,
    );
    const next =
      ((idx === -1 ? 0 : idx + dir) + diffComments.length) %
      diffComments.length;
    navigateToComment(diffComments[next]);
  }

  function startCommentOnCurrentLine() {
    const file = streamRef?.getFocusedFile();
    if (!file) return;
    if (draft.range) {
      draft.filePath = file;
      draft.editingCommentId = null;
      draft.value = "";
      persistDraft();
    }
  }

  function handleBeforeSend() {
    if (draft.filePath && draft.value.trim().length > 0) {
      handleSaveComment(draft.value.trim());
    }
  }

  const pendingFormHasContent = $derived(
    draft.filePath !== null && draft.value.trim().length > 0,
  );

  const diffLoadedAnnouncement = $derived.by(() => {
    if (showLoading || loadError) return "";
    if (!headerStats) return "";
    const f = headerStats.files;
    return `${f} file${f === 1 ? "" : "s"} changed, ${headerStats.additions} additions, ${headerStats.deletions} deletions.`;
  });

  const treePaths = $derived(treeFiles.map((f) => diffFilePath(f)));
  const displayedTreePaths = $derived(
    treePaths.map((p) => toTreeDisplayPath(p)),
  );
  const fullPathByDisplay = $derived.by(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < treePaths.length; i++) {
      map.set(displayedTreePaths[i], treePaths[i]);
    }
    return map;
  });
  const treeGitStatus = $derived(toGitStatusEntries(treeFiles));

  // Render the diffs in the same top-to-bottom order the tree lays them out,
  // rather than git's raw order. prepareFileTreeInput is a pure sort that
  // matches mountFileTree's config, so the stream and tree always agree.
  const orderedFiles = $derived.by(() => {
    const { paths } = prepareFileTreeInput(displayedTreePaths, {
      flattenEmptyDirectories: true,
    });
    const byDisplay = new Map<string, FileDiffMetadata>();
    for (let i = 0; i < treeFiles.length; i++) {
      byDisplay.set(displayedTreePaths[i], treeFiles[i]);
    }
    return paths
      .map((p) => byDisplay.get(p))
      .filter((f): f is FileDiffMetadata => f !== undefined);
  });

  function toFullPath(p: string): string {
    return fullPathByDisplay.get(p) ?? p;
  }

  function toggleTreeCollapsed() {
    treeCollapsed = !treeCollapsed;
  }

  function syncTreeTo(path: string) {
    if (!treeInstance) return;
    const displayPath = toTreeDisplayPath(path);
    const current = treeInstance.getSelectedPaths();
    if (current.length === 1 && current[0] === displayPath) return;
    for (const p of current) treeInstance.getItem(p)?.deselect();
    treeInstance.getItem(displayPath)?.select();
  }

  function handleTreeSelect(path: string) {
    const fullPath = toFullPath(path);
    draft.clear();
    streamRef?.scrollToFile(fullPath);
  }

  // Mobile file navigation: the desktop tree is hidden on phones, so a
  // bottom-sheet list is the only way to jump between changed files.
  function handleMobileFileSelect(path: string) {
    draft.clear();
    mobileTreeOpen = false;
    streamRef?.scrollToFile(path);
  }

  function mountFileTree(node: HTMLDivElement) {
    const paths = displayedTreePaths;
    const tree = new FileTree({
      paths,
      flattenEmptyDirectories: true,
      initialExpansion: "open",
      gitStatus: treeGitStatus,
      search: true,
      searchBlurBehavior: "close",
      renderRowDecoration: createRowDecorationRenderer(treeFiles, diffComments),
      onSelectionChange: (selectedPaths) => {
        const next = selectedPaths[0] ?? null;
        if (!next) return;
        handleTreeSelect(next);
      },
      unsafeCSS: `
        [data-type='item'][data-item-selected='true']::after {
          content: '';
          position: absolute;
          top: 0.1875rem; bottom: 0.1875rem; left: 0;
          width: 0.1563rem;
          border-radius: 0 0.1875rem 0.1875rem 0;
          background: var(--solus-accent);
        }
        [data-type='item'][data-item-selected='true']::before {
          outline-color: transparent !important;
        }
        [data-item-section='icon'] {
          cursor: pointer;
        }
        ${FILE_TREE_CHEVRON_CSS}
        [data-item-section='decoration'] {
          font-variant-numeric: tabular-nums;
          font-size: 0.5938rem;
          letter-spacing: 0.01em;
          opacity: 0.75;
        }
        [data-item-selected='true'] [data-item-section='decoration'],
        [data-item-focused='true'] [data-item-section='decoration'] {
          opacity: 1;
        }
        [data-file-tree-search-container] {
          padding-top: 0.375rem;
          padding-left: calc(var(--trees-padding-inline) + 2.125rem);
          margin-bottom: 0.625rem;
        }
        [data-file-tree-search-input] {
          min-width: 0;
        }
      `,
    });
    tree.render({ containerWrapper: node });
    treeInstance = tree;

    // Intercept chevron/icon clicks on directories: toggle expand/collapse only,
    // without triggering selection or file navigation.
    function handleIconClick(event: MouseEvent) {
      const composedPath = event.composedPath() as EventTarget[];
      const iconSection = composedPath.find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && el.dataset.itemSection === "icon",
      );
      if (!iconSection) return;
      const row = composedPath.find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.dataset.type === "item" &&
          el.dataset.itemType === "folder",
      );
      if (!row) return;
      const itemPath = row.dataset.itemPath;
      if (!itemPath) return;
      event.stopPropagation();
      const item = tree.getItem(itemPath);
      if (item?.isDirectory()) item.toggle();
    }
    node.addEventListener("click", handleIconClick, true);

    return {
      destroy() {
        node.removeEventListener("click", handleIconClick, true);
        tree.cleanUp();
        treeInstance = null;
      },
    };
  }

  $effect(() => {
    if (!treeInstance) return;
    treeInstance.resetPaths(displayedTreePaths);
  });

  $effect(() => {
    if (!treeInstance) return;
    treeInstance.setGitStatus(treeGitStatus);
  });

</script>

<div
  class="relative flex flex-col h-full diff-panel-border"
  style="background:var(--solus-container-bg)"
  bind:clientWidth={panelWidth}
  role="region"
  aria-label="Diff panel"
  data-testid="diff-panel"
>
  <div class="sr-only" aria-live="polite" aria-atomic="true">
    {diffLoadedAnnouncement}
  </div>
  <DiffToolbar
    {isWorktree}
    {worktreeBranch}
    {targetBranch}
    fallbackBranch={sess?.gitContext?.branch ?? null}
    {headerStats}
    diffStyle={effectiveDiffStyle}
    onSetStyle={setDiffStyle}
    tokenHighlight={tokenHighlightState}
    onToggleTokenHighlight={toggleTokenHighlight}
    {allCollapsed}
    onToggleCollapseAll={toggleCollapseAll}
    filesCount={treeFiles.length}
    {treeCollapsed}
    onToggleTree={toggleTreeCollapsed}
    onRefresh={() => void handleManualRefresh()}
    refreshing={manualRefreshing}
    onOpenFiles={() => (mobileTreeOpen = true)}
    commentsCount={diffComments.length + navigableThreads.length}
    commentsOpen={commentsPopoverOpen}
    onToggleComments={() => (commentsPopoverOpen = !commentsPopoverOpen)}
    {maximized}
    onToggleMaximize={onToggleMaximize ?? null}
    {onClose}
    commentsAnchorRef={(el) => (commentsAnchorEl = el)}
    {turns}
    {selectedTurnIndex}
    onTurnSelect={handleTurnSelect}
    onStepTurn={cycleTurn}
    turnRunning={sess?.status === "running" || sess?.status === "connecting"}
    mode={isWorkingTreeScope ? "working-tree" : "session"}
  />

  {#if showLoading}
    <DiffLoadingSkeleton />
  {:else if diffState.loading}
    <!-- Pre-skeleton window: a fast load resolves here and swaps straight to
         content without ever flashing the skeleton or the empty state. -->
    <div class="flex-1 min-h-0"></div>
  {:else if loadError}
    <DiffErrorState
      title="Couldn't load the diff"
      message={loadError}
      onRetry={startLoad}
    />
  {:else if treeFiles.length === 0}
    <DiffEmptyState
      {selectedTurnIndex}
      {isWorkingTreeScope}
      {isWorktree}
      {targetBranch}
      {onClose}
    />
  {:else}
    <div class="flex flex-1 min-h-0 min-w-0">
      {#if !treeCollapsed && !runtime.isMobileViewport}
        <DiffFileTreeColumn
          {treeMaxWidth}
          {mountFileTree}
          onToggleTree={toggleTreeCollapsed}
        />
      {/if}
      <div class="relative flex flex-1 min-h-0 min-w-0">
        {#if findOpen}
          <DiffFindBar
            bind:this={findBarRef}
            query={findQuery}
            current={findMatches.length === 0 ? 0 : findIndex + 1}
            total={findMatches.length}
            onQueryChange={(v) => {
              findQuery = v;
              findIndex = 0;
              void revealFirstMatch();
            }}
            onNext={() => findNav(1)}
            onPrev={() => findNav(-1)}
            onClose={closeFind}
          />
        {/if}
        <DiffStream
          bind:this={streamRef}
          fileDiffs={diffState.fileDiffs}
          isBinaryFile={(path) => diffState.isBinaryFile(path)}
          isDark={theme.isDark}
          diffStyle={effectiveDiffStyle}
          tokenHighlight={tokenHighlightState}
          comments={diffComments}
          {reviewThreads}
          {onThreadReply}
          {onThreadResolve}
          onDraftSave={handleSaveComment}
          onDraftCancel={handleCancelComment}
          onDraftValueChange={(v) => {
            draft.value = v;
            session.updateDiffCommentDraftValue(v);
          }}
          canOpenInEditor={!!theme.defaultEditor}
          onOpenInEditor={openFileInEditor}
          onLineRange={handleStreamLineRange}
          onLineSelect={handleStreamLineRange}
          onLineClearSelect={handleLineClearSelect}
          onEditComment={handleEditComment}
          onDeleteComment={handleDeleteComment}
        />
      </div>
    </div>
  {/if}

  <DiffCommentsPopover
    open={commentsPopoverOpen}
    comments={diffComments}
    threads={navigableThreads}
    anchor={commentsAnchorEl}
    onClose={() => (commentsPopoverOpen = false)}
    onNavigate={navigateToComment}
    onNavigateThread={navigateToThread}
  />

  {#if !hasExternalCommentStore}
    <DiffActionBar
      pendingInlineDraft={pendingFormHasContent}
      filePath={draft.filePath}
      diffText={diffState.patch}
      {branchContext}
      workingTree={isWorkingTreeScope}
      onSubmitted={onClose}
      beforeSend={handleBeforeSend}
      onShowComments={() => (commentsPopoverOpen = true)}
    />
  {/if}

  {#if mobileTreeOpen && runtime.isMobileViewport}
    <DiffMobileFileSheet
      files={orderedFiles}
      onClose={() => (mobileTreeOpen = false)}
      onSelect={handleMobileFileSelect}
    />
  {/if}
</div>

<style>
  :global(.diff-panel-border) {
    border-left: 0.0625rem solid
      color-mix(in srgb, var(--solus-container-border) 45%, transparent);
  }
  @media (max-width: 767px) {
    :global(.diff-panel-border) {
      border-left: none;
    }
  }

</style>
