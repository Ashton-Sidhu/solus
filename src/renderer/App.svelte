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
    FolderOpenIcon,
    BookmarkSimpleIcon,
    BookmarksIcon,
    ListChecksIcon,
    PlugsIcon,
    MagnifyingGlassIcon,
    FileTextIcon,
  } from "phosphor-svelte";
  import ConnectionStatusOverlay from "./components/servers/ConnectionStatusOverlay.svelte";
  import FatalErrorScene from "./components/servers/FatalErrorScene.svelte";
  import { openProjectStore } from "./components/servers/open-project.store.svelte";
  import { hostOnboardingStore } from "./components/servers/host-onboarding.store.svelte";
  import type { HostOption } from "./components/servers/lib/open-project-flow";
  import {
    isRunOnHostLocked,
    moveTabToHost,
  } from "./components/servers/run-on";
  import DesignAnnotation from "./components/artifact/DesignAnnotation.svelte";
  import RenameSessionDialog from "./components/session/RenameSessionDialog.svelte";
  import { Toaster } from "./components/ui/sonner/index.js";
  import * as Tooltip from "./components/ui/tooltip";
  import type { Command } from "./components/command-palette/lib/commands";
  import {
    projectsStore,
    projectCatalog,
    connectionsStore,
    serversStore,
    cloudflareStore,
    parseRoute,
  } from "./contexts";
  import { snapshotPersistedTabs } from "./contexts/workspace/tab-snapshot";
  import {
    withCheckout,
    withHost,
    withProjectHost,
  } from "./contexts/workspace/run-config";
  import { toasts } from "./lib/toasts";
  import { invalidateHomeCache } from "./components/layout/NewTabHome.svelte";
  import { setPopoverLayer } from "./components/popoverLayer.svelte";
  import { projectScopeOf, worktreeProjectRoot } from "../shared/types";
  import type {
    AgentId,
    DesignAnnotation as DesignAnnotationType,
    GitCheckout,
    IpcContext,
    PlanDescriptor,
    ProjectEntry,
    RunConfig,
  } from "../shared/types";
  import type { PullRequestSummary } from "../shared/providers";
  import { setupAgentEvents } from "./hooks/agentEvents.svelte";
  import { materializeTabs } from "./contexts/workspace/session-bootstrap";
  import { LOCAL_SERVER_ID } from "../client-core/server-registry";
  import { serverConnections } from "../client-core/server-connections";
  import { hostPolicy } from "../client-core/host-policy";
  import { unsupportedOnHost } from "../client-core/host-capabilities";
  import { subscribeAllHosts } from "../client-core/host-events";
  import { localApi } from "../client-core/local-api";
  import { notificationsStore } from "./contexts/notifications/notifications.store.svelte";
  import {
    uploadFileObjects,
    uploadLocalAttachments,
  } from "./components/input/lib/attachment-upload";
  import { connectionState } from "../client-core/connection-state";
  import {
    createReconnectDetector,
    initializeRuntime,
    refreshTheme,
  } from "./contexts/app/runtime-boot";
  import {
    savePersistedTabsDebounced,
    flushPersistedTabs,
    savePersistedSessionDraftsDebounced,
    flushPersistedSessionDrafts,
    patchActiveDraft,
    flushDrafts,
    type PersistedTabs,
  } from "./contexts/workspace/tab-persistence";
  import { consumeSessionHandoff } from "./contexts/workspace/active-session-pointer";
  import { createAppCore } from "./contexts/app/app-core";
  import {
    useKeybinding,
    installGlobalDispatcher,
  } from "./lib/keybindings/use-keybinding.svelte";
  import { comboHint, KEYBINDINGS } from "./lib/keybindings/manifest";
  import { defaultCombo, eventMatches } from "./lib/keybindings/match";
  import { requestInputFocus } from "./lib/inputFocus";
  import { requestSavedPrompts } from "./lib/savedPromptsRequest";
  import { dictation, isDictationTarget } from "./lib/dictation.svelte";
  import { branchKeyFor, buildTabSections } from "./lib/sessionUtils";
  import {
    identifyInstallation,
    initAnalytics,
    registerSuperProps,
    track,
  } from "./lib/analytics";

  const TOAST_HOTKEY = ["altKey", "shiftKey", "KeyT"];

  type EditorLayoutModule =
    typeof import("./components/layout/EditorLayout.svelte");
  type EditorLayoutComponent = EditorLayoutModule["default"];
  const commandPaletteModulePromise =
    import("./components/command-palette/CommandPalette.svelte");
  interface Props {
    initialEditorLayout?: EditorLayoutComponent;
  }
  let { initialEditorLayout }: Props = $props();

  const {
    settings,
    windowCtx,
    statusBar,
    planStore,
    sessionEnvironmentStore,
    projectConfigStore,
    voiceModelStore,
    session,
    sessionSidebarStore,
    agent,
    keybindings,
  } = createAppCore();

  function activePrScope() {
    const api = session.apiFor(session.activeTabId);
    return {
      api,
      serverId: serverConnections.serverIdForApi(api),
      ctx: session.ctx,
    };
  }

  // Materialize tabs synchronously during component init — before first paint —
  // so the tab strip, titles, drafts, and active tab (with its loading skeleton)
  // render in the first mounted frame with zero server round trips. The cached
  // start() payload is applied first so persisted tabs can fall back to the last
  // known workspace path. The async runtime attach (createTab/bind/transcript)
  // and fresh start() reconciliation run later from the effect below.
  session.hydrateStaticInfoFromCache();
  materializeTabs(session);

  // Electron-only: analytics is desktop-side. The editor is the sole boot
  // window; the pill is created lazily, so count the open from the editor only.
  initAnalytics({
    enabled: settings.analyticsEnabled,
    platform: "desktop",
    viewMode: windowCtx.viewMode,
  });
  if (windowCtx.viewMode === "editor") track("app_opened", {});

  $effect(() => {
    const installationId = connectionState.target?.installationId;
    const appVersion = session.staticInfo?.version;
    if (!installationId || !appVersion) return;
    identifyInstallation(installationId);
    registerSuperProps({ app_version: appVersion });
  });

  // Persist open-tab snapshot to localStorage so it survives refresh and cold restarts.
  // Reads only the persisted fields, so it won't re-run on message streaming.
  // Skipped while bootstrap is in progress so an empty initial state doesn't clobber saved data.
  $effect(() => {
    if (session.hydrating) return;
    const tabs = snapshotPersistedTabs(session);
    const snapshot: PersistedTabs = {
      version: 2,
      activeTabId: session.activeTabId,
      tabOrder: [...session.tabOrder],
      tabs,
      location: session.router.serialized,
    };
    savePersistedTabsDebounced(snapshot);
  });

  // Drafts persist on their own key: they have no tab to ride, and a prompt the
  // user already wrote must survive a reload. Reading the whole map is cheap —
  // there are only ever as many drafts as open panes.
  $effect(() => {
    if (session.hydrating) return;
    savePersistedSessionDraftsDebounced(session.sessionDraftsSnapshot);
  });

  // Unsent input drafts persist per-keystroke on a debounce. Only reads the active
  // tab's input — other tabs' drafts are patched into the persisted map individually
  // as the user visits each tab, rather than re-reading all N tabs every keystroke.
  $effect(() => {
    if (session.hydrating) return;
    const activeId = session.activeTabId;
    const tabText = session.sessionFor(activeId)?.prompt.text ?? "";
    const activeInputText = session.activeInput.text;
    patchActiveDraft(activeId, tabText, activeInputText);
  });

  // Flush pending drafts + tab snapshot and release renderer-owned audio before
  // unload. A renderer reload keeps Electron's shared audio service alive, so
  // leaving contexts/tracks for Chromium to collect makes mic startup degrade
  // across repeated reloads.
  $effect(() => {
    const flush = () => {
      flushDrafts();
      flushPersistedTabs();
      flushPersistedSessionDrafts();
      projectCatalog.flush();
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      flush();
      // A persisted page may return from the browser back-forward cache with
      // the same module singletons; only permanently discarded renderers should
      // make the recorder unusable.
      if (!event.persisted) dictation.dispose();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      flush();
      window.removeEventListener("pagehide", handlePageHide);
    };
  });

  /** Focus (or attach) the session a pointer/handoff names. Reuses the resume
   *  path, which loads history and splices the live stream if a run is going. */
  function openSessionFromPointer(ptr: {
    sessionId: string;
    serverId: string;
    provider: AgentId;
    cwd: string;
    title: string | null;
  }) {
    // A session already open in this window is just a location — the same
    // `chat/@<sessionId>` route a notification click carries. Only a session
    // this window has never seen needs the handoff's resume metadata, which is
    // why the handoff still carries more than a route. Same-id sessions on two
    // hosts are distinct, so the match requires the handoff's host too.
    const isOpenHere = session.tabOrder.some((id) => {
      const sess = session.sessionFor(id);
      return sess?.agentSessionId === ptr.sessionId && sess.run.serverId === ptr.serverId;
    });
    if (isOpenHere) {
      session.openRoute({ name: "chat", params: { sessionId: ptr.sessionId, serverId: ptr.serverId } });
      return;
    }
    void session.resumeSession({
      provider: ptr.provider,
      sessionId: ptr.sessionId,
      serverId: ptr.serverId,
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
  // Keep the whole refresh outside tracking: the command loader reads more session
  // state synchronously before its first await, but only an agent change belongs here.
  // Explicit refreshes in createTab/setBaseDirectory handle directory changes.
  $effect(() => {
    void settings.activeAgent;
    untrack(() =>
      void session.refreshPluginCommands(session.tabCtx.workingDirectory),
    );
  });

  setupAgentEvents(session);
  // Refresh the key the project panel reads: the worktree path when the tab has one.
  session.onTurnSettled = (sessionId, cwd) => {
    const sess = session.sessions[sessionId];
    const tabId = session.tabIdForSession(sessionId);
    const gitCwd = sess?.run.gitContext?.worktreePath ?? cwd;
    if (!gitCwd || !tabId) return;
    // Tool settles, the Git watcher, and task completion can arrive together.
    // Keep all of them behind the store's two-second freshness window so the
    // final snapshot pipeline does not overlap a redundant status scan. A stale
    // checkout still refreshes immediately.
    void sessionEnvironmentStore.refreshEnvironment(session, {
      sourceId: tabId,
      cwd: gitCwd,
      level: "status",
      force: false,
    });
  };

  // Popovers portal into `overlayEl` via setPopoverLayer; bind it reactively so children see it post-mount.
  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();

  let designModeScreenshot = $state<string | null>(null);
  let designModeTargetTabId = $state<string | undefined>(undefined);
  let directoryPickerOpen = $state(false);
  let directoryPickerNewTab = $state(false);
  let directoryPickerTargetTabId = $state<string | undefined>(undefined);
  /** Set when the browser was opened from a session draft, which has no tab to
   *  retarget — the chosen directory lands on its run config instead. */
  let directoryPickerDraftId = $state<string | undefined>(undefined);
  // Set when a caller names the host to browse — the "Run on" picker and the
  // Open project flow both browse a host no tab points at yet.
  let directoryPickerServerIdOverride = $state<string | undefined>(undefined);
  // Only the Run on picker turns a cross-host folder choice into a mandatory
  // session worktree. Opening a remote project uses the normal preference.
  let directoryPickerIntent = $state<"dispatch" | "open-project">("open-project");
  // "Choose location…" in the Open project flow borrows the same browser; its
  // selection is handed back to that flow instead of retargeting a tab here.
  let directoryPickerForOpenProject = $state(false);
  let shortcutsModalOpen = $state(false);
  let shortcutsActiveScopes = $state<import("./lib/keybindings/types").Scope[]>(
    [],
  );
  let commandPaletteOpen = $state(false);
  let projectSearchOpen = $state(false);
  let hasMountedProjectSearch = $state(false);
  let goToFileOpen = $state(false);
  let hasMountedGoToFile = $state(false);
  let paletteGitTarget = $state<{
    tabId: string;
    ctx: IpcContext;
    projectRoot: string | null;
  } | null>(null);
  let hasMountedDirectoryPicker = $state(false);
  let hasMountedShortcuts = $state(false);
  // The command palette is keyboard-critical and cheap while hidden. Mount it
  // with the app so the first shortcut never pays component setup work.
  let hasMountedCommandPalette = $state(true);
  let hasMountedAddServer = $state(false);
  let hasMountedOpenProject = $state(false);
  let hasMountedHostOnboarding = $state(false);
  /** Offered as the prefill when a remote host has no commit identity of its own. */
  let localGitIdentity = $state<{ name: string; email: string } | null>(null);
  // When set, the palette opens drilled straight into this sub-page (e.g. the
  // "Review a PR" git action reuses the "Review PR…" page). Cleared once consumed.
  let paletteInitialPage = $state<{ id: string; title: string } | null>(null);
  // The standalone create-task composer (project cwd + optional session seed)
  // lives on the UI store so the palette, the action orb, and create-from-session
  // can all open it. Saves straight through to the provider.
  const taskComposer = $derived(session.ui.taskComposer);
  const sessionRename = $derived(session.ui.sessionRename);
  const taskComposerServerId = $derived(
    taskComposer
      ? (session.tasksStore.hostForProject(taskComposer.projectKey) ??
        serverConnections.defaultServerId())
      : null,
  );
  const taskComposerHost = $derived(
    taskComposerServerId
      ? {
          serverId: taskComposerServerId,
          api: serverConnections.apiFor(taskComposerServerId),
        }
      : null,
  );
  const taskComposerConfig = $derived(
    taskComposer
      ? projectConfigStore.configFor(
          taskComposerServerId,
          taskComposer.projectKey,
        )
      : undefined,
  );
  const taskComposerProvider = $derived(
    taskComposerConfig?.taskProvider ?? "local",
  );
  const taskComposerTasks = $derived(
    taskComposer
      ? session.tasksStore.tasksForProject(taskComposer.projectKey)
      : [],
  );
  const taskComposerEpics = $derived(
    taskComposerTasks.filter((t) => t.kind === "epic"),
  );
  const taskComposerLabels = $derived(
    Array.from(new Set(taskComposerTasks.flatMap((t) => t.labels))).sort(),
  );

  $effect(() => {
    if (!taskComposer || !taskComposerHost) return;
    void projectConfigStore.load(taskComposerHost, taskComposer.projectKey);
  });

  const isExpanded = $derived(session.isExpanded);
  // Each Electron window is mode-locked (`?mode=` in its URL), so exactly one
  // layout mounts for the window's lifetime — no dual trees, no display:none
  // toggling. Switching modes surfaces the other OS window via switchMode.
  const viewMode = $derived(windowCtx.viewMode);
  const isEditorMode = $derived(viewMode === "editor");
  let documentVisible = $state(document.visibilityState !== "hidden");
  $effect(() => {
    const update = () => (documentVisible = document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  });
  const editorSurfaceActive = $derived(isEditorMode && documentVisible);
  const pillSurfaceActive = $derived(!isEditorMode && documentVisible);
  type PillLayoutModule =
    typeof import("./components/layout/PillLayout.svelte");
  const initialViewMode = untrack(() => windowCtx.viewMode);
  let editorLayoutComponent = $state.raw<Promise<EditorLayoutModule> | null>(
    initialViewMode === "editor" && !untrack(() => initialEditorLayout)
      ? import("./components/layout/EditorLayout.svelte")
      : null,
  );
  let pillLayoutComponent = $state.raw<Promise<PillLayoutModule> | null>(
    initialViewMode === "pill"
      ? import("./components/layout/PillLayout.svelte")
      : null,
  );

  // Electron windows stay in one fixed mode and therefore load one layout.
  // Web viewMode follows a media query, so lazily mount the other layout on its
  // first use and then only hide/show; never destroy either initialized tree.
  $effect(() => {
    if (isEditorMode) {
      editorLayoutComponent ??=
        import("./components/layout/EditorLayout.svelte");
    } else {
      pillLayoutComponent ??= import("./components/layout/PillLayout.svelte");
    }
  });

  // These components previously stayed mounted and managed their own open
  // guards. Keep that lifetime after the first lazy load so local draft/focus
  // state is not reset on every close.
  $effect(() => {
    if (directoryPickerOpen) hasMountedDirectoryPicker = true;
    if (shortcutsModalOpen) hasMountedShortcuts = true;
    if (commandPaletteOpen) hasMountedCommandPalette = true;
    if (projectSearchOpen) hasMountedProjectSearch = true;
    if (goToFileOpen) hasMountedGoToFile = true;
    if (serversStore.addServerOpen) hasMountedAddServer = true;
    if (openProjectStore.isOpen) hasMountedOpenProject = true;
    if (hostOnboardingStore.isOpen) hasMountedHostOnboarding = true;
  });

  // Warm the components a keystroke can summon, so the first ⌘K / Open project
  // only opens them. Mounting is what pulls the lazy chunk in; doing it on the
  // click meant paying a fetch-and-parse behind a "Loading…" placeholder every
  // first time. Their data stays deferred until the store actually opens.
  $effect(() => {
    if (hasMountedCommandPalette && hasMountedOpenProject && hasMountedDirectoryPicker) return;
    const warm = () => {
      hasMountedCommandPalette = true;
      hasMountedOpenProject = true;
      // Home hands straight off to the picker, so it is on the same hot path.
      hasMountedDirectoryPicker = true;
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(warm, { timeout: 1_500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(warm, 250);
    return () => window.clearTimeout(timeoutId);
  });

  // A bare host has no commit identity; this machine's is the obvious prefill,
  // so read it once from the local host rather than from the one being set up.
  $effect(() => {
    if (!openProjectStore.isOpen || localGitIdentity) return;
    void serverConnections
      .localHostApi()
      ?.setupHostReadiness()
      .then((readiness) => (localGitIdentity = readiness.git.identity))
      .catch(() => {});
  });
  const activeTabId = $derived(session.activeTabId);
  const keyboardTabId = $derived(session.focusedChatTabId ?? activeTabId);
  const desktopHandlersAvailable = $derived(
    connectionsStore.desktopHandlersAvailable,
  );
  const directoryPickerCreatesTab = $derived(
    directoryPickerNewTab ||
      (!directoryPickerTargetTabId && !!session.activeSession?.agentSessionId),
  );
  // Borrowed by the Open project flow, where the folder being chosen is a place
  // to put a clone rather than a project to open — so it gets its own wording.
  const directoryPickerTitle = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local"
        ? "Open a folder"
        : "Choose where to clone";
    }
    return directoryPickerCreatesTab
      ? "Open project in a new tab"
      : "Change project folder";
  });
  const directoryPickerAction = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local" ? "Open" : "Clone here";
    }
    return directoryPickerCreatesTab ? "Open in new tab" : "Choose";
  });
  // Browse the host the tab actually runs on — a new tab inherits the active
  // session's host, so both flows resolve to the same place the commit lands.
  // An explicit override wins: it names a host before any tab points at it.
  const directoryPickerServerId = $derived(
    directoryPickerServerIdOverride ??
      (directoryPickerTargetTabId
        ? session.sessionFor(directoryPickerTargetTabId)?.run.serverId
        : session.activeSession?.run.serverId) ??
      serverConnections.defaultServerId() ??
      LOCAL_SERVER_ID,
  );
  // apiFor() opens the connection as a side effect, so only reach for the
  // chosen host's api while the picker is actually on screen.
  const directoryPickerApi = $derived(
    directoryPickerOpen
      ? serverConnections.apiFor(directoryPickerServerId)
      : serverConnections.apiFor(
          serverConnections.defaultServerId() ?? LOCAL_SERVER_ID,
        ),
  );
  const directoryPickerHostLabel = $derived(
    directoryPickerServerId === serversStore.activeServerId
      ? undefined
      : serversStore.servers.find((s) => s.id === directoryPickerServerId)?.label,
  );
  // Changing an existing tab's folder starts where that tab already is. Every
  // other entry point lets the picker resolve the selected host's projects root.
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = directoryPickerTargetTabId
      ? session.sessionFor(directoryPickerTargetTabId)
      : null;
    if (targetSession?.run.serverId === directoryPickerServerId) {
      return targetSession.run.workingDirectory;
    }
    return undefined;
  });

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

  $effect(() => {
    refreshTheme(settings.setSystemTheme.bind(settings));
    const unsub = window.solusNative.onThemeChange((isDark: boolean) =>
      settings.setSystemTheme(isDark),
    );
    return unsub;
  });

  $effect(() => {
    initializeRuntime(session, sessionSidebarStore);
  });

  const detectReconnect = createReconnectDetector(
    serversStore.connectionStatus,
  );
  $effect(() => {
    const connectionStatus = serversStore.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    if (connectionStatus === "connected") {
      const defaultServerId = serverConnections.defaultServerId();
      if (defaultServerId) {
        void connectionsStore.refreshCapabilities({ serverId: defaultServerId });
      }
    }
    if (reconnected) {
      refreshTheme(settings.setSystemTheme.bind(settings));
      initializeRuntime(session, sessionSidebarStore);
      const scope = activePrScope();
      session.prsStore.reportChecksActivity(scope.api, scope.ctx);
    }
  });

  $effect(() => {
    // Click-through only applies to the pill window's transparent canvas; the
    // editor is an opaque, normal OS window.
    if (isEditorMode) return;
    if (!localApi.setIgnoreMouseEvents) return;
    let lastIgnored: boolean = true;
    localApi.setIgnoreMouseEvents(true, { forward: true });

    const setIgnore = (shouldIgnore: boolean) => {
      if (shouldIgnore === lastIgnored) return;
      lastIgnored = shouldIgnore;
      if (shouldIgnore)
        localApi.setIgnoreMouseEvents(true, { forward: true });
      else localApi.setIgnoreMouseEvents(false, { focus: true });
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
    const unsubShown = window.solusNative.onWindowShown((pos) => {
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

  // A notification click (or any other outside-the-renderer request) arrives as
  // a serialized route, which is the same vocabulary the address bar, the
  // persisted snapshot, and agent links use.
  $effect(() => {
    const unsubscribe = window.solusNative?.onOpenRoute?.((serialized) => {
      const route = parseRoute(serialized);
      if (route) session.openRoute(route);
    });
    return () => unsubscribe?.();
  });

  $effect(() => {
    if (!settings.soundEnabled) {
      notificationsStore.stop();
      return;
    }
    return untrack(() => notificationsStore.start({
      hostDisplay: (serverId) => {
        const host = serversStore.hostFor(serverId);
        const display: import("./contexts/notifications/notifications.store.svelte").NotificationHostDisplay = {
          label: host?.label ?? "this host",
          isPrimary: serverConnections.defaultServerId() === serverId,
        };
        if (host && "installationId" in host && host.installationId) {
          display.installationId = host.installationId;
        }
        return display;
      },
      isSessionFocused: (serverId, sessionId) =>
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        session.isSessionVisibleOnHost(serverId, sessionId),
      openRoute: (serialized) => {
        const route = parseRoute(serialized);
        if (route) session.openRoute(route);
      },
    }));
  });

  // These are lifetime subscriptions. Some installers read active-session state
  // for their first report, but session changes must not reinstall every listener.
  $effect(() =>
    untrack(() => {
      const unsubVoiceModel = subscribeAllHosts('voice.modelStatusChanged', (serverId, status) =>
        voiceModelStore.apply(status, serverId),
      );
      const unsubSessionStatuses = sessionSidebarStore.subscribeSessionStatuses();
      const unsubPrLifecycle = sessionSidebarStore.subscribePrLifecycle();
      const defaultServerId = serverConnections.defaultServerId();
      if (defaultServerId) void voiceModelStore.refresh(defaultServerId);
      const unsubUsage = subscribeAllHosts('usage.limitsChanged', (_serverId, { snapshots }) =>
        agent.applyUsage(snapshots),
      );
      void agent.refreshUsage();
      // Live automation state: scheduler fires, run transitions, and agent-tool
      // saves all land here. Failures get a toast — an unattended run breaking
      // is otherwise invisible until the user happens to open the page.
      const unsubAutomations = subscribeAllHosts('automation.changed', (serverId, event) => {
        session.automationsStore.applyChange(serverId, event);
        if (event.kind === "run-finished" && event.run.status === "failed") {
          toasts.error(`Automation "${event.automation.name}" failed`, {
            action: {
              label: "View",
              onAction: () => session.openAutomations(event.automation.id),
            },
          });
        }
      });
      // An agent left comment threads on a plan or a work. Re-read that target's
      // annotations so the rail updates under the reader, rather than making them
      // close and reopen the document to see the review.
      const unsubAnnotations = subscribeAllHosts('annotations.changed', (serverId, change) => {
        if (change.kind === "work") void session.worksStore.loadAnnotations(change.targetId, serverId);
        else void session.planStore.hydrateAnnotations(change.targetId, serverId);
      });
      const unsubStackGraph = session.stacksStore.subscribe();
      const unsubChecks = session.prsStore.subscribeChecks(activePrScope);
      const unsubGuideStatus = session.prsStore.subscribeGuideStatus();
      const unsubPrLifecycleChanges = session.prsStore.subscribeLifecycleChanges();
      const unsubNeedsReview = session.prsStore.subscribeNeedsReview(
        activePrScope,
      );
      // An agent can need the Cloudflare profile before any Cloudflare surface has
      // been opened, so the request has to be heard app-wide, not by the card.
      const unsubCloudflare = cloudflareStore.listenForConnectRequests();
      const unsubShown = window.solusNative.onWindowShown(() => {
        const active = session.sessionFor(session.activeTabId);
        const cwd =
          active?.run.gitContext?.worktreePath ??
          active?.run.workingDirectory ??
          session.globalDefaults.workingDirectory;
        if (cwd)
          void sessionEnvironmentStore.refreshEnvironment(session, {
            sourceId: session.activeTabId,
            cwd,
            level: "status",
          });
      });
      return () => {
        unsubVoiceModel();
        unsubSessionStatuses();
        unsubPrLifecycle();
        unsubUsage();
        unsubAutomations();
        unsubAnnotations();
        unsubStackGraph();
        unsubChecks();
        unsubGuideStatus();
        unsubPrLifecycleChanges();
        unsubNeedsReview();
        unsubCloudflare();
        unsubShown();
      };
    }),
  );

  $effect(() => {
    void session.activeTabId;
    const reviewSurfaceOpen =
      session.router.at("prs") ||
      session.router.at("reviewMode") ||
      !!session.activeSession?.prReview;
    untrack(() =>
      {
        const scope = activePrScope();
        session.prsStore.setChecksReviewSurface(reviewSurfaceOpen, scope.api, scope.ctx);
      },
    );
  });

  // The needs-review count answers "in this project", so crossing into another
  // one makes the count the sidebar is showing not just stale but wrong — the
  // store zeroes it rather than report another project's number. Fetch the new
  // project now; leaving it to the poll blanks the badge for up to a cycle.
  const needsReviewProjectKey = $derived(
    projectScopeOf(session.ctx.session),
  );
  $effect(() => {
    void needsReviewProjectKey;
    untrack(() =>
      {
        const scope = activePrScope();
        void session.prsStore
          .refreshNeedsReview(scope.api, scope.serverId, scope.ctx)
          .catch(() => {});
      },
    );
  });

  // Keep main informed of whether the live text selection sits inside the
  // conversation view, so its native right-click menu can offer "Quote in
  // reply" only there. Pushed ahead of the click (on selectionchange) so main
  // already has the answer when the context menu fires — no IPC race.
  $effect(() => {
    let lastSourceTabId: string | null = null;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      let sourceTabId: string | null = null;
      // Bail before the O(selection) toString() on the common continuous-drag
      // path where there's no real selection (collapsed caret / no range).
      if (
        sel &&
        !sel.isCollapsed &&
        sel.rangeCount > 0 &&
        sel.toString().trim()
      ) {
        const node = sel.getRangeAt(0).commonAncestorContainer;
        const el = node instanceof Element ? node : node.parentElement;
        const conversation = el?.closest<HTMLElement>(
          ".conversation-selectable",
        );
        sourceTabId = conversation?.dataset.conversationTabId ?? null;
      }
      if (sourceTabId !== lastSourceTabId) {
        lastSourceTabId = sourceTabId;
        localApi.setQuoteContext(sourceTabId);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      localApi.setQuoteContext(null);
    };
  });

  $effect(() =>
    localApi.onAskSelectionInNewSession((text, sourceTabId) => {
      void session
        .askInNewSession(sourceTabId, text)
        .catch(() => toasts.error("Couldn't start a new session"));
    }),
  );

  // Mount global scope and the single dispatcher listener (shared with web).
  installGlobalDispatcher(keybindings, () => settings.keybindings);
  $effect(() => {
    // Pre-listener for the voice shortcut: always claims the combo so the OS
    // never sees it
    // (exclusive scopes in DocumentShell block the normal dispatcher for global
    // bindings, which would otherwise let macOS insert the  character).
    // Handles dictation into focused plain inputs. Non-dictation cases (e.g.
    // the chat composer) are handled by InputBar's own keybinding handler,
    // which the dispatcher still reaches when no exclusive scope is active.
    //
    // Runs in the capture phase so it fires before any subtree keydown handler
    // (e.g. the diff panel's tree/diff widgets) can stopPropagation and swallow
    // the combo — without this, dictation does nothing while focused in a panel.
    const handleVoiceKey = (e: KeyboardEvent) => {
      const combo =
        settings.keybindings["voice.toggle-recorder"] ??
        defaultCombo(KEYBINDINGS["voice.toggle-recorder"]);
      if (e.repeat || !eventMatches(e, combo)) return;
      e.preventDefault();
      const el = document.activeElement;
      if (isDictationTarget(el)) dictation.toggleInto(el);
    };
    document.addEventListener("keydown", handleVoiceKey, true);
    return () => document.removeEventListener("keydown", handleVoiceKey, true);
  });

  // ── Global keybinding handlers ────────────────────────────────────────────
  useKeybinding("global.open-host-project", () => {
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: {
          tabId: session.focusedChatTabId ?? undefined,
          serverId: serversStore.activeServerId,
        },
      }),
    );
  });
  useKeybinding("global.select-project", () => {
    startOpenProject({ tabId: session.focusedChatTabId ?? undefined });
  });
  useKeybinding("global.new-task", () => {
    session.openSessionDraft({ freshTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session-without-task", () => {
    session.openSessionDraft({ withoutTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session", () => {
    session.openSessionDraft({ via: "keybinding" });
  });

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
    session.selectTab(target, "keybinding");
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
      session.selectTab(order[(idx + 1) % order.length], "keybinding");
      requestInputFocus();
    }
  });
  useKeybinding("global.prev-session", () => {
    if (!isEditorMode) return navigateTab(-1);
    const order = scopedSessionTabOrder();
    const idx = order.indexOf(activeTabId);
    if (idx !== -1) {
      session.selectTab(order[(idx - 1 + order.length) % order.length], "keybinding");
      requestInputFocus();
    }
  });
  useKeybinding("global.screenshot", () => handleScreenshot(keyboardTabId), {
    enabled: () => desktopHandlersAvailable,
  });
  useKeybinding("global.continue-in-mode", () => session.continueInOtherMode());
  useKeybinding("global.session-picker", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.session-picker-j", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.task-picker", () => {
    session.sessionPickerOpen = false;
    session.taskPickerOpen = !session.taskPickerOpen;
  });
  useKeybinding("global.toggle-expanded", () => session.toggleExpanded(), {
    enabled: () => viewMode === "pill",
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) session.closeTab(activeTabId, "keybinding");
  });
  useKeybinding("global.group-tabs", () => {
    session.toggleTabGroupMode("keybinding");
  });
  useKeybinding("global.attach-file", () => handleAttachFile(keyboardTabId));
  useKeybinding(
    "global.design-mode",
    () => {
      const targetStatus = session.sessionFor(keyboardTabId)?.status;
      if (
        targetStatus !== "running" &&
        targetStatus !== "connecting" &&
        desktopHandlersAvailable
      )
        handleDesignMode(keyboardTabId);
    },
    {
      enabled: () => desktopHandlersAvailable,
    },
  );
  useKeybinding("global.toggle-reasoning", () => {
    const targetStatus = session.sessionFor(keyboardTabId)?.status;
    if (targetStatus === "running" || targetStatus === "connecting") return;
    window.dispatchEvent(
      new CustomEvent("solus:toggle-session-settings-picker", {
        detail: { tabId: keyboardTabId },
      }),
    );
  });
  useKeybinding(
    "global.toggle-diff-panel",
    () =>
      window.dispatchEvent(
        new CustomEvent("solus:toggle-diff-panel", {
          detail: { tabId: keyboardTabId },
        }),
      ),
    {
      enabled: () => viewMode === "editor",
    },
  );
  useKeybinding("global.toggle-workspace", () => session.toggleFolio("keybinding"));
  useKeybinding("global.toggle-automations", () => session.toggleAutomations("keybinding"));
  useKeybinding("global.toggle-tasks", () => session.toggleTasks("keybinding"));
  useKeybinding("global.settings", () => session.showSettings("general", "keybinding"));
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.history-back", () => session.router.back());
  useKeybinding("global.history-forward", () => session.router.forward());
  useKeybinding("global.toggle-worktree", () =>
    session.toggleWorktreeMode(session.focusedChatTabId ?? undefined, "keybinding"),
  );
  useKeybinding("global.switch-worktree", () => {
    const hasAgent = !!session.sessionFor(activeTabId)?.agentSessionId;
    if (hasAgent) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding(
    "global.git-open-terminal",
    () => {
      void session.apiForContext(session.ctx).openWorktreeTerminal(session.ctx);
    },
    { enabled: () => desktopHandlersAvailable && session.activeSession?.run.serverId === LOCAL_SERVER_ID },
  );
  useKeybinding("global.show-shortcuts", () => {
    shortcutsActiveScopes = keybindings.activeScopes();
    shortcutsModalOpen = true;
  });
  // Desktop-only: on web the browser owns these combos (and its own zoom), so
  // the disabled registration lets the events fall through untouched.
  const zoomAvailable = localApi.setZoomFactor !== undefined;
  const showZoomToast = () => {
    toasts.info(`Zoom ${Math.round(settings.zoomFactor * 100)}%`, { id: "ui-zoom" });
  };
  useKeybinding(
    "global.zoom-in",
    () => {
      settings.zoomIn();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.zoom-out",
    () => {
      settings.zoomOut();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.zoom-reset",
    () => {
      settings.resetZoom();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.command-palette",
    () => {
      paletteGitTarget = null;
      commandPaletteOpen = true;
    },
    {
      enabled: () => viewMode === "editor",
    },
  );
  // Both need a project to search, and the pill has nowhere to show results.
  const canSearchProject = $derived(
    viewMode === "editor" && !!sessionEnvironmentStore.environmentFor(session.sessionFor(keyboardTabId)?.run).cwd,
  );
  useKeybinding("global.project-search", () => (projectSearchOpen = true), {
    enabled: () => canSearchProject,
  });
  useKeybinding("global.go-to-file", () => (goToFileOpen = true), {
    enabled: () => canSearchProject,
  });

  // ── Actions that ship without a shortcut ───────────────────────────────────
  // Each is otherwise pointer- or palette-only. They register the same way as
  // everything above; the manifest simply gives them no default combo, so the
  // handler waits until a user assigns one in Settings → Keybindings.

  /** Open the palette drilled straight into one parent command's sub-page. */
  function openPalettePage(id: string, title: string) {
    paletteGitTarget = null;
    paletteInitialPage = { id, title };
    commandPaletteOpen = true;
  }

  const paletteAvailable = $derived(viewMode === "editor");
  // The git sub-pages only exist while a session sits in a repository, matching
  // the condition that builds those commands.
  const hasGitContext = $derived(
    !!(session.activeSession?.run.gitContext ?? session.globalDefaults.gitContext),
  );

  useKeybinding(
    "global.switch-branch",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:toggle-git-dropdown", {
          detail: { view: "branches" },
        }),
      );
    },
    { enabled: () => hasGitContext },
  );
  useKeybinding("global.new-session-worktree", () => void session.createWorktreeTab(), {
    enabled: () => hasGitContext,
  });
  useKeybinding(
    "global.new-session-in",
    () => openPalettePage("new-session-in", "New session in"),
    { enabled: () => paletteAvailable && hasGitContext },
  );
  useKeybinding(
    "global.working-tree-diff",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:toggle-diff-panel", {
          detail: { scope: { kind: "working-tree" }, switchScope: true },
        }),
      );
    },
    // Same gate as the diff-panel toggle: the pill has nowhere to show a diff.
    { enabled: () => viewMode === "editor" },
  );
  useKeybinding("global.open-prs", () => session.openPrs(null, "keybinding"));
  useKeybinding(
    "global.review-pr",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:review-pr", { detail: { tabId: keyboardTabId } }),
      );
    },
    { enabled: () => paletteAvailable && hasGitContext },
  );
  useKeybinding("global.open-plan", () => openPalettePage("open-plan", "Open plan"), {
    enabled: () => paletteAvailable,
  });
  useKeybinding("global.open-document", () => openPalettePage("open-work", "Open document"), {
    enabled: () => paletteAvailable,
  });
  useKeybinding(
    "global.open-automation",
    () => openPalettePage("open-automation", "Open automation"),
    { enabled: () => paletteAvailable },
  );
  useKeybinding("global.open-task", () => openPalettePage("go-to-task", "Open task"), {
    // The sub-page is only built for the project the tasks store is scoped to.
    enabled: () => paletteAvailable && !!session.tasksProjectCwd,
  });
  useKeybinding(
    "global.create-task-in",
    () => openPalettePage("create-task-in", "Create task in"),
    { enabled: () => paletteAvailable },
  );
  useKeybinding("global.permission-menu", () => {
    window.dispatchEvent(
      new CustomEvent("solus:toggle-permission-menu", {
        detail: { tabId: keyboardTabId },
      }),
    );
  });
  useKeybinding("global.add-server", () => serversStore.openAddServer());
  useKeybinding("global.switch-server", () => openPalettePage("switch-server", "Switch server"), {
    enabled: () => paletteAvailable,
  });
  useKeybinding("global.find-hosts", () => {
    session.showSettings("api-access", "keybinding");
    void serversStore.scanForServers();
  });

  const paletteGitProjectRoot = $derived.by(() => {
    if (paletteGitTarget) return paletteGitTarget.projectRoot;
    const dir =
      session.activeSession?.run.gitContext?.repoRoot ??
      session.activeSession?.run.workingDirectory;
    return dir && dir !== "~" ? worktreeProjectRoot(dir) : null;
  });
  const paletteGitRefs = $derived(
    sessionEnvironmentStore.refsFor(paletteGitProjectRoot),
  );
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
    void sessionEnvironmentStore.refreshRefs(
      projectRoot,
      untrack(() => session.ctxForDirectory(projectRoot)),
      { force: true },
    );
    const context = untrack(() => paletteGitTarget?.ctx ?? session.ctx);
    const api = session.apiForContext(context);
    session.prsStore
      .loadFor(
        api,
        serverConnections.serverIdForApi(api),
        context,
        { state: "open" },
      )
      .then((result) => {
        palettePrs = result.items;
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
    const taskCwd = session.tasksProjectCwd;
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
    if (taskCwd) void session.tasksStore.ensureLoaded();
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
      id: "open-project",
      label: "Open project…",
      group: "General",
      icon: FolderOpenIcon,
      hint: comboHint("global.select-project"),
      keywords: [
        "new project",
        "clone",
        "repository",
        "git",
        "github",
        "folder",
        "directory",
        "host",
        "machine",
      ],
      run: () => startOpenProject({ tabId: activeTabId }),
    },
    {
      id: "go-to-file",
      label: "Go to file",
      group: "General",
      icon: FileTextIcon,
      hint: comboHint("global.go-to-file"),
      keywords: ["file", "open", "quick open", "goto", "find file"],
      run: () => (goToFileOpen = true),
    },
    {
      id: "project-search",
      label: "Search in project",
      group: "General",
      icon: MagnifyingGlassIcon,
      hint: comboHint("global.project-search"),
      keywords: ["find", "grep", "search", "contents", "text", "in files"],
      run: () => (projectSearchOpen = true),
    },
    {
      id: "new-task",
      label: "New task",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-task"),
      keywords: ["create", "task"],
      run: () => session.openSessionDraft({ freshTask: true, via: "palette" }),
    },
    {
      id: "new-tab",
      label: "New session",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-session"),
      keywords: ["create", "session", "tab"],
      run: () => session.openSessionDraft({ via: "palette" }),
    },
    {
      id: "new-session-without-task",
      label: "New session without task",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-session-without-task"),
      keywords: ["create", "session", "tab", "no task"],
      run: () => session.openSessionDraft({ withoutTask: true, via: "palette" }),
    },
    {
      id: "save-prompt",
      label: "Save prompt",
      group: "Compose",
      icon: BookmarkSimpleIcon,
      hint: comboHint("global.save-prompt"),
      keywords: ["stash", "draft", "park", "later", "composer"],
      run: () => requestSavedPrompts({ action: "save" }),
    },
    {
      id: "saved-prompts",
      label: "Saved prompts…",
      group: "Compose",
      icon: BookmarksIcon,
      hint: comboHint("global.saved-prompts"),
      keywords: ["stash", "draft", "park", "restore", "composer"],
      run: () => requestSavedPrompts({ action: "open" }),
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
      run: () => session.showSettings("general", "palette"),
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
    {
      id: "find-hosts",
      label: "Find hosts nearby",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["discover", "scan", "lan", "tailscale", "nearby"],
      // Settings → Connections owns the fuller version of this: a scan button,
      // last-seen times and connect. The switcher chip it used to open is not
      // rendered in editor mode at all.
      run: () => {
        session.showSettings("api-access", "palette");
        void serversStore.scanForServers();
      },
    },
  ];

  async function switchPaletteBranch(branch: string): Promise<boolean> {
    const projectRoot = paletteGitProjectRoot;
    if (projectRoot) {
      const ctx = session.ctxForDirectory(projectRoot);
      const refsReady = await sessionEnvironmentStore.refreshRefs(
        projectRoot,
        ctx,
        { force: true },
      );
      if (!refsReady) toasts.error("Couldn't refresh branches");
      const worktree = sessionEnvironmentStore
        .refsFor(projectRoot)
        .worktrees.find((wt) => wt.branch === branch);
      if (worktree) {
        await session.switchToWorktree(worktree.path, undefined, "palette");
        const nextCwd =
          session.activeSession?.run.gitContext?.worktreePath ??
          session.activeSession?.run.workingDirectory;
        if (nextCwd)
          void sessionEnvironmentStore.refresh(nextCwd, { force: true });
        requestInputFocus();
        return true;
      }
    }

    const ok = await session.switchToBranch(branch, undefined, "palette");
    const nextCwd =
      session.activeSession?.run.gitContext?.worktreePath ??
      session.activeSession?.run.workingDirectory;
    if (ok && nextCwd)
      void sessionEnvironmentStore.refresh(nextCwd, { force: true });
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

    const switchServerChildren: Command[] = serversStore.servers.map(
      (server) => ({
        id: `switch-server:${server.id}`,
        label: server.label,
        group: "Servers",
        icon: PlugsIcon,
        hint: server.id === serversStore.activeServerId ? "Active" : undefined,
        keywords: [
          "server",
          "remote",
          "connect",
          server.url,
          server.installationId ?? "",
        ],
        run: () => serversStore.switchTo(server.id),
      }),
    );
    commands.push({
      id: "switch-server",
      label: "Switch server…",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["server", "remote", "connect", "host", "machine"],
      children: switchServerChildren,
    });

    for (const host of serversStore.nearbyHosts) {
      commands.push({
        id: `connect-host:${host.server.installationId}`,
        label: `Connect to ${host.server.name}`,
        group: "Servers",
        icon: PlugsIcon,
        keywords: [
          "server",
          "connect",
          `${host.server.host}:${host.server.port}`,
          host.server.source,
        ],
        run: () => hostOnboardingStore.openForDiscovered(host.server),
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
      run: () => void session.openPlanFromDescriptor(d, "palette"),
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
          session.worksStore.pendingWorkDelete?.id !== w.id,
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((w) => ({
        id: `work:${w.id}`,
        label: w.title,
        group: "Documents",
        icon: FoldersIcon,
        keywords: [w.title],
        run: () => void session.openWorkModal(w.id, w.title, { via: "palette" }),
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
        run: () => session.openAutomations(a.id, "palette"),
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
      const taskProjectName =
        taskCwd.split("/").filter(Boolean).pop() ?? taskCwd;
      commands.push({
        id: "create-task",
        label: `Create task in ${taskProjectName}`,
        group: "Tasks",
        icon: CheckSquareIcon,
        keywords: ["task", "create", "new", "todo", "issue", taskProjectName],
        run: () => session.openTaskComposer(taskCwd, true),
      });
    }
    const createTaskInChildren: Command[] = paletteProjects.map((p) => ({
      id: `create-task-in:${p.path}`,
      label:
        p.folderName || (p.path.split("/").filter(Boolean).pop() ?? p.path),
      group: "Projects",
      icon: FolderIcon,
      keywords: [p.folderName, p.path],
      run: () => session.openTaskComposer(p.path),
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
    const tasksLoadedForProject = !!taskCwd && session.tasksStore.loaded;
    const goToTaskChildren: Command[] = tasksLoadedForProject
      ? session.tasksStore.tasksForProject(taskCwd).map((t) => ({
          id: `go-to-task:${t.id}`,
          label: t.title,
          group: "Tasks",
          icon: ListChecksIcon,
          hint: t.kind === "epic" ? "Epic" : undefined,
          keywords: ["task", t.id, t.assignee ?? "", ...t.labels],
          run: () => session.goToTask(t.id),
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
      run: () => session.openPrs(null, "palette"),
    });

    const gitCtx =
      session.activeSession?.run.gitContext ?? session.globalDefaults.gitContext;
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
            run: () => void session.switchToWorktree(wt.path, undefined, "palette"),
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
            // The draft starts in the worktree; its environment refresh resolves
            // the checkout from that directory, same as picking a project does.
            session.openSessionDraft({ via: "palette" }, wt.path);
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
          // The checkout is a real change on disk, so it happens either way;
          // `switchToBranch` then opens a draft there rather than moving a
          // conversation already under way.
          run: () => void switchPaletteBranch(branch),
        }));
      const newSessionInChildren: Command[] = [
        ...newSessionBranchChildren,
        ...existingWorktreeChildren,
      ];
      const activeSess = session.activeSession;
      const canContinueWorktree =
        !!activeSess?.agentSessionId && !activeSess.run.gitContext?.worktreePath;
      const worktreeCommands: Command[] = [
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
          keywords: [
            "session",
            "branch",
            "worktree",
            "checkout",
            "switch",
            "remote",
            "existing",
            "open",
            "pick",
          ],
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
            keywords: [
              "pr",
              "pull request",
              "review",
              String(pr.number),
              pr.author,
            ],
            run: () =>
              void session.enterPrReview(pr.number, pr.title, {
                ctx: paletteGitTarget?.ctx,
                via: "palette",
              }),
          })),
        },
      ];
      if (canContinueWorktree) {
        worktreeCommands.unshift({
          id: "continue-in-worktree",
          label: "Continue in worktree",
          group: "General",
          icon: TreeStructureIcon,
          keywords: ["worktree", "continue", "move", "branch", "isolated", "fork"],
          hint: comboHint("global.continue-worktree"),
          run: () => void session.continueInWorktree(activeTabId, "palette"),
        });
      }
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
    if (!isEditorMode && !isExpanded && session.router.at("plan")) {
      session.closePlanModal();
    }
  });

  async function handleScreenshot(tabId?: string) {
    if (!desktopHandlersAvailable) return;
    const result = await serverConnections.localHostApi()?.takeScreenshot();
    if (!result) return;
    session.addAttachments([result], tabId);
  }

  async function handleAttachFile(tabId?: string) {
    const targetTabId = tabId ?? session.focusedChatTabId ?? session.activeTabId;
    const run = targetTabId ? session.runFor(targetTabId) : session.activeSession?.run;
    const serverId =
      run?.serverId ?? serverConnections.defaultServerId() ?? LOCAL_SERVER_ID;
    const ctx = targetTabId ? session.ctxFor(targetTabId) : session.ctx;
    const targetApi = serverConnections.apiFor(serverId);
    try {
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        const hostLabel =
          serversStore.hostFor(serverId)?.label ??
          serverConnections.connectionFor(serverId)?.target.label ??
          "this host";
        toasts.info(unsupportedOnHost("File attachments", hostLabel));
        return;
      }
      if (hostPolicy.isClientMachine(serverId)) {
        const files = await targetApi.attachFiles(ctx);
        if (files?.length) session.addAttachments(files, targetTabId);
        return;
      }
      const localFiles = await serverConnections.localHostApi()?.attachFiles(ctx);
      if (!localFiles?.length) return;
      const uploaded = await uploadLocalAttachments(
        targetApi,
        ctx,
        serverId,
        localFiles,
        (path, mime) => localApi.readAttachmentBytes(path, mime),
      );
      session.addAttachments(uploaded, targetTabId);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Couldn't attach files");
    }
  }

  async function handleDesignMode(tabId?: string) {
    if (!desktopHandlersAvailable) return;
    designModeTargetTabId = tabId;
    const result = await serverConnections.localHostApi()?.enterDesignMode();
    if (!result) {
      designModeTargetTabId = undefined;
      // Capture failed: tell main to restore opacity so we don't leave the window invisible.
      await serverConnections.localHostApi()?.designModeReady();
      await serverConnections.localHostApi()?.exitDesignMode();
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
    void serverConnections.localHostApi()?.designModeReady();
  }

  async function handleDesignConfirm(
    dataUrl: string,
    annotations: DesignAnnotationType[],
  ) {
    const attachment = await serverConnections.localHostApi()?.submitDesignAnnotations({
      dataUrl,
      annotations,
    });
    if (attachment) {
      session.addAttachments([attachment], designModeTargetTabId);
    }
    designModeScreenshot = null;
    designModeTargetTabId = undefined;
    await tick();
    await serverConnections.localHostApi()?.exitDesignMode();
  }

  async function handleDesignCancel() {
    designModeScreenshot = null;
    designModeTargetTabId = undefined;
    await tick();
    await serverConnections.localHostApi()?.exitDesignMode();
  }


  $effect(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: {
          tabId?: string;
          draftId?: string;
          /** A tab id or a draft id — the surface that asked, when the emitter
           *  (RunOnPicker) does not know which kind it is scoped to. */
          requesterId?: string;
          serverId?: string;
          intent?: "dispatch" | "open-project";
        } | undefined = event.detail;
      const requesterId = detail?.requesterId;
      const requesterDraftId =
        requesterId && session.sessionDrafts.has(requesterId)
          ? requesterId
          : undefined;
      directoryPickerDraftId = detail?.draftId ?? requesterDraftId;
      const targetTabId =
        detail?.tabId ?? (requesterDraftId ? undefined : requesterId);
      const tab = targetTabId ? session.tabs[targetTabId] : null;
      const opensInNewTab = tab?.sessionId != null;
      directoryPickerNewTab = opensInNewTab;
      directoryPickerTargetTabId = opensInNewTab ? undefined : targetTabId;
      directoryPickerServerIdOverride = detail?.serverId;
      directoryPickerIntent = detail?.intent ?? "open-project";
      directoryPickerForOpenProject = false;
      directoryPickerOpen = true;
    };
    const openProjectHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: { tabId?: string } | undefined = event.detail;
      startOpenProject({ tabId: detail?.tabId });
    };
    // The git "Review a PR" action reuses the palette's PR list: open the
    // command palette drilled straight into the "Review PR…" sub-page.
    const reviewPrHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: {
          tabId?: string;
          cwd?: string;
          checkout?: GitCheckout | null;
        } | undefined = event.detail;
      const targetTabId = detail?.tabId ?? activeTabId;
      const targetSession = session.sessionFor(targetTabId);
      const dir =
        detail?.cwd ??
        targetSession?.run.gitContext?.repoRoot ??
        targetSession?.run.workingDirectory;
      paletteGitTarget = {
        tabId: targetTabId,
        ctx: detail?.cwd
          ? session.ctxForEnvironment(
              detail.cwd,
              detail.checkout ?? null,
              targetTabId,
            )
          : session.ctxFor(targetTabId),
        projectRoot: dir && dir !== "~" ? worktreeProjectRoot(dir) : null,
      };
      paletteInitialPage = { id: "review-pr", title: "Review PR" };
      commandPaletteOpen = true;
    };
    // The nearby-host discovery toast fires from a store, which has no way to
    // reach the settings pane on its own.
    const showConnectionsHandler = () => session.showSettings("api-access");
    window.addEventListener("solus:open-directory-picker", handler);
    window.addEventListener("solus:open-project", openProjectHandler);
    window.addEventListener("solus:review-pr", reviewPrHandler);
    window.addEventListener("solus:show-connections", showConnectionsHandler);
    return () => {
      window.removeEventListener("solus:open-directory-picker", handler);
      window.removeEventListener("solus:open-project", openProjectHandler);
      window.removeEventListener("solus:review-pr", reviewPrHandler);
      window.removeEventListener(
        "solus:show-connections",
        showConnectionsHandler,
      );
    };
  });

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false;
    invalidateHomeCache();
    if (directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir);
      return;
    }
    const draftId = directoryPickerDraftId;
    directoryPickerDraftId = undefined;
    if (draftId) {
      const draft = session.sessionDrafts.get(draftId);
      const draftHostOverride = directoryPickerServerIdOverride;
      const draftIntent = directoryPickerIntent;
      directoryPickerServerIdOverride = undefined;
      directoryPickerIntent = "open-project";
      if (draft) {
        // A browse that started from a host row carries that host with it —
        // the picked folder is a path on that machine, not this one.
        draft.run =
          draftHostOverride && draft.run.serverId !== draftHostOverride
            ? applyHostIntent(draft.run, draftHostOverride, dir, draftIntent)
            : withCheckout(draft.run, dir, null);
        void session.environment.refresh(dir);
      }
      requestInputFocus();
      return;
    }
    const targetTabId = directoryPickerTargetTabId;
    const overrideServerId = directoryPickerServerIdOverride;
    const intent = directoryPickerIntent;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    if (directoryPickerNewTab) {
      directoryPickerNewTab = false;
      // A started conversation keeps its folder; the project opens as a new
      // draft beside it. Choosing a host is part of that draft's run config —
      // there is no tab to move, because nothing has started.
      const draft = session.openSessionDraft({}, dir);
      if (overrideServerId) {
        draft.run = applyHostIntent(draft.run, overrideServerId, dir, intent);
      }
    } else if (
      targetTabId &&
      overrideServerId &&
      session.sessionFor(targetTabId)?.run.serverId !== overrideServerId
    ) {
      // The folder lives on another host, so the tab has to move there too —
      // setBaseDirectory alone would point the current host at a missing path.
      placeTabOnHost(targetTabId, overrideServerId, dir, { intent });
    } else {
      await session.setBaseDirectory(dir, targetTabId);
    }
    directoryPickerTargetTabId = undefined;
    requestInputFocus(targetTabId ? { tabId: targetTabId } : undefined);
  }

  function handleDirectoryPickerClose() {
    directoryPickerOpen = false;
    directoryPickerNewTab = false;
    directoryPickerTargetTabId = undefined;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    // Cancelling a browse that the Open project flow started returns to that
    // flow, on the step it left — not to an empty screen.
    if (directoryPickerForOpenProject) {
      directoryPickerForOpenProject = false;
      openProjectStore.back();
      return;
    }
    requestInputFocus();
  }

  /** The tab moves; no session does — nothing has started on it yet. */
  function placeTabOnHost(
    tabId: string,
    serverId: string,
    path: string,
    options: { intent?: "dispatch" | "open-project" } = {},
  ) {
    moveTabToHost({
      workspace: session,
      tabId,
      serverId,
      isLocalHost: serverId === serverConnections.localServerId(),
      path,
      intent: options.intent ?? "open-project",
    });
  }

  /** The draft equivalent of `placeTabOnHost`: a folder chosen on a host is
   *  that host's project, while a dispatch leaves the project where it is. */
  function applyHostIntent(
    run: RunConfig,
    serverId: string,
    path: string,
    intent: "dispatch" | "open-project",
  ): RunConfig {
    return intent === "dispatch"
      ? withHost(run, serverId, { path })
      : withProjectHost(run, serverId, { path });
  }

  /**
   * Every machine the Open project flow can land a project on, active one
   * first — the flow binds the head of this list, so the chip defaults to the
   * machine you are already working on.
   */
  function openProjectHosts(): HostOption[] {
    const activeId = serversStore.activeServerId;
    return [...serversStore.servers].sort(
      (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
    );
  }

  function startOpenProject(options: { tabId?: string } = {}) {
    openProjectStore.open(openProjectHosts(), { tabId: options.tabId });
  }

  /** Lands the chosen project in a session on the host that holds it. */
  async function openProjectAtPath(path: string, cloned: boolean) {
    const serverId = openProjectStore.serverId;
    const hostLabel = openProjectStore.hostLabel;
    const hostIsLocal = openProjectStore.hostIsLocal;
    const tabId = openProjectStore.tabId;
    const pushNote = openProjectStore.pushCapabilityNote;
    openProjectStore.close();
    if (!serverId) return;

    const name = path.split(/[\\/]/).pop() || path;
    projectCatalog.record({ serverId, projectRoot: path }, name);

    // The flow may have been started from a draft (RunOnPicker passes its
    // requester id through `tabId`); re-aim that draft instead of opening a
    // second one and orphaning the prompt already typed into it.
    const requesterDraft = tabId ? session.sessionDrafts.get(tabId) : undefined;
    // A started session keeps its folder — the project opens beside it instead.
    const reusableTabId =
      !requesterDraft &&
      tabId &&
      session.tabs[tabId] &&
      !isRunOnHostLocked(session.sessionFor(tabId))
        ? tabId
        : null;
    // A reusable tab is moved across; with none, the project opens as a draft
    // that simply names the host it will run on.
    if (requesterDraft) {
      requesterDraft.run = withProjectHost(
        withCheckout(requesterDraft.run, path, null),
        serverId,
        { path },
      );
      void session.environment.refresh(path);
      requestInputFocus();
    } else if (reusableTabId) {
      placeTabOnHost(reusableTabId, serverId, path);
      requestInputFocus({ tabId: reusableTabId });
    } else {
      const draft = session.openSessionDraft({}, path);
      draft.run = withProjectHost(draft.run, serverId, { path });
      requestInputFocus();
    }

    // A clone that authenticated as nobody works right up until the push, which
    // is 25 minutes away at PR time. Say so now, without blocking the session.
    if (pushNote) {
      const onboardingHost = { id: serverId, label: hostLabel || serverId };
      toasts.info("Git push is not set up", {
        description: pushNote,
        actions: [
          {
            label: "Set up",
            onAction: () => hostOnboardingStore.open(onboardingHost),
          },
        ],
      });
      return;
    }

    if (!cloned && hostIsLocal) return;
    toasts.success(
      cloned
        ? `Cloned ${name} on ${hostLabel || "host"}`
        : `Opened ${name} on ${hostLabel || "host"}`,
      {
        actions: [
          {
            label: "Copy path",
            onAction: () => void navigator.clipboard?.writeText(path),
          },
        ],
      },
    );
  }

  /** "Choose location…" — the same folder browser, handed back to the flow. */
  function browseForOpenProject() {
    if (!openProjectStore.serverId) return;
    directoryPickerForOpenProject = true;
    directoryPickerNewTab = false;
    directoryPickerTargetTabId = undefined;
    directoryPickerServerIdOverride = openProjectStore.serverId;
    directoryPickerIntent = "open-project";
    directoryPickerOpen = true;
  }

  /** A folder chosen for the flow: opened as-is, or used as the clone's parent. */
  async function finishBrowsedOpenProject(dir: string) {
    directoryPickerForOpenProject = false;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    openProjectStore.back();
    if (openProjectStore.source === "local") {
      await openProjectAtPath(dir, false);
      return;
    }
    const clonedPath = await openProjectStore.cloneInto(dir);
    if (clonedPath) await openProjectAtPath(clonedPath, true);
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
      const targetTabId = session.focusedChatTabId ?? session.activeTabId;
      const run = targetTabId ? session.runFor(targetTabId) : session.activeSession?.run;
      const serverId =
        run?.serverId ?? serverConnections.defaultServerId() ?? LOCAL_SERVER_ID;
      const ctx = targetTabId ? session.ctxFor(targetTabId) : session.ctx;
      try {
        const capabilities = await serverConnections.capabilitiesFor(serverId);
        if (capabilities.attachUpload !== true) {
          const hostLabel =
            serversStore.hostFor(serverId)?.label ??
            serverConnections.connectionFor(serverId)?.target.label ??
            "this host";
          toasts.info(unsupportedOnHost("File attachments", hostLabel));
          return;
        }
        if (!hostPolicy.isClientMachine(serverId)) {
          const attachments = await uploadFileObjects(
            serverConnections.apiFor(serverId),
            ctx,
            serverId,
            Array.from(files),
          );
          session.addAttachments(attachments, targetTabId);
          return;
        }
        const paths = Array.from(files)
          .map((file) => localApi.getPathForFile(file))
          .filter(Boolean);
        if (paths.length === 0) return;
        const attachments = await serverConnections.localHostApi()?.attachFilePaths(paths, ctx);
        if (attachments) session.addAttachments(attachments, targetTabId);
      } catch (error) {
        toasts.error(error instanceof Error ? error.message : "Couldn't attach files");
      }
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

<!-- Mouse back/forward drive the same history the keybindings do. The
     pointer's 3rd/4th buttons have no default action here, so nothing is lost
     by claiming them. -->
<svelte:window
  onmouseup={(e) => {
    if (e.button === 3) session.router.back();
    else if (e.button === 4) session.router.forward();
  }}
  onkeydowncapture={toasts.handleKeydown}
/>

<!--
  Without this, a thrown render leaves an empty window with nothing to act on.
  The boundary keeps the failure inside the app, where the user still has a way
  back to a working host.
-->
<svelte:boundary onerror={(error) => console.error("renderer crashed", error)}>
<Tooltip.Provider
  delayDuration={700}
  skipDelayDuration={300}
  disableHoverableContent
  ignoreNonKeyboardFocus
>
<Toaster
  theme={settings.isDark ? "dark" : "light"}
  position="top-right"
  offset={{ top: "1rem", right: "1rem" }}
  visibleToasts={1}
  duration={3000}
  closeButton
  hotkey={TOAST_HOTKEY}
/>

<!-- Popover overlay layer: sits above everything, ignores events except where portals opt in. -->
<div
  bind:this={overlayEl}
  data-solus-ui
  class="click-through-shell"
  style="position:fixed;inset:0;z-index:10010;pointer-events:none"
></div>

{#if initialEditorLayout}
  {@const EditorLayout = initialEditorLayout}
  <div class="mode-shell h-full w-full" class:mode-hidden={!isEditorMode}>
    <EditorLayout
      active={editorSurfaceActive}
      onAttachFile={handleAttachFile}
      onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
      onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
    />
  </div>
{:else if editorLayoutComponent}
  {#await editorLayoutComponent}
    <div
      class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-text-tertiary)"
      class:mode-hidden={!isEditorMode}
      role="status"
    >
      Loading workspace…
    </div>
  {:then editorLayoutModule}
    {@const EditorLayout = editorLayoutModule.default}
    <div class="mode-shell h-full w-full" class:mode-hidden={!isEditorMode}>
      <EditorLayout
        active={editorSurfaceActive}
        onAttachFile={handleAttachFile}
        onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
        onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
      />
    </div>
  {:catch}
    <div
      class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-status-error)"
      class:mode-hidden={!isEditorMode}
      role="alert"
    >
      Couldn’t load the workspace.
    </div>
  {/await}
{/if}

{#if pillLayoutComponent}
  {#await pillLayoutComponent}
    <div
      class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-text-tertiary)"
      class:mode-hidden={isEditorMode}
      role="status"
    >
      Loading workspace…
    </div>
  {:then pillLayoutModule}
    {@const PillLayout = pillLayoutModule.default}
    <div class="mode-shell" class:mode-hidden={isEditorMode}>
      <PillLayout
        active={pillSurfaceActive}
        onAttachFile={handleAttachFile}
        onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
        onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
      />
    </div>
  {:catch}
    <div
      class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-status-error)"
      class:mode-hidden={isEditorMode}
      role="alert"
    >
      Couldn’t load the workspace.
    </div>
  {/await}
{/if}

{#if hasMountedDirectoryPicker}
  {#await import("./components/pickers/DirectoryPicker.svelte")}
    {#if directoryPickerOpen}
      <div class="lazy-modal-loading" role="status">Loading folders…</div>
    {/if}
  {:then directoryPickerModule}
    {@const DirectoryPicker = directoryPickerModule.default}
    <DirectoryPicker
      bind:open={directoryPickerOpen}
      onClose={handleDirectoryPickerClose}
      onSelect={handleDirectorySelected}
      initialPath={directoryPickerInitialPath}
      title={directoryPickerTitle}
      actionLabel={directoryPickerAction}
      api={directoryPickerApi}
      hostLabel={directoryPickerHostLabel}
      serverId={directoryPickerServerId}
    />
  {/await}
{/if}

{#if hasMountedShortcuts}
  {#await import("./components/KeyboardShortcutsModal.svelte")}
    {#if shortcutsModalOpen}
      <div class="lazy-modal-loading" role="status">Loading shortcuts…</div>
    {/if}
  {:then shortcutsModule}
    {@const KeyboardShortcutsModal = shortcutsModule.default}
    <KeyboardShortcutsModal
      bind:open={shortcutsModalOpen}
      activeScopes={shortcutsActiveScopes}
    />
  {/await}
{/if}

{#if hasMountedGoToFile}
  {#await import("./components/search/FilePickerOverlay.svelte")}
    {#if goToFileOpen}
      <div class="lazy-modal-loading" role="status">Loading files…</div>
    {/if}
  {:then filePickerModule}
    {@const FilePickerOverlay = filePickerModule.default}
    <FilePickerOverlay bind:open={goToFileOpen} tabId={keyboardTabId} />
  {/await}
{/if}

{#if hasMountedProjectSearch}
  {#await import("./components/search/ProjectSearchOverlay.svelte")}
    {#if projectSearchOpen}
      <div class="lazy-modal-loading" role="status">Loading search…</div>
    {/if}
  {:then projectSearchModule}
    {@const ProjectSearchOverlay = projectSearchModule.default}
    <ProjectSearchOverlay
      bind:open={projectSearchOpen}
      isDark={settings.isDark}
      tabId={keyboardTabId}
    />
  {/await}
{/if}

{#if hasMountedCommandPalette}
  {#await commandPaletteModulePromise}
    {#if commandPaletteOpen}
      <div class="lazy-modal-loading" role="status">Loading commands…</div>
    {/if}
  {:then commandPaletteModule}
    {@const CommandPalette = commandPaletteModule.default}
    <CommandPalette
      bind:open={commandPaletteOpen}
      bind:initialPage={paletteInitialPage}
      commands={paletteCommands}
    />
  {/await}
{/if}

<ConnectionStatusOverlay dimBackdrop={isEditorMode} />

{#if hasMountedAddServer}
  {#await import("./components/servers/AddServerModal.svelte")}
    {#if serversStore.addServerOpen}
      <div class="lazy-modal-loading" role="status">Loading server setup…</div>
    {/if}
  {:then addServerModule}
    {@const AddServerModal = addServerModule.default}
    <AddServerModal />
  {/await}
{/if}

<!-- First run only. Mounted over everything, and never lazily pre-warmed: a
     client that has already been through it must not pay for the chunk. -->
{#if !settings.onboardingCompleted}
  {#await import("./components/onboarding/OnboardingSurface.svelte")}
    <!-- Opaque from the first frame: without this the workspace is visible for
         as long as the lazy chunk takes to arrive. Same composite as the
         surface itself — --background alone is translucent in dark mode. -->
    <div
      class="fixed inset-0 z-[10005]"
      style="background: linear-gradient(var(--background), var(--background)) var(--solus-edge-bg)"
    ></div>
  {:then onboardingModule}
    {@const OnboardingSurface = onboardingModule.default}
    <OnboardingSurface />
  {/await}
{/if}

{#if hasMountedOpenProject}
  {#await import("./components/servers/OpenProjectDialog.svelte")}
    {#if openProjectStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading projects…</div>
    {/if}
  {:then openProjectModule}
    {@const OpenProjectDialog = openProjectModule.default}
    <OpenProjectDialog
      onOpenProject={(path) =>
        void openProjectAtPath(path, openProjectStore.source !== "local")}
      onBrowse={browseForOpenProject}
      onBackgroundCloneFailure={(failure) =>
        toasts.error(failure.title, { description: failure.detail })}
      localIdentity={localGitIdentity}
    />
  {/await}
{/if}

{#if hasMountedHostOnboarding}
  {#await import("./components/servers/HostOnboarding.svelte")}
    {#if hostOnboardingStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading host setup…</div>
    {/if}
  {:then hostOnboardingModule}
    {@const HostOnboarding = hostOnboardingModule.default}
    <HostOnboarding />
  {/await}
{/if}

{#if sessionRename && session.tabs[sessionRename.tabId]}
  <RenameSessionDialog
    tabId={sessionRename.tabId}
    onClose={() => (session.ui.sessionRename = null)}
  />
{/if}

{#if taskComposer && taskComposerConfig !== undefined}
  {#await import("./components/tasks/TaskComposer.svelte")}
    <div class="lazy-modal-loading" role="status">Loading task composer…</div>
  {:then taskComposerModule}
    {@const TaskComposer = taskComposerModule.default}
    <TaskComposer
      epics={taskComposerEpics}
      allowEpics={taskComposerProvider === "local"}
      canPlan={taskComposerProvider === "local"}
      knownLabels={taskComposerLabels}
      workingDirectory={taskComposer.workingDirectory}
      provider={settings.activeAgent}
      onCreate={async (input) => {
        const context = taskComposer;
        if (!context) return;
        try {
          await session.tasksStore.create({
            ...input,
            projectKey: context.projectKey,
            branch: context.branch,
            worktreeKey: input.parentId ? undefined : context.worktreeKey,
          });
          toasts.success("Task created");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toasts.error("Couldn't create task", { description: message });
          // Rethrow so the composer keeps the modal open; it owns dismissal on
          // success (via onCancel) so "Create more" can stay open.
          throw err;
        }
      }}
      onCancel={() => (session.ui.taskComposer = null)}
    />
  {/await}
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
</Tooltip.Provider>

{#snippet failed(error)}
  <FatalErrorScene {error} />
{/snippet}
</svelte:boundary>

<style>
  .mode-hidden {
    display: none !important;
  }

  .lazy-modal-loading {
    position: fixed;
    inset: 0;
    z-index: 10024;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--solus-container-bg) 72%, transparent);
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    pointer-events: auto;
  }

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
    border-radius: 1rem;
    border: 0.0938rem dashed var(--color-zinc-600);
    color: var(--color-zinc-400);
    font-size: var(--text-sm);
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
