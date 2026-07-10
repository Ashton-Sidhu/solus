<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    DownloadSimpleIcon,
    PlusIcon,
    GitDiffIcon,
    GitForkIcon,
    GitPullRequestIcon,
    ListBulletsIcon,
    FoldersIcon,
    ClockCounterClockwiseIcon,
    GearSixIcon,
    KeyboardIcon,
    GitBranchIcon,
    TreeStructureIcon,
    CheckSquareIcon,
    FolderIcon,
    ListChecksIcon,
    PlugsIcon,
  } from "phosphor-svelte";
  import DesignAnnotation from "./components/artifact/DesignAnnotation.svelte";
  import DirectoryPicker from "./components/pickers/DirectoryPicker.svelte";
  import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.svelte";
  import CommandPalette from "./components/command-palette/CommandPalette.svelte";
  import AddServerModal from "./components/servers/AddServerModal.svelte";
  import ClaimServerModal from "./components/servers/ClaimServerModal.svelte";
  import OfflineBanner from "./components/servers/OfflineBanner.svelte";
  import type { Command } from "./components/command-palette/lib/commands";
  import TaskComposer from "./components/tasks/TaskComposer.svelte";
  import { projectsStore } from "./contexts/projects.store.svelte";
  import { toasts } from "./contexts/toast.store.svelte";
  import { connectionsStore } from "./contexts/connections.store.svelte";
  import { serversStore } from "./components/servers/servers.store.svelte";
  import EditorLayout from "./components/layout/EditorLayout.svelte";
  import PillLayout from "./components/layout/PillLayout.svelte";
  import { invalidateHomeCache } from "./components/layout/NewTabHome.svelte";
  import { setPopoverLayer } from "./components/popoverLayer.svelte";
  import { worktreeProjectRoot } from "../shared/types";
  import type {
    AgentId,
    DesignAnnotation as DesignAnnotationType,
    PlanDescriptor,
    ProjectEntry,
  } from "../shared/types";
  import type { PullRequestSummary } from "../shared/providers";
  import { setupAgentEvents } from "./hooks/agentEvents.svelte";
  import { bootstrapRuntimeTabs } from "./contexts/session-bootstrap";
  import {
    savePersistedTabsDebounced,
    flushPersistedTabs,
    patchActiveDraft,
    flushDrafts,
    type PersistedTabs,
  } from "./contexts/tab-persistence";
  import {
    consumeSessionHandoff,
  } from "./contexts/active-session-pointer";
  import { createAppCore } from "./contexts/app-core";
  import {
    useKeybinding,
    installGlobalDispatcher,
  } from "./lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "./lib/keybindings/manifest";
  import { requestInputFocus } from "./lib/inputFocus";
  import { initRootScaling } from "./lib/uiScale";
  import { dictation, isDictationTarget } from "./lib/dictation.svelte";
  import { branchKeyFor, buildTabSections } from "./lib/sessionUtils";
  import { initAnalytics, analytics } from "./lib/analytics";

  const {
    settings,
    windowCtx,
    statusBar,
    planStore,
    gitStatusStore,
    runStore,
    projectConfigStore,
    voiceModelStore,
    session,
    sessionSidebarStore,
    agent,
    keybindings,
  } = createAppCore();

  // Electron-only: analytics is desktop-side. appOpened fires from the pill
  // window only — it's the boot window, so this counts once per app open even
  // when the editor window is also up.
  initAnalytics(settings.analyticsEnabled);
  if (windowCtx.viewMode === "pill") analytics.appOpened();

  // Persist open-tab snapshot to localStorage so it survives refresh and cold restarts.
  // Reads only the persisted fields, so it won't re-run on message streaming.
  // Skipped while bootstrap is in progress so an empty initial state doesn't clobber saved data.
  $effect(() => {
    if (session.hydrating) return;
    const tabs = session.tabOrder
      .filter((id) => session.tabs[id])
      .map((tabId) => {
        const tab = session.tabs[tabId];
        const sess = session.sessionFor(tabId);
        return {
          tabId,
          title: tab.title ?? "New Tab",
          agentSessionId: sess?.agentSessionId ?? null,
          provider: sess?.provider ?? null,
          workingDirectory:
            sess?.workingDirectory ?? session.globalDefaults.workingDirectory,
          additionalDirs: sess ? [...sess.additionalDirs] : [],
          gitContext: sess?.gitContext ? { ...sess.gitContext } : null,
          worktreeBaseBranch: sess?.worktreeBaseBranch ?? null,
          modelConfig: sess
            ? { ...sess.modelConfig }
            : { ...session.globalDefaults.modelConfig },
          permissionMode:
            sess?.permissionMode ?? session.globalDefaults.permissionMode,
          hasUnread: tab.hasUnread ?? false,
        };
      });
    const snapshot: PersistedTabs = {
      version: 1,
      activeTabId: session.activeTabId,
      tabOrder: [...session.tabOrder],
      tabs,
    };
    savePersistedTabsDebounced(snapshot);
  });

  // Unsent input drafts persist per-keystroke on a debounce. Only reads the active
  // tab's input — other tabs' drafts are patched into the persisted map individually
  // as the user visits each tab, rather than re-reading all N tabs every keystroke.
  $effect(() => {
    if (session.hydrating) return;
    const activeId = session.activeTabId;
    const tabText = session.tabs[activeId]?.input.text ?? "";
    const activeInputText = session.activeInput.text;
    patchActiveDraft(activeId, tabText, activeInputText);
  });

  // Flush pending drafts + tab snapshot before the window unloads so the latest
  // keystrokes and structural changes survive.
  $effect(() => {
    const flush = () => {
      flushDrafts();
      flushPersistedTabs();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  });

  /** Focus (or attach) the session a pointer/handoff names. Reuses the resume
   *  path, which loads history and splices the live stream if a run is going. */
  function openSessionFromPointer(ptr: {
    sessionId: string;
    provider: AgentId;
    cwd: string;
    title: string | null;
  }) {
    const existingTab = session.tabOrder.find(
      (id) => session.sessionFor(id)?.agentSessionId === ptr.sessionId,
    );
    if (existingTab) {
      if (existingTab !== session.activeTabId) session.selectTab(existingTab);
      else session.isExpanded = true;
      return;
    }
    void session.resumeSession({
      provider: ptr.provider,
      sessionId: ptr.sessionId,
      slug: ptr.title,
      firstMessage: ptr.title,
      lastTimestamp: "",
      size: 0,
      cwd: ptr.cwd,
      projectPath: "",
    });
  }

  // Both windows: consume a "continue in the other mode" (⌥⇧E) handoff
  // addressed to this window's mode — one stashed before this window existed
  // and any that arrive while it's open. Gated on hydration so a boot-time
  // handoff doesn't race the tab bootstrap.
  $effect(() => {
    if (session.hydrating) return;
    return consumeSessionHandoff(viewMode, openSessionFromPointer);
  });

  // Slash command discovery is backend-scoped, so refresh when the active agent changes.
  // untrack the directory — explicit refreshPluginCommands calls in createTab/setBaseDirectory
  // already handle directory changes; tracking tabCtx here causes a storm on every session mutation.
  $effect(() => {
    void settings.activeAgent;
    void session.refreshPluginCommands(
      untrack(() => session.tabCtx.workingDirectory),
    );
  });

  setupAgentEvents(session);
  // Refresh the key the project panel reads: the worktree path when the tab has one.
  session.onTurnSettled = (tabId, cwd) => {
    const sess = session.sessionFor(tabId);
    const gitCwd = sess?.gitContext?.worktreePath ?? cwd;
    if (!gitCwd) return;
    // onTurnSettled fires on every completed Write/Edit/exec tool call (mid-turn)
    // as well as at task_complete. By that point the backend has already emitted
    // the status_change, so a still-running status means this is a mid-turn
    // settle — respect the store's throttle so ~20 edits don't spawn ~20 git
    // pipelines. When the turn actually completes (status reset off running),
    // force one authoritative refresh.
    const midTurn = sess?.status === "running" || sess?.status === "connecting";
    void gitStatusStore.refresh(gitCwd, { force: !midTurn });
  };

  initRootScaling();

  // Popovers portal into `overlayEl` via setPopoverLayer; bind it reactively so children see it post-mount.
  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();

  let designModeScreenshot = $state<string | null>(null);
  let directoryPickerOpen = $state(false);
  let directoryPickerNewTab = $state(false);
  let shortcutsModalOpen = $state(false);
  let shortcutsActiveScopes = $state<import("./lib/keybindings/types").Scope[]>(
    [],
  );
  let commandPaletteOpen = $state(false);
  // When set, the palette opens drilled straight into this sub-page (e.g. the
  // "Review a PR" git action reuses the "Review PR…" page). Cleared once consumed.
  let paletteInitialPage = $state<{ id: string; title: string } | null>(null);
  // The standalone create-task composer (project cwd + optional session seed)
  // lives on the UI store so the palette, the action orb, and create-from-session
  // can all open it. Saves straight through to the provider.
  const taskComposer = $derived(session.ui.taskComposer);
  const taskComposerConfig = $derived(
    taskComposer ? projectConfigStore.configFor(taskComposer.cwd) : undefined,
  );
  const taskComposerProvider = $derived(taskComposerConfig?.taskProvider ?? "local");
  const taskComposerTasks = $derived(
    taskComposer && session.tasksStore.cwd === taskComposer.cwd ? session.tasksStore.tasks : [],
  );
  const taskComposerEpics = $derived(taskComposerTasks.filter((t) => t.kind === "epic"));
  const taskComposerLabels = $derived(
    Array.from(new Set(taskComposerTasks.flatMap((t) => t.labels))).sort(),
  );

  $effect(() => {
    if (!taskComposer) return;
    void projectConfigStore.load(taskComposer.cwd);
  });

  const isExpanded = $derived(session.isExpanded);
  // Each Electron window is mode-locked (`?mode=` in its URL), so exactly one
  // layout mounts for the window's lifetime — no dual trees, no display:none
  // toggling. Switching modes surfaces the other OS window via switchMode.
  const viewMode = $derived(windowCtx.viewMode);
  const isEditorMode = $derived(viewMode === "editor");
  const activeTabId = $derived(session.activeTabId);
  const desktopHandlersAvailable = $derived(connectionsStore.desktopHandlersAvailable);
  // status/provider live on Session, not Tab — reading them off the tab always
  // yielded undefined, so isRunning was permanently false and the run-gated
  // global keybindings never blocked during a run.
  const activeTabStatus = $derived(session.sessionFor(activeTabId)?.status);
  const isRunning = $derived(
    activeTabStatus === "running" || activeTabStatus === "connecting",
  );

  const visibleTabOrder = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  // Tabs of the active branch, in the same visual (grouped) order the tab strip
  // shows — so next/prev-session cycles what the user sees. Filtering the raw
  // backend tabOrder here would diverge from the strip whenever tabs are grouped
  // by status/unread. Computed lazily on keypress (like navigateTab) rather than
  // as a $derived that recomputes on every backend status tick.
  function scopedSessionTabOrder(): string[] {
    const activeKey = branchKeyFor(session.sessionFor(activeTabId));
    return visualTabOrder(visibleTabOrder).filter(
      (id) => branchKeyFor(session.sessionFor(id)) === activeKey,
    );
  }
  const permissionMode = $derived(
    session.sessionFor(activeTabId)?.permissionMode ?? "auto",
  );

  $effect(() => {
    window.solus
      .getTheme()
      .then(({ isDark }: { isDark: boolean }) =>
        settings.setSystemTheme(isDark),
      );
    const unsub = window.solus.onThemeChange((isDark: boolean) =>
      settings.setSystemTheme(isDark),
    );
    return unsub;
  });

  $effect(() => {
    session.initStaticInfo().then(async () => {
      await bootstrapRuntimeTabs(session);
      const defaultDir = session.staticInfo?.workspacePath || "~";
      session.planStore.preloadDescriptors(defaultDir, session.ctx);
      void sessionSidebarStore.loadPinnedSessions();
    });
  });

  $effect(() => {
    void connectionsStore.refreshCapabilities();
  });

  $effect(() => {
    // Click-through only applies to the pill window's transparent canvas; the
    // editor is an opaque, normal OS window.
    if (isEditorMode) return;
    if (!window.solus?.setIgnoreMouseEvents) return;
    let lastIgnored: boolean = true;
    window.solus.setIgnoreMouseEvents(true, { forward: true });

    const setIgnore = (shouldIgnore: boolean) => {
      if (shouldIgnore === lastIgnored) return;
      lastIgnored = shouldIgnore;
      if (shouldIgnore) window.solus.setIgnoreMouseEvents(true, { forward: true });
      else window.solus.setIgnoreMouseEvents(false, { focus: true });
    };

    // Cached bounding rects of the pill's interactive regions. Measured on a short
    // interval while moving (and on resize / window-shown), so the per-move
    // pre-check below is pure math — no forced layout, no elementFromPoint —
    // until the pointer is actually over a UI region. A small edge tolerance
    // keeps entry prompt even if a child overflows its region's box.
    const EDGE = 4;
    const RECT_TTL = 200;
    let cachedRects: DOMRect[] = [];
    let rectsAt = 0;
    const recomputeRects = () => {
      const rects: DOMRect[] = [];
      for (const el of document.querySelectorAll("[data-solus-ui]")) {
        // The full-screen click-through overlay is pointer-events:none — only its
        // portaled popover children actually capture the mouse, so measure those.
        if (el.classList.contains("click-through-shell")) {
          for (const child of el.children)
            rects.push(child.getBoundingClientRect());
        } else {
          rects.push(el.getBoundingClientRect());
        }
      }
      cachedRects = rects;
      rectsAt = performance.now();
    };
    const pointOverUiRegion = (x: number, y: number) =>
      cachedRects.some(
        (r) =>
          x >= r.left - EDGE &&
          x <= r.right + EDGE &&
          y >= r.top - EDGE &&
          y <= r.bottom + EDGE,
      );

    // The real hit-test (forced sync elementFromPoint) only runs when the cheap
    // rect pre-check says the point might be over UI; outside every region the
    // window is definitively click-through, so we update promptly on leave.
    const applyAt = (x: number, y: number) => {
      if (!pointOverUiRegion(x, y)) {
        setIgnore(true);
        return;
      }
      const el = document.elementFromPoint(x, y);
      setIgnore(!(el && el.closest("[data-solus-ui]")));
    };

    // Coalesce to at most one hit-test per animation frame — the transparent
    // pill canvas fires mousemove on all screen movement, and a sync hit-test
    // per event stutters worst while streaming dirties the DOM.
    let pendingX = 0;
    let pendingY = 0;
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      if (performance.now() - rectsAt > RECT_TTL) recomputeRects();
      applyAt(pendingX, pendingY);
    };
    const onMouseMove = (e: MouseEvent) => {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (!rafId) rafId = requestAnimationFrame(flush);
    };
    const onMouseLeave = () => {
      // Drop any queued hit-test so a stale in-flight frame can't re-enable
      // capture just after the pointer has left the window.
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      setIgnore(true);
    };
    const onResize = () => recomputeRects();
    const unsubShown = window.solus.onWindowShown((pos) => {
      if (pos) {
        recomputeRects();
        applyAt(pos.x, pos.y);
      }
    });
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("resize", onResize);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsubShown();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("resize", onResize);
    };
  });

  $effect(() => {
    const unsubRun = window.solus.onRunStatus((status) =>
      runStore.apply(status),
    );
    const unsubRunLog = window.solus.onRunLog((batch) =>
      runStore.applyLog(batch),
    );
    const unsubVoiceModel = window.solus.onVoiceModelStatus((status) =>
      voiceModelStore.apply(status),
    );
    void voiceModelStore.refresh();
    // Live automation state: scheduler fires, run transitions, and agent-tool
    // saves all land here. Failures get a toast — an unattended run breaking
    // is otherwise invisible until the user happens to open the page.
    const unsubAutomations = window.solus.onAutomationsChanged((event) => {
      session.automationsStore.applyChange(event);
      if (event.kind === "run-finished" && event.run.status === "failed") {
        toasts.error(`Automation "${event.automation.name}" failed`, {
          action: {
            label: "View",
            onAction: () => session.openAutomations(event.automation.id),
          },
        });
      }
    });
    const unsubMergeQueue = window.solus.onMergeQueueUpdate((state) =>
      session.mergeQueueStore.apply(state),
    );
    const unsubShown = window.solus.onWindowShown(() => {
      const active = session.sessionFor(session.activeTabId);
      const cwd =
        active?.gitContext?.worktreePath ??
        active?.workingDirectory ??
        session.globalDefaults.workingDirectory;
      if (cwd) void gitStatusStore.refresh(cwd, { force: true });
      // Cheap catch-all for branch changes the watcher missed (e.g. external
      // checkout while a non-worktree session sat in the background).
      if (active && !active.gitContext?.worktreePath && active.workingDirectory) {
        void session.fetchGitContext(session.activeTabId, active.workingDirectory);
      }
    });
    return () => {
      unsubRun();
      unsubRunLog();
      unsubVoiceModel();
      unsubAutomations();
      unsubMergeQueue();
      unsubShown();
    };
  });

  // Keep main informed of whether the live text selection sits inside the
  // conversation view, so its native right-click menu can offer "Quote in
  // reply" only there. Pushed ahead of the click (on selectionchange) so main
  // already has the answer when the context menu fires — no IPC race.
  $effect(() => {
    let lastActive = false;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      let active = false;
      // Bail before the O(selection) toString() on the common continuous-drag
      // path where there's no real selection (collapsed caret / no range).
      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim()) {
        const node = sel.getRangeAt(0).commonAncestorContainer;
        const el =
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element)
            : node.parentElement;
        active = !!el?.closest(".conversation-selectable");
      }
      if (active !== lastActive) {
        lastActive = active;
        window.solus.setQuoteContext(active);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  });

  // Mount global scope and the single dispatcher listener (shared with web).
  installGlobalDispatcher(keybindings, () => settings.keybindings);
  $effect(() => {
    // Pre-listener for ⌥⇧K: always claims the combo so macOS never sees it
    // (exclusive scopes in DocumentShell block the normal dispatcher for global
    // bindings, which would otherwise let macOS insert the  character).
    // Handles dictation into focused plain inputs. Non-dictation cases (e.g.
    // the chat composer) are handled by InputBar's own keybinding handler,
    // which the dispatcher still reaches when no exclusive scope is active.
    //
    // Runs in the capture phase so it fires before any subtree keydown handler
    // (e.g. the diff panel's tree/diff widgets) can stopPropagation and swallow
    // the combo — without this, ⌥⇧K does nothing while focused inside the panel.
    const handleVoiceKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.altKey || !e.shiftKey || e.code !== "KeyK") return;
      e.preventDefault();
      const el = document.activeElement;
      if (isDictationTarget(el)) dictation.toggleInto(el);
    };
    document.addEventListener("keydown", handleVoiceKey, true);
    return () => document.removeEventListener("keydown", handleVoiceKey, true);
  });

  // ── Global keybinding handlers ────────────────────────────────────────────
  useKeybinding("global.select-project", () => {
    if (isRunning) return;
    directoryPickerOpen = true;
  });
  useKeybinding("global.new-tab", () => session.createTab());

  function visualTabOrder(tabIds: string[]): string[] {
    return buildTabSections(
      tabIds,
      session.tabGroupMode,
      (id) => session.resolveTab(id),
      planStore.plans,
    ).flatMap((s) => s.tabIds);
  }

  function visualBranchTabOrder(): string[] {
    const visualOrder = visualTabOrder(visibleTabOrder);
    const fallbackByBranch = new Map<string, string>();
    const targetByBranch = new Map<string, string>();
    for (const tabId of visualOrder) {
      const key = branchKeyFor(session.sessionFor(tabId));
      if (!fallbackByBranch.has(key)) fallbackByBranch.set(key, tabId);
      const target = session.lastActiveTabForBranch(key);
      if (target && visualOrder.includes(target)) {
        targetByBranch.set(key, target);
      }
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const tabId of visualOrder) {
      const key = branchKeyFor(session.sessionFor(tabId));
      const target = targetByBranch.get(key) ?? fallbackByBranch.get(key);
      if (!target || tabId !== target || seen.has(key)) continue;
      seen.add(key);
      ordered.push(tabId);
    }
    return ordered;
  }

  function navigateTab(delta: 1 | -1) {
    // The tab strip reorders tabs into grouping sections (status / unread), so
    // next/prev-tab must follow that visual order — not the raw backend tabOrder —
    // or the shortcut jumps to a tab that isn't visually adjacent. Computed lazily
    // here (only on keypress) rather than as a $derived that recomputes on every
    // backend tick.
    const order = isEditorMode
      ? visualBranchTabOrder()
      : visualTabOrder(visibleTabOrder);
    const activeKey = branchKeyFor(session.sessionFor(activeTabId));
    const idx = isEditorMode
      ? order.findIndex(
          (id) => branchKeyFor(session.sessionFor(id)) === activeKey,
        )
      : order.indexOf(activeTabId);
    if (idx === -1) return;
    const nextId = order[(idx + delta + order.length) % order.length];
    const target = isEditorMode
      ? (session.lastActiveTabForBranch(
          branchKeyFor(session.sessionFor(nextId)),
        ) ?? nextId)
      : nextId;
    session.selectTab(target);
    requestInputFocus();
  }

  useKeybinding("global.next-tab", () => navigateTab(1));
  useKeybinding("global.prev-tab", () => navigateTab(-1));
  useKeybinding("global.next-session", () => {
    // Pill mode has no branch/session split — fall back to cycling tabs.
    if (!isEditorMode) return navigateTab(1);
    const order = scopedSessionTabOrder();
    const idx = order.indexOf(activeTabId);
    if (idx !== -1) {
      session.selectTab(order[(idx + 1) % order.length]);
      requestInputFocus();
    }
  });
  useKeybinding("global.prev-session", () => {
    if (!isEditorMode) return navigateTab(-1);
    const order = scopedSessionTabOrder();
    const idx = order.indexOf(activeTabId);
    if (idx !== -1) {
      session.selectTab(order[(idx - 1 + order.length) % order.length]);
      requestInputFocus();
    }
  });
  useKeybinding("global.screenshot", handleScreenshot, {
    enabled: () => desktopHandlersAvailable,
  });
  useKeybinding("global.continue-in-mode", () => session.continueInOtherMode());
  useKeybinding("global.session-picker", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.session-picker-j", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.toggle-expanded", () => session.toggleExpanded(), {
    enabled: () => viewMode === "pill",
  });
  useKeybinding("global.cycle-perm-mode", () => {
    const modes = ["ask", "auto", "plan"] as const;
    const next =
      modes[
        (modes.indexOf(permissionMode as (typeof modes)[number]) + 1) %
          modes.length
      ];
    session.setPermissionMode(next);
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) session.closeTab(activeTabId);
  });
  useKeybinding("global.group-tabs", () => {
    session.toggleTabGroupMode();
  });
  useKeybinding("global.attach-file", handleAttachFile);
  useKeybinding("global.design-mode", () => {
    if (!isRunning && desktopHandlersAvailable) handleDesignMode();
  }, {
    enabled: () => desktopHandlersAvailable,
  });
  useKeybinding("global.cycle-agent", async () => {
    if (isRunning) return;
    await cycleAgentProvider();
    requestInputFocus();
  });
  useKeybinding("global.cycle-model", () => {
    if (isRunning) return;
    const models = agent.activeMetadata?.models;
    if (!models || models.length === 0) return;
    const defaultModel = agent.activeMetadata?.defaultModel;
    const currentModel = statusBar.ctx.model || (defaultModel ?? models[0].id);
    const idx = models.findIndex((m) => m.id === currentModel);
    session.updateModelConfig({
      modelId: models[((idx === -1 ? 0 : idx) + 1) % models.length].id,
    });
    requestInputFocus();
  });
  useKeybinding("global.toggle-reasoning", () => {
    if (isRunning) return;
    window.dispatchEvent(
      new CustomEvent("solus:toggle-session-settings-picker"),
    );
  });
  useKeybinding(
    "global.toggle-diff-panel",
    () => window.dispatchEvent(new CustomEvent("solus:toggle-diff-panel")),
    {
      enabled: () => viewMode === "editor",
    },
  );
  useKeybinding("global.toggle-plans", () => session.togglePlansGallery());
  useKeybinding("global.toggle-folio", () => session.toggleFolioGallery());
  useKeybinding("global.toggle-automations", () => session.toggleAutomations());
  useKeybinding("global.toggle-tasks", () => session.toggleTasks());
  useKeybinding("global.settings", () => session.showSettings());
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.toggle-worktree", () => session.toggleWorktreeMode());
  useKeybinding("global.switch-worktree", () => {
    const hasAgent = !!session.sessionFor(activeTabId)?.agentSessionId;
    if (hasAgent) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding(
    "global.git-open-terminal",
    () => window.solus.openWorktreeTerminal(session.ctx),
    { enabled: () => desktopHandlersAvailable },
  );
  useKeybinding("global.show-shortcuts", () => {
    shortcutsActiveScopes = keybindings.activeScopes();
    shortcutsModalOpen = true;
  });
  useKeybinding(
    "global.command-palette",
    () => {
      commandPaletteOpen = true;
    },
    {
      enabled: () => viewMode === "editor",
    },
  );

  const paletteGitProjectRoot = $derived.by(() => {
    const dir =
      session.activeSession?.gitContext?.repoRoot ??
      session.activeSession?.workingDirectory;
    return dir && dir !== "~" ? worktreeProjectRoot(dir) : null;
  });
  const paletteGitRefs = $derived(gitStatusStore.refsFor(paletteGitProjectRoot));
  const worktrees = $derived(paletteGitRefs.worktrees);
  const paletteBranches = $derived(paletteGitRefs.branches);
  // Open PRs for the "Review PR…" sub-page, loaded lazily alongside the git refs.
  let palettePrs = $state<PullRequestSummary[]>([]);
  $effect(() => {
    if (!commandPaletteOpen) return;
    const projectRoot = paletteGitProjectRoot;
    if (!projectRoot) {
      palettePrs = [];
      return;
    }
    void gitStatusStore.refreshRefs(
      projectRoot,
      untrack(() => session.ctxForDirectory(projectRoot)),
      { force: true },
    );
    session.prsStore
      .loadFor(untrack(() => session.ctx), { state: "open" })
      .then((prs) => {
        palettePrs = prs;
      })
      .catch(() => {
        palettePrs = [];
      });
  });

  // Plans, works, and automations for the "Open …" sub-pages, loaded lazily when
  // the palette opens so they mirror what currently exists. Plans live in local
  // state (the descriptor list isn't otherwise reactive); works and automations
  // are read straight from their reactive stores after triggering a refresh.
  let palettePlans = $state<PlanDescriptor[]>([]);
  // Known projects for the "Create task in…" sub-page, refreshed when the palette
  // opens so the list mirrors what the projects manifest currently holds.
  let paletteProjects = $state<ProjectEntry[]>([]);
  $effect(() => {
    if (!commandPaletteOpen) return;
    const cwd = session.galleryProjectPath;
    const scopedCwd = cwd === "~" ? undefined : cwd;
    const ctx = untrack(() => session.ctx);
    session.planStore
      .getDescriptors(undefined, true, ctx)
      .then((ds) => {
        palettePlans = ds;
      })
      .catch(() => {
        palettePlans = [];
      });
    void session.worksStore.loadAll(scopedCwd);
    void session.automationsStore.loadAll();
    // Populate the "Go to task…" sub-page. Load once per project (the panel keeps
    // the same store), so reopening the palette doesn't re-hit the provider.
    const taskCwd = session.tasksProjectCwd;
    if (
      taskCwd &&
      (session.tasksStore.cwd !== taskCwd || !session.tasksStore.loaded)
    ) {
      void session.tasksStore.load(taskCwd);
    }
    projectsStore
      .loadProjects({ force: true })
      .then((ps) => {
        paletteProjects = ps;
      })
      .catch(() => {
        paletteProjects = [];
      });
  });

  // Seed command set for the editor command palette. Intentionally a small,
  // obviously-correct starter list — the UI is the deliverable here; richer,
  // context-aware commands get layered in later.
  const baseCommands: Command[] = [
    {
      id: "new-tab",
      label: "New session",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-tab"),
      keywords: ["create", "session", "tab"],
      run: () => session.createTab(),
    },
    {
      id: "view-working-tree-diff",
      label: "View working tree diff",
      group: "Git",
      icon: GitDiffIcon,
      keywords: ["changes", "uncommitted", "git", "diff"],
      run: () =>
        window.dispatchEvent(
          new CustomEvent("solus:toggle-diff-panel", {
            detail: { scope: { kind: "working-tree" }, switchScope: true },
          }),
        ),
    },
    {
      id: "settings",
      label: "Settings",
      group: "General",
      icon: GearSixIcon,
      hint: comboHint("global.settings"),
      keywords: ["preferences", "config"],
      run: () => session.showSettings(),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      group: "General",
      icon: KeyboardIcon,
      hint: comboHint("global.show-shortcuts"),
      keywords: ["keybindings", "keys"],
      run: () => {
        shortcutsActiveScopes = keybindings.activeScopes();
        shortcutsModalOpen = true;
      },
    },
    {
      id: "add-server",
      label: "Add server",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["remote", "pair", "connect"],
      run: () => serversStore.openAddServer(),
    },
  ];

  async function switchPaletteBranch(branch: string): Promise<boolean> {
    const projectRoot = paletteGitProjectRoot;
    if (projectRoot) {
      const ctx = session.ctxForDirectory(projectRoot);
      await gitStatusStore.refreshRefs(projectRoot, ctx, { force: true });
      const worktree = gitStatusStore
        .refsFor(projectRoot)
        .worktrees.find((wt) => wt.branch === branch);
      if (worktree) {
        await session.switchToWorktree(worktree.path);
        const nextCwd =
          session.activeSession?.gitContext?.worktreePath ??
          session.activeSession?.workingDirectory;
        if (nextCwd) void gitStatusStore.refresh(nextCwd, { force: true });
        requestInputFocus();
        return true;
      }
    }

    const ok = await session.switchToBranch(branch);
    const nextCwd =
      session.activeSession?.gitContext?.worktreePath ??
      session.activeSession?.workingDirectory;
    if (ok && nextCwd) void gitStatusStore.refresh(nextCwd, { force: true });
    requestInputFocus();
    return ok;
  }

  // "Open plan/document/automation…" mirror the "Open worktree…" flow: a parent
  // command that drills into a sub-page listing the existing items, each of which
  // opens that one artifact. Only shown when there's something to open, so they
  // don't clutter the root list. Worktree actions only make sense inside a git
  // project; "Open worktree…" drills the same way.
  const paletteCommands = $derived.by(() => {
    const commands: Command[] = [...baseCommands];

    for (const server of serversStore.servers) {
      commands.push({
        id: `switch-server:${server.id}`,
        label: `Switch server: ${server.label}`,
        group: "Servers",
        icon: PlugsIcon,
        hint: server.id === serversStore.activeServerId ? "Active" : undefined,
        keywords: ["server", "remote", "connect", server.url, server.installationId ?? ""],
        run: () => serversStore.switchTo(server.id),
      });
    }

    // Always surface the parent commands so they appear the instant the palette
    // opens; their children stream in as the background loads resolve, and the
    // sub-page reflects them live (CommandPalette re-derives children by id).
    const planChildren: Command[] = palettePlans.map((d) => ({
      id: `plan:${d.sessionId}:${d.planToolUseId}`,
      label: d.title || "Untitled plan",
      group: "Plans",
      icon: ListBulletsIcon,
      keywords: [d.title ?? ""],
      run: () => void session.openPlanFromDescriptor(d),
    }));
    commands.push({
      id: "open-plan",
      label: "Open plan…",
      group: "View",
      icon: ListBulletsIcon,
      keywords: ["plan", "open"],
      children: planChildren,
    });

    const workChildren: Command[] = Object.values(session.worksStore.works)
      .filter(
        (w) =>
          w.title &&
          !session.worksStore.streaming[w.id] &&
          session.pendingWorkDelete?.id !== w.id,
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((w) => ({
        id: `work:${w.id}`,
        label: w.title,
        group: "Documents",
        icon: FoldersIcon,
        keywords: [w.title],
        run: () => void session.openWorkModal(w.id, w.title),
      }));
    commands.push({
      id: "open-work",
      label: "Open document…",
      group: "View",
      icon: FoldersIcon,
      keywords: ["work", "document", "folio", "open"],
      children: workChildren,
    });

    const automationChildren: Command[] = session.automationsStore.items.map(
      (a) => ({
        id: `automation:${a.id}`,
        label: a.name,
        group: "Automations",
        icon: ClockCounterClockwiseIcon,
        keywords: [a.name],
        run: () => session.openAutomations(a.id),
      }),
    );
    commands.push({
      id: "open-automation",
      label: "Open automation…",
      group: "View",
      icon: ClockCounterClockwiseIcon,
      keywords: ["automation", "schedule", "cron", "open"],
      children: automationChildren,
    });
    // Create a task — one entry scoped to the status-bar project, plus a sub-page
    // to pick any other known project. Both pop the standalone create-task modal.
    const taskCwd = session.tasksProjectCwd;
    if (taskCwd) {
      const taskProjectName = taskCwd.split("/").filter(Boolean).pop() ?? taskCwd;
      commands.push({
        id: "create-task",
        label: `Create task in ${taskProjectName}`,
        group: "Tasks",
        icon: CheckSquareIcon,
        keywords: ["task", "create", "new", "todo", "issue", taskProjectName],
        run: () => session.ui.openTaskComposer(taskCwd),
      });
    }
    const createTaskInChildren: Command[] = paletteProjects.map((p) => ({
      id: `create-task-in:${p.path}`,
      label: p.folderName || (p.path.split("/").filter(Boolean).pop() ?? p.path),
      group: "Projects",
      icon: FolderIcon,
      keywords: [p.folderName, p.path],
      run: () => session.ui.openTaskComposer(p.path),
    }));
    commands.push({
      id: "create-task-in",
      label: "Create task in…",
      group: "Tasks",
      icon: CheckSquareIcon,
      keywords: ["task", "create", "new", "todo", "issue", "project"],
      children: createTaskInChildren,
    });

    // Open any existing task (opens its detail). Like the other parent
    // commands, surface this the instant the palette opens so it never waits on
    // the tasks provider; children stream in once the store loads for this
    // project. Only the active project's tasks count (the store is scoped to one
    // cwd, so anything else is stale).
    const tasksLoadedForProject =
      !!taskCwd && session.tasksStore.cwd === taskCwd && session.tasksStore.loaded;
    const goToTaskChildren: Command[] = tasksLoadedForProject
      ? session.tasksStore.tasks.map((t) => ({
          id: `go-to-task:${t.id}`,
          label: t.title,
          group: "Tasks",
          icon: ListChecksIcon,
          hint: t.kind === "epic" ? "Epic" : undefined,
          keywords: ["task", t.id, t.assignee ?? "", ...t.labels],
          run: () => session.goToTask(t),
        }))
      : [];
    if (taskCwd) {
      commands.push({
        id: "go-to-task",
        label: "Open task…",
        group: "View",
        icon: ListChecksIcon,
        keywords: ["task", "go", "open", "find", "jump", "issue", "ticket"],
        children: goToTaskChildren,
      });
    }

    commands.push({
      id: "open-prs",
      label: "Open pull requests",
      group: "View",
      icon: GitPullRequestIcon,
      keywords: ["pr", "pull request", "github", "review", "prs"],
      run: () => session.openPrs(),
    });

    const gitCtx = session.activeSession?.gitContext ?? session.globalDefaults.gitContext;
    if (gitCtx) {
      const worktreeBranchNames = worktrees.map((wt) => wt.branch);
      const branchCommands: Command[] = [
        ...paletteBranches
          .filter((branch) => !worktreeBranchNames.includes(branch))
          .map((branch) => ({
            id: `branch:${branch}`,
            label: branch,
            group: "Git",
            icon: GitBranchIcon,
            keywords: ["git", "branch", "checkout", "switch", branch],
            run: () => void switchPaletteBranch(branch),
          })),
        ...worktrees
          .filter((wt) => wt.path !== gitCtx.worktreePath)
          .map((wt) => ({
            id: `worktree:${wt.path}`,
            label: wt.branch,
            group: "Git",
            icon: GitForkIcon,
            keywords: ["git", "worktree", "branch", "checkout", wt.branch],
            run: () => void session.switchToWorktree(wt.path),
          })),
      ];
      const existingWorktreeChildren: Command[] = worktrees
        .filter((wt) => wt.path !== gitCtx.worktreePath)
        .map((wt) => ({
          id: `new-session-existing-worktree:${wt.path}`,
          label: wt.branch,
          group: "Worktrees",
          icon: GitForkIcon,
          keywords: ["session", "worktree", "existing", wt.branch, wt.path],
          run: () => {
            void (async () => {
              await session.createTab();
              await session.switchToWorktree(wt.path);
            })();
          },
        }));
      const newSessionBranchChildren: Command[] = paletteBranches
        .filter((branch) => !worktreeBranchNames.includes(branch))
        .map((branch) => ({
          id: `new-session-branch:${branch}`,
          label: branch,
          group: "Branches",
          icon: GitBranchIcon,
          keywords: ["session", "branch", "checkout", "switch", branch],
          run: () => {
            void (async () => {
              await session.createTab();
              await switchPaletteBranch(branch);
            })();
          },
        }));
      const newSessionInChildren: Command[] = [
        ...newSessionBranchChildren,
        ...existingWorktreeChildren,
      ];
      const activeSess = session.activeSession;
      const canContinueWorktree =
        !!activeSess?.agentSessionId && !activeSess.gitContext?.worktreePath;
      const worktreeCommands: Command[] = [
        ...(canContinueWorktree
          ? [
              {
                id: "continue-in-worktree",
                label: "Continue in worktree",
                group: "General",
                icon: TreeStructureIcon,
                keywords: ["worktree", "continue", "move", "branch", "isolated", "fork"],
                hint: comboHint("global.continue-worktree"),
                run: () => void session.continueInWorktree(activeTabId),
              } as Command,
            ]
          : []),
        {
          id: "new-session-new-worktree",
          label: "New session in new worktree",
          group: "General",
          icon: GitForkIcon,
          keywords: ["worktree", "branch", "isolated", "create", "new"],
          run: () => void session.createWorktreeTab(),
        },
        {
          id: "new-session-in",
          label: "New session in…",
          group: "General",
          icon: GitForkIcon,
          keywords: ["session", "branch", "worktree", "checkout", "switch", "remote", "existing", "open", "pick"],
          children: newSessionInChildren,
        },
        {
          id: "switch-branch-or-worktree",
          label: "Switch branch or worktree…",
          group: "Git",
          icon: GitBranchIcon,
          keywords: ["git", "branch", "checkout", "switch", "worktree"],
          children: branchCommands,
        },
        {
          id: "review-pr",
          label: "Review PR…",
          group: "Git",
          icon: GitPullRequestIcon,
          keywords: ["git", "pull request", "pr", "github", "review"],
          // Children stream in once palettePrs resolves; the sub-page re-derives
          // its list by id, so they appear without re-entering the page.
          children: palettePrs.map((pr) => ({
            id: `pr:${pr.number}`,
            label: pr.title,
            group: "Pull requests",
            icon: GitPullRequestIcon,
            hint: `#${pr.number}`,
            keywords: ["pr", "pull request", "review", String(pr.number), pr.author],
            run: () => void session.enterPrReview(pr.number, pr.title),
          })),
        },
      ];
      // Slot the git actions directly beneath "New session" so they stay near
      // session creation instead of drifting to the tail.
      const newTabIdx = commands.findIndex((c) => c.id === "new-tab");
      commands.splice(newTabIdx + 1, 0, ...worktreeCommands);
    }

    return commands;
  });

  dictation.configure(
    () => settings.vadSilenceMs,
    () => settings.voiceModeEnabled,
    () => voiceModelStore.ready,
  );

  $effect(() => {
    if (!isEditorMode && !isExpanded && session.artifactViewer.activePlanId) {
      session.closePlanModal();
    }
  });

  async function handleScreenshot() {
    if (!desktopHandlersAvailable) return;
    const result = await window.solus.takeScreenshot();
    if (!result) return;
    session.addAttachments([result]);
  }

  async function handleAttachFile() {
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files);
  }

  async function handleDesignMode() {
    if (!desktopHandlersAvailable) return;
    const result = await window.solus.enterDesignMode();
    if (!result) {
      // Capture failed: tell main to restore opacity so we don't leave the window invisible.
      window.solus.designModeReady();
      return;
    }
    // Pre-decode so the <img> paints on first frame. Without this the editor UI (temporarily
    // resized to the full work area for capture) can bleed through the transparent window
    // for a frame or two before the screenshot shows up.
    try {
      const img = new Image();
      img.src = result.dataUrl;
      await img.decode();
    } catch {}
    designModeScreenshot = result.dataUrl;
    // tick() flushes Svelte DOM writes; double-rAF waits one frame past that for paint.
    await tick();
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    window.solus.designModeReady();
  }

  async function handleDesignConfirm(
    dataUrl: string,
    annotations: DesignAnnotationType[],
  ) {
    const attachment = await window.solus.submitDesignAnnotations({
      dataUrl,
      annotations,
    });
    if (attachment) {
      session.addAttachments([attachment]);
    }
    designModeScreenshot = null;
  }

  function handleDesignCancel() {
    designModeScreenshot = null;
  }

  async function cycleAgentProvider() {
    const enabledAgents = agent.agents.filter(
      (candidate) => agent.metadata[candidate.id]?.available === true,
    );
    if (enabledAgents.length <= 1) return;

    const currentAgent =
      session.sessionFor(activeTabId)?.provider ?? settings.activeAgent;
    const idx = enabledAgents.findIndex(
      (candidate) => candidate.id === currentAgent,
    );
    const next = enabledAgents[(idx + 1) % enabledAgents.length];
    session.switchActiveAgent(next.id);
  }

  $effect(() => {
    const unsub = window.solus.onEnterDesignMode(() => {
      if (desktopHandlersAvailable) handleDesignMode();
    });
    return unsub;
  });

  $effect(() => {
    const handler = () => {
      if (!isRunning) {
        directoryPickerNewTab = false;
        directoryPickerOpen = true;
      }
    };
    const newTabHandler = () => {
      directoryPickerNewTab = true;
      directoryPickerOpen = true;
    };
    // The git "Review a PR" action reuses the palette's PR list: open the
    // command palette drilled straight into the "Review PR…" sub-page.
    const reviewPrHandler = () => {
      paletteInitialPage = { id: "review-pr", title: "Review PR" };
      commandPaletteOpen = true;
    };
    window.addEventListener("solus:open-directory-picker", handler);
    window.addEventListener(
      "solus:open-directory-picker-new-tab",
      newTabHandler,
    );
    window.addEventListener("solus:review-pr", reviewPrHandler);
    return () => {
      window.removeEventListener("solus:open-directory-picker", handler);
      window.removeEventListener(
        "solus:open-directory-picker-new-tab",
        newTabHandler,
      );
      window.removeEventListener("solus:review-pr", reviewPrHandler);
    };
  });

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false;
    invalidateHomeCache();
    if (directoryPickerNewTab) {
      directoryPickerNewTab = false;
      await session.createTab(dir);
    } else {
      await session.setBaseDirectory(dir);
    }
    requestInputFocus();
  }

  function handleDirectoryPickerClose() {
    directoryPickerOpen = false;
    directoryPickerNewTab = false;
    requestInputFocus();
  }

  let isDraggingFile = $state(false);
  let dragCounter = 0;

  $effect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      isDraggingFile = true;
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        isDraggingFile = false;
      }
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      isDraggingFile = false;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths = Array.from(files)
        .map((f) => window.solus.getPathForFile(f))
        .filter(Boolean);
      if (paths.length === 0) return;
      const attachments = await window.solus.attachFilePaths(paths);
      if (attachments) session.addAttachments(attachments);
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  });
</script>

<!-- Popover overlay layer: sits above everything, ignores events except where portals opt in. -->
<div
  bind:this={overlayEl}
  data-solus-ui
  class="click-through-shell"
  style="position:fixed;inset:0;z-index:10010;pointer-events:none"
></div>

{#if isEditorMode}
  <div class="mode-shell h-full w-full">
    <EditorLayout
      onAttachFile={handleAttachFile}
      onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
      onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
    />
  </div>
{:else}
  <div class="mode-shell">
    <PillLayout
      onAttachFile={handleAttachFile}
      onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
      onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
    />
  </div>
{/if}

<DirectoryPicker
  bind:open={directoryPickerOpen}
  onClose={handleDirectoryPickerClose}
  onSelect={handleDirectorySelected}
/>

<KeyboardShortcutsModal
  bind:open={shortcutsModalOpen}
  activeScopes={shortcutsActiveScopes}
/>

<CommandPalette
  bind:open={commandPaletteOpen}
  bind:initialPage={paletteInitialPage}
  commands={commandPaletteOpen ? paletteCommands : []}
/>

<OfflineBanner />
<AddServerModal />
<ClaimServerModal />

{#if taskComposer && taskComposerConfig !== undefined}
  <TaskComposer
    epics={taskComposerEpics}
    allowEpics={taskComposerProvider === "local"}
    canPlan={taskComposerProvider === "local"}
    knownLabels={taskComposerLabels}
    workingDirectory={taskComposer.cwd}
    provider={settings.activeAgent}
    onCreate={async (input) => {
      const cwd = taskComposer?.cwd;
      if (!cwd) return;
      try {
        if (session.tasksStore.cwd === cwd) await session.tasksStore.create(cwd, input);
        else await window.solus.tasksCreate(cwd, input);
        toasts.success("Task created");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toasts.error(`Couldn't create task: ${message}`);
        // Rethrow so the composer keeps the modal open; it owns dismissal on
        // success (via onCancel) so "Create more" can stay open.
        throw err;
      }
    }}
    onCancel={() => (session.ui.taskComposer = null)}
  />
{/if}

{#if designModeScreenshot}
  <DesignAnnotation
    screenshotDataUrl={designModeScreenshot}
    onConfirm={handleDesignConfirm}
    onCancel={handleDesignCancel}
  />
{/if}

{#if isDraggingFile}
  <div data-solus-ui class="drop-overlay">
    <div class="drop-overlay-content">
      <DownloadSimpleIcon size={24} weight="regular" />
      <span>Drop files to attach</span>
    </div>
  </div>
{/if}

<style>
  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--color-zinc-900) 40%, transparent);
    backdrop-filter: blur(0.125rem);
    pointer-events: none;
  }

  .drop-overlay-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    padding: 1.5rem 2.5rem;
    border-radius: 0.75rem;
    border: 0.0938rem dashed var(--color-zinc-600);
    color: var(--color-zinc-400);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  :global(.light) .drop-overlay {
    background: color-mix(in oklab, var(--color-zinc-100) 40%, transparent);
  }

  :global(.light) .drop-overlay-content {
    border-color: var(--color-zinc-400);
    color: var(--color-zinc-500);
  }
</style>
