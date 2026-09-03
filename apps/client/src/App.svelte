<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Download as DownloadSimpleIcon } from "@lucide/svelte";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import {
    savePersistedTabs,
    saveDraftsDebounced,
    flushDrafts,
    savePersistedSessionDraftsDebounced,
    flushPersistedSessionDrafts,
    type PersistedTabs,
  } from "@solus/workspace-ui/contexts/workspace/tab-persistence";
  import { snapshotPersistedTabs } from "@solus/workspace-ui/contexts/workspace/tab-snapshot";
  import type { Attachment, RunConfig } from "@solus/contracts/types";
  import {
    withCheckout,
    withHost,
    withProjectHost,
  } from "@solus/workspace-ui/contexts/workspace/run-config";
  import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
  import {
    materializeTabs,
    reconcileReloadLocation,
  } from "@solus/workspace-ui/contexts/workspace/session-bootstrap";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import {
    createReconnectDetector,
    initializeRuntime,
  } from "@solus/workspace-ui/contexts/app/runtime-boot";
  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { subscribe } from "@solus/client-core/connection-state";
  import {
    connectionsStore,
    parseRoute,
    projectsStore,
    serversStore,
    runtime,
  } from "@solus/workspace-ui/contexts";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { unsupportedOnHost } from "@solus/client-core/host-capabilities";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { notificationsStore } from "@solus/workspace-ui/contexts/notifications/notifications.store.svelte";
  import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";
  import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
  import { moveTabToHost, isRunOnHostLocked } from "@solus/workspace-ui/components/servers/run-on";
  import { webState } from "./lib/web-state.svelte";
  import { webPushState } from "./lib/web-push.svelte";
  import {
    useKeybinding,
    installGlobalDispatcher,
  } from "@solus/workspace-ui/lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
  import {
    identifyInstallation,
    initAnalytics,
    registerSuperProps,
    track,
  } from "@solus/workspace-ui/lib/analytics";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import CommandPalette from "@solus/workspace-ui/components/command-palette/CommandPalette.svelte";
  import type { Command } from "@solus/workspace-ui/components/command-palette/lib/commands";
  import { comboHint } from "@solus/workspace-ui/lib/keybindings/manifest";
  import WebLayout from "./components/WebLayout.svelte";

  const {
    settings,
    windowCtx,
    planStore,
    projectConfigStore,
    sessionSidebarStore,
    voiceModelStore,
    pullRequests,
    session,
    agent,
    keybindings,
  } = createAppCore();

  const taskComposer = $derived(session.ui.taskComposer);
  const taskComposerServerId = $derived(
    taskComposer
      ? (session.tasksStore.hostForProject(taskComposer.cwd) ??
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
      ? projectConfigStore.configFor(taskComposerServerId, taskComposer.cwd)
      : undefined,
  );
  const taskComposerProvider = $derived(
    taskComposerConfig?.taskProvider ?? "local",
  );
  const taskComposerTasks = $derived(
    taskComposer ? session.tasksStore.tasksForProject(taskComposer.cwd) : [],
  );
  const taskComposerEpics = $derived(
    taskComposerTasks.filter((task) => task.kind === "epic"),
  );
  const taskComposerLabels = $derived(
    Array.from(new Set(taskComposerTasks.flatMap((task) => task.labels))).sort(),
  );

  $effect(() => {
    if (!taskComposer || !taskComposerHost) return;
    void projectConfigStore.load(taskComposerHost, taskComposer.cwd);
  });

  const initialViewMode = windowCtx.viewMode;

  initAnalytics({
    enabled: settings.analyticsEnabled,
    platform: initialViewMode === "pill" ? "web-mobile" : "web-desktop",
    viewMode: initialViewMode,
  });
  track("app_opened", {});

  $effect(() => {
    const viewMode = windowCtx.viewMode;
    registerSuperProps({
      view_mode: viewMode,
      platform: viewMode === "pill" ? "web-mobile" : "web-desktop",
    });
  });

  $effect(() => {
    const appVersion = session.staticInfo?.version;
    if (appVersion) registerSuperProps({ app_version: appVersion });
  });

  onMount(() =>
    subscribe((state) => {
      const installationId = state.target?.installationId;
      if (installationId) identifyInstallation(installationId);
    }),
  );

  // Materialize tabs synchronously during component init — before first paint — so
  // the tab strip, titles, drafts, and active tab render in the first mounted frame
  // with zero server round trips. Cached start() is applied first so persisted tabs
  // can fall back to the last known workspace path. The async runtime attach and
  // fresh start() reconciliation run later from the effect below.
  session.hydrateStaticInfoFromCache();
  materializeTabs(session);
  // The web shell has an address bar, so the location is mirrored into it: every
  // pane, its overlay, and the focused index are in the URL, which is what makes
  // a workspace shareable and browser-back meaningful here.
  session.router.bindAddressBar();
  reconcileReloadLocation(session);

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
    savePersistedTabs(snapshot);
  });

  // Unsent input drafts persist separately on a debounce. This effect re-runs on
  // every keystroke but only collects strings — no object spreads, no I/O until
  // the debounce settles — so the structural snapshot above stays keystroke-free.
  $effect(() => {
    if (session.hydrating) return;
    const tabs: Record<string, string> = {};
    for (const tabId of session.tabOrder) {
      const sess = session.sessionFor(tabId);
      if (sess) tabs[tabId] = sess.prompt.text;
    }
    saveDraftsDebounced({ activeInputText: session.activeInput.text, tabs });
  });

  // Session drafts persist on their own key: they have no tab to ride, and a
  // prompt the user already wrote must survive a reload. The web client
  // restores from this key (materializeTabs), so it must write it too.
  $effect(() => {
    if (session.hydrating) return;
    savePersistedSessionDraftsDebounced(session.sessionDraftsSnapshot);
  });

  // Flush pending drafts before the window unloads so the latest keystrokes survive.
  $effect(() => {
    const flush = () => {
      flushDrafts();
      flushPersistedSessionDrafts();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  });

  // Slash command discovery is backend-scoped, so refresh when the active agent changes.
  // Keep the whole refresh outside tracking: the command loader reads more session
  // state synchronously before its first await, but only an agent change belongs here.
  $effect(() => {
    void settings.activeAgent;
    untrack(() =>
      void session.refreshPluginCommands(session.tabCtx.workingDirectory),
    );
  });

  setupAgentEvents(session);

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();


  let directoryPickerOpen = $state(false);
  let directoryPickerNewTab = $state(false);
  let directoryPickerTargetTabId = $state<string | undefined>(undefined);
  /** Set when the browser was opened from a session draft, which has no tab to
   *  retarget — the chosen directory lands on its run config instead. */
  let directoryPickerDraftId = $state<string | undefined>(undefined);
  // Set when a caller names the host to browse — the "Run on" picker and the
  // Open project flow both browse a host no tab points at yet.
  let directoryPickerServerIdOverride = $state<string | undefined>(undefined);
  let directoryPickerIntent = $state<"dispatch" | "open-project">("open-project");
  // "Choose location…" in the Open project flow borrows the same browser; its
  // selection is handed back to that flow instead of retargeting a tab here.
  let directoryPickerForOpenProject = $state(false);
  // "Add project…" in a page's project switcher borrows it too: the folder is
  // recorded as a project so pages can scope to it, and no tab is retargeted.
  let directoryPickerForAddProject = $state(false);
  let directoryPickerOnProjectAdded = $state<
    ((project: ProjectRef) => void) | undefined
  >(undefined);
  let shortcutsModalOpen = $state(false);
  let commandPaletteOpen = $state(false);
  let hasMountedDirectoryPicker = $state(false);
  let hasMountedShortcuts = $state(false);
  let hasMountedOpenProject = $state(false);
  let hasMountedHostOnboarding = $state(false);
  let hasMountedAddServer = $state(false);
  let hasMountedServerSetup = $state(false);
  /** Offered as the prefill when a remote host has no commit identity of its own. */
  let localGitIdentity = $state<{ name: string; email: string } | null>(null);
  let shortcutsActiveScopes = $state<import("@solus/workspace-ui/lib/keybindings/types").Scope[]>([]);

  $effect(() => {
    if (directoryPickerOpen) hasMountedDirectoryPicker = true;
    if (shortcutsModalOpen) hasMountedShortcuts = true;
    if (openProjectStore.isOpen) hasMountedOpenProject = true;
    if (hostOnboardingStore.isOpen) hasMountedHostOnboarding = true;
    if (serversStore.addServerOpen) hasMountedAddServer = true;
    if (webState.serverSetupOpen) hasMountedServerSetup = true;
  });

  // A bare host has no commit identity; on web the serving/boot host plays the
  // "this machine" role and its identity is the obvious prefill.
  $effect(() => {
    if (!openProjectStore.isOpen || localGitIdentity) return;
    const bootServerId = serverConnections.defaultServerId();
    if (!bootServerId) return;
    void serverConnections
      .apiFor(bootServerId)
      .setupHostReadiness()
      .then((readiness) => (localGitIdentity = readiness.git.identity))
      .catch(() => {});
  });

  const activeTabId = $derived(session.activeTabId);
  // Keyboard next/prev follows the order WebLayout actually renders: raw tabOrder.
  const visualTabOrder: string[] = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  /**
   * The composer the keyboard is aimed at, and the run it is composing.
   *
   * `focusedSourceId` answers for a draft pane as well as a started chat;
   * `activeSession` names only the tab *behind* a draft. Since the phone's
   * composer before Send is always a draft, the model, mode and agent shortcuts
   * below were reading — and writing — a conversation the user was not looking
   * at. Undefined means no pane owns a composer, which is the one case where the
   * controllers' own active-session fallback is the right answer.
   */
  const composerSourceId = $derived(session.focusedSourceId ?? undefined);
  const composerRun = $derived(
    composerSourceId ? session.runFor(composerSourceId) : session.activeSession?.run,
  );
  const permissionMode = $derived(composerRun?.permissionMode ?? "auto");
  const composerMetadata = $derived(
    agent.metadata[composerRun?.provider ?? settings.activeAgent] ??
      agent.activeMetadata,
  );

  // ── Host-aware directory picker (mirrors the desktop shell) ──────────────
  const directoryPickerCreatesTab = $derived(
    directoryPickerNewTab ||
      (!directoryPickerTargetTabId && !!session.activeSession?.agentSessionId),
  );
  const directoryPickerTitle = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local"
        ? "Open a folder"
        : "Choose where to clone";
    }
    if (directoryPickerForAddProject) return "Add a project";
    return directoryPickerCreatesTab
      ? "Open project in a new tab"
      : "Change project folder";
  });
  const directoryPickerAction = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local" ? "Open" : "Clone here";
    }
    if (directoryPickerForAddProject) return "Add project";
    return directoryPickerCreatesTab ? "Open in new tab" : "Choose";
  });
  // Browse the host the tab actually runs on; an explicit override wins.
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
  const directoryPickerApi = $derived.by(() => {
    if (directoryPickerOpen) {
      return serverConnections.apiFor(directoryPickerServerId);
    }
    const bootServerId = serverConnections.defaultServerId();
    return bootServerId ? serverConnections.apiFor(bootServerId) : undefined;
  });
  const directoryPickerHostLabel = $derived.by(() => {
    const host = serversStore.hostFor(directoryPickerServerId);
    return host && !host.local ? host.label : undefined;
  });
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = directoryPickerTargetTabId
      ? session.sessionFor(directoryPickerTargetTabId)
      : null;
    if (targetSession?.run.serverId === directoryPickerServerId) {
      return targetSession.run.workingDirectory;
    }
    return undefined;
  });

  $effect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  });

  // Host listeners belong to the lifetime of this app, not to state that a
  // listener callback or an initial loader happens to read synchronously.
  $effect(() =>
    untrack(() => {
      const unsubVoiceModel = subscribeAllHosts('voice.modelStatusChanged', (serverId, status) =>
        voiceModelStore.apply(status, serverId),
      );
      const unsubSessionStatuses = sessionSidebarStore.subscribeSessionStatuses();
      const defaultServerId = serverConnections.defaultServerId();
      if (defaultServerId) void voiceModelStore.refresh(defaultServerId);
      const unsubAutomations = subscribeAllHosts('automation.changed', (serverId, event) => {
        session.automationsStore.applyChange(serverId, event);
        if (event.kind === 'run-finished' && event.run.status === 'failed') {
          toasts.error(`Automation "${event.automation.name}" failed`, {
            action: {
              label: 'View',
              onAction: () => session.openAutomations(event.automation.id),
            },
          });
        }
      });
      const unsubUsage = subscribeAllHosts('usage.limitsChanged', (_serverId, { snapshots }) =>
        agent.applyUsage(snapshots),
      );
      void agent.refreshUsage();
      return () => {
        unsubVoiceModel();
        unsubSessionStatuses();
        unsubAutomations();
        unsubUsage();
      };
    }),
  );

  $effect(() => {
    const enabled = settings.soundEnabled;
    void webPushState.syncEnabled(enabled);
    if (!enabled) {
      notificationsStore.stop();
      return;
    }
    return untrack(() => notificationsStore.start({
      hostDisplay: (serverId) => {
        const host = serversStore.hostFor(serverId);
        const display: import("@solus/workspace-ui/contexts/notifications/notifications.store.svelte").NotificationHostDisplay = {
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

  // A notification click arrives as a serialized route — the same vocabulary the
  // address bar, the persisted snapshot, and agent links use.
  $effect(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const route = parseRoute(String(event.detail ?? ""));
      if (!route) return;
      session.openRoute(route);
      requestInputFocus();
    };
    window.addEventListener("solus:open-route", handler);
    return () => window.removeEventListener("solus:open-route", handler);
  });

  $effect(() => {
    initializeRuntime(session, sessionSidebarStore);
  });

  const detectReconnect = createReconnectDetector(webState.connectionStatus);
  $effect(() => {
    const connectionStatus = webState.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    if (connectionStatus === 'connected') track(reconnected ? 'client_reconnected' : 'client_connected', reconnected ? { attempt: webState.connectionAttempt } : {});
    if (connectionStatus === 'connected') {
      const defaultServerId = serverConnections.defaultServerId();
      if (defaultServerId) {
        void connectionsStore.refreshCapabilities({ serverId: defaultServerId });
      }
    }
    if (reconnected) {
      settings.setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
      initializeRuntime(session, sessionSidebarStore);
      pullRequests.checks.reportActivity(session.apiForContext(session.ctx), session.ctx);
    }
  });

  // ── Keybindings ──────────────────────────────────────────────────────────
  installGlobalDispatcher(keybindings, () => settings.keybindings);

  useKeybinding("global.select-project", () => {
    startOpenProject({ sourceId: composerSourceId });
  });
  useKeybinding("global.open-host-project", () => {
    const pageServerId =
      session.projectPageScope.kind === "project"
        ? session.projectPageScope.project.serverId
        : serversStore.activeServer?.id;
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: session.hasProjectPageOpen
          ? {
              intent: "add-project",
              serverId: pageServerId,
              onProjectAdded: (project: ProjectRef) => {
                session.scopeOpenProjectPage(project);
              },
            }
          : {
              requesterId: composerSourceId,
              serverId:
                session.runFor(composerSourceId ?? "")?.serverId ??
                serversStore.activeServer?.id,
            },
      }),
    );
  });
  useKeybinding("global.new-task", () => {
    session.openSessionDraft({ freshTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session-without-task", () => {
    session.openSessionDraft({ withoutTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session", () =>
    session.openSessionDraft({ via: "keybinding" }),
  );
  useKeybinding("global.next-tab", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(visualTabOrder[(idx + 1) % visualTabOrder.length], "keybinding");
  });
  useKeybinding("global.prev-tab", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(
        visualTabOrder[
          (idx - 1 + visualTabOrder.length) % visualTabOrder.length
        ],
        "keybinding",
      );
  });
  useKeybinding("global.next-session", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(visualTabOrder[(idx + 1) % visualTabOrder.length], "keybinding");
  });
  useKeybinding("global.prev-session", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(
        visualTabOrder[
          (idx - 1 + visualTabOrder.length) % visualTabOrder.length
        ],
        "keybinding",
      );
  });
  useKeybinding("global.session-picker", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.session-picker-j", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.cycle-perm-mode", () => {
    const modes = ["ask", "auto", "plan"] as const;
    const next =
      modes[
        (modes.indexOf(permissionMode) + 1) %
          modes.length
      ];
    session.setPermissionMode(next, composerSourceId, "keybinding");
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) session.closeTab(activeTabId, "keybinding");
  });
  useKeybinding("global.attach-file", handleAttachFile);
  useKeybinding("global.cycle-agent", async () => {
    if (!isRunning) await cycleAgentProvider("keybinding");
  });
  useKeybinding("global.cycle-model", () => {
    if (isRunning) return;
    // The list to cycle is the *composer's* provider's, not the app-wide active
    // agent's: a draft that switched to Codex must not cycle Claude's models.
    const models = composerMetadata?.models;
    if (!models || models.length === 0) return;
    const currentModel =
      composerRun?.modelConfig.modelId ??
      session.activeSession?.sessionModel ??
      composerMetadata?.defaultModel ??
      models[0].id;
    const idx = models.findIndex((m) => m.id === currentModel);
    session.updateModelConfig({
      modelId: models[((idx === -1 ? 0 : idx) + 1) % models.length].id,
    }, composerSourceId, "keybinding");
  });
  useKeybinding("global.toggle-reasoning", () => {
    const targetTabId = session.router.leadingPane.base?.name === "draft"
      ? undefined
      : session.activeTabId;
    const targetStatus = session.sessionFor(targetTabId)?.status;
    if (targetStatus === "running" || targetStatus === "connecting") return;
    window.dispatchEvent(
      new CustomEvent("solus:toggle-session-settings-picker", {
        detail: { tabId: targetTabId },
      }),
    );
  });
  useKeybinding("global.toggle-diff-panel", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-diff-panel")),
  );
  useKeybinding("global.toggle-workspace", () => session.toggleFolio("keybinding"));
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.toggle-worktree", () =>
    session.toggleWorktreeMode(session.focusedSourceId ?? undefined, "keybinding"),
  );
  useKeybinding("global.switch-worktree", () => {
    if (session.activeSession?.agentSessionId) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding("global.show-shortcuts", () => {
    shortcutsActiveScopes = keybindings.activeScopes();
    shortcutsModalOpen = true;
  });
  useKeybinding("global.command-palette", () => {
    commandPaletteOpen = true;
  });

  // The web shell owns its application commands just as it owns the keybindings
  // above. Keep this list to actions that have transport-neutral web behavior;
  // desktop-only commands remain in the desktop shell's richer palette.
  const paletteCommands = $derived.by((): Command[] => [
    {
      id: "open-project",
      label: "Open project…",
      group: "General",
      hint: comboHint("global.select-project"),
      keywords: ["folder", "directory", "repository", "host"],
      run: () => startOpenProject({ sourceId: composerSourceId }),
    },
    {
      id: "new-task",
      label: "New task",
      group: "General",
      hint: comboHint("global.new-task"),
      keywords: ["create", "task"],
      run: () => session.openSessionDraft({ freshTask: true, via: "palette" }),
    },
    {
      id: "new-session",
      label: "New session",
      group: "General",
      hint: comboHint("global.new-session"),
      keywords: ["create", "chat", "tab"],
      run: () => session.openSessionDraft({ via: "palette" }),
    },
    {
      id: "new-session-without-task",
      label: "New session without task",
      group: "General",
      hint: comboHint("global.new-session-without-task"),
      keywords: ["create", "chat", "tab", "no task"],
      run: () =>
        session.openSessionDraft({ withoutTask: true, via: "palette" }),
    },
    {
      id: "workspace",
      label: "Open workspace",
      group: "View",
      hint: comboHint("global.toggle-workspace"),
      keywords: ["works", "documents", "folio"],
      run: () => session.toggleFolio("palette"),
    },
    {
      id: "tasks",
      label: "Open tasks",
      group: "View",
      keywords: ["board", "todo", "issues"],
      run: () => session.openTasks(),
    },
    {
      id: "pull-requests",
      label: "Open pull requests",
      group: "View",
      keywords: ["pr", "review", "github"],
      run: () => session.openPrs(),
    },
    {
      id: "automations",
      label: "Open automations",
      group: "View",
      keywords: ["schedule", "recurring", "cron"],
      run: () => session.openAutomations(),
    },
    {
      id: "browser",
      label: "Open browser",
      group: "View",
      keywords: ["web", "viewport", "device"],
      run: () => session.openBrowser(),
    },
    {
      id: "settings",
      label: "Settings",
      group: "General",
      keywords: ["preferences", "configuration"],
      run: () => session.showSettings("general", "palette"),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      group: "General",
      hint: comboHint("global.show-shortcuts"),
      keywords: ["keybindings", "keys"],
      run: () => {
        shortcutsActiveScopes = keybindings.activeScopes();
        shortcutsModalOpen = true;
      },
    },
  ]);

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
          intent?: "dispatch" | "open-project" | "add-project";
          onProjectAdded?: (project: ProjectRef) => void;
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
      // Adding a project retargets nothing, so it keeps the plain open-project
      // run intent and states itself with its own flag.
      const requestedIntent = detail?.intent ?? "open-project";
      directoryPickerForAddProject = requestedIntent === "add-project";
      directoryPickerOnProjectAdded = detail?.onProjectAdded;
      directoryPickerIntent =
        requestedIntent === "add-project" ? "open-project" : requestedIntent;
      directoryPickerForOpenProject = false;
      directoryPickerOpen = true;
    };
    const openProjectHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: { tabId?: string } | undefined = event.detail;
      startOpenProject({ sourceId: detail?.tabId });
    };
    // The nearby-host discovery toast fires from a store, which has no way to
    // reach the settings pane on its own.
    const showConnectionsHandler = () => session.showSettings("api-access");
    window.addEventListener("solus:open-directory-picker", handler);
    window.addEventListener("solus:open-project", openProjectHandler);
    window.addEventListener("solus:show-connections", showConnectionsHandler);
    return () => {
      window.removeEventListener("solus:open-directory-picker", handler);
      window.removeEventListener("solus:open-project", openProjectHandler);
      window.removeEventListener(
        "solus:show-connections",
        showConnectionsHandler,
      );
    };
  });

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false;
    projectsStore.invalidateRecentProjects();
    if (directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir);
      return;
    }
    if (directoryPickerForAddProject) {
      // Read the browsed host before the override is cleared — the project is
      // recorded against the machine the folder is actually on.
      const addServerId = directoryPickerServerId;
      directoryPickerForAddProject = false;
      directoryPickerServerIdOverride = undefined;
      directoryPickerDraftId = undefined;
      const project = await projectsStore.addProject(
        addServerId,
        serverConnections.apiFor(addServerId),
        dir,
      );
      const onProjectAdded = directoryPickerOnProjectAdded;
      directoryPickerOnProjectAdded = undefined;
      if (project) onProjectAdded?.(project);
      return;
    }
    projectsStore.recordProject(directoryPickerServerId, dir);
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
        if (draftIntent === "open-project") draft.task = { kind: "new" };
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
      const draft = session.openSessionDraft(
        { freshTask: intent === "open-project" },
        dir,
      );
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
    directoryPickerForAddProject = false;
    directoryPickerOnProjectAdded = undefined;
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
      // A browser is not a machine that can host, so this is never true on web.
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
  function openProjectHosts() {
    const activeId = serversStore.activeServer?.id;
    return [...serversStore.servers].sort(
      (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
    );
  }

  function startOpenProject(options: { sourceId?: string } = {}) {
    const hosts = openProjectHosts();
    const targetServerId =
      session.projectPageScope.kind === "project"
        ? session.projectPageScope.project.serverId
        : options.sourceId
          ? session.runFor(options.sourceId)?.serverId
          : undefined;
    openProjectStore.open(hosts, {
      tabId: options.sourceId,
      host: hosts.find((host) => host.id === targetServerId),
      onProjectOpened: session.hasProjectPageOpen
        ? (project) => {
            session.scopeOpenProjectPage(project);
          }
        : undefined,
    });
  }

  /** Lands the chosen project in a session on the host that holds it. */
  async function openProjectAtPath(path: string, cloned: boolean) {
    const serverId = openProjectStore.serverId;
    const hostLabel = openProjectStore.hostLabel;
    const hostIsLocal = openProjectStore.hostIsLocal;
    const tabId = openProjectStore.tabId;
    const onProjectOpened = openProjectStore.onProjectOpened;
    const pushNote = openProjectStore.pushCapabilityNote;
    openProjectStore.close();
    if (!serverId) return;

    const project = projectsStore.recordProject(serverId, path);

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
    if (onProjectOpened && project) {
      onProjectOpened(project);
    } else if (requesterDraft) {
      requesterDraft.run = withProjectHost(
        withCheckout(requesterDraft.run, path, null),
        serverId,
        { path },
      );
      requesterDraft.task = { kind: "new" };
      void session.environment.refresh(path);
      requestInputFocus();
    } else if (reusableTabId) {
      placeTabOnHost(reusableTabId, serverId, path);
      requestInputFocus({ tabId: reusableTabId });
    } else {
      const draft = session.openSessionDraft({ freshTask: true }, path);
      draft.run = withProjectHost(draft.run, serverId, { path });
      requestInputFocus();
    }

    // A clone that authenticated as nobody works right up until the push, which
    // is 25 minutes away at PR time. Say so now, without blocking the session.
    if (pushNote) {
      const onboardingHost = { id: serverId, label: hostLabel || serverId };
      toasts.info(pushNote, {
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
    const name = path.split(/[\\/]/).pop();
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
    directoryPickerForAddProject = false;
    directoryPickerOnProjectAdded = undefined;
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

  /**
   * Where files picked from `sourceId` are asked for, and where they land.
   *
   * Addressed by source, not by chat tab: the phone's Add-to-chat sheet is also
   * opened from a session draft, which owns a run and a prompt but has no tab.
   * `focusedChatTabId` would have named the session behind it, and `inputFor`
   * only reaches a tab's prompt — a draft's files would have collected in the
   * workspace's fallback input, where nothing sends them.
   */
  function attachmentTargetFor(sourceId: string | undefined) {
    const targetTabId = sourceId ?? session.focusedSourceId ?? session.activeTabId;
    const draft = targetTabId ? session.sessionDrafts.get(targetTabId) : undefined;
    return {
      targetTabId,
      // `ctxFor` resolves a draft as readily as a tab, and names the draft so the
      // host has an upload folder before a session exists.
      ctx: targetTabId ? session.ctxFor(targetTabId) : session.ctx,
      receive: (files: Attachment[]) => {
        if (draft) draft.prompt.attachments.push(...files);
        else session.addAttachments(files, targetTabId);
      },
    };
  }

  async function handleAttachFile(sourceId?: string) {
    const { targetTabId, ctx, receive } = attachmentTargetFor(sourceId);
    const serverId =
      (targetTabId ? session.runFor(targetTabId)?.serverId : undefined) ??
      serverConnections.defaultServerId();
    if (!serverId) return;
    const capabilities = await serverConnections.capabilitiesFor(serverId);
    if (capabilities.attachUpload !== true) {
      const hostLabel =
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        "this host";
      toasts.info(unsupportedOnHost("File attachments", hostLabel));
      return;
    }
    const api = targetTabId
      ? session.apiFor(targetTabId)
      : serverConnections.apiFor(serverId);
    const files = await api.attachFiles(ctx);
    if (!files || files.length === 0) return;
    const runServerId = targetTabId ? session.runFor(targetTabId)?.serverId : undefined;
    if (runServerId) {
      for (const file of files) {
        if (file.hostPath) file.hostServerId = runServerId;
      }
    }
    receive(files);
  }

  async function handleAttachFiles(files: File[], sourceId?: string) {
    const { targetTabId, ctx, receive } = attachmentTargetFor(sourceId);
    const serverId =
      (targetTabId ? session.runFor(targetTabId)?.serverId : undefined) ??
      serverConnections.defaultServerId();
    if (!serverId) return;
    const capabilities = await serverConnections.capabilitiesFor(serverId);
    if (capabilities.attachUpload !== true) {
      const hostLabel =
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        "this host";
      toasts.info(unsupportedOnHost("File attachments", hostLabel));
      return;
    }
    const api = targetTabId
      ? session.apiFor(targetTabId)
      : serverConnections.apiFor(serverId);
    const attachments = await api.uploadFiles(files, ctx);
    if (!attachments) {
      toasts.error("Couldn't attach files");
      return;
    }
    const runServerId = targetTabId
      ? session.runFor(targetTabId)?.serverId
      : undefined;
    if (runServerId) {
      for (const attachment of attachments) {
        attachment.hostServerId = runServerId;
      }
    }
    receive(attachments);
  }

  async function cycleAgentProvider(via: "click" | "keybinding" | "palette" = "click") {
    const enabledAgents = agent.agents.filter(
      (candidate) => agent.metadata[candidate.id]?.available === true,
    );
    if (enabledAgents.length <= 1) return;

    const currentAgent = composerRun?.provider ?? settings.activeAgent;
    const idx = enabledAgents.findIndex(
      (candidate) => candidate.id === currentAgent,
    );
    const next = enabledAgents[(idx + 1) % enabledAgents.length];
    session.switchActiveAgent(next.id, composerSourceId, via);
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
      // The same target the picker resolves — a drop onto a draft belongs to
      // that draft, not to the chat tab behind it.
      const { targetTabId: tabId, ctx, receive } = attachmentTargetFor(undefined);
      const serverId =
        (tabId ? session.runFor(tabId)?.serverId : undefined) ??
        serverConnections.defaultServerId();
      if (!serverId) return;
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        const hostLabel =
          serversStore.hostFor(serverId)?.label ??
          serverConnections.connectionFor(serverId)?.target.label ??
          "this host";
        toasts.info(unsupportedOnHost("File attachments", hostLabel));
        return;
      }
      const api = tabId
        ? session.apiFor(tabId)
        : serverConnections.apiFor(serverId);
      const attachments = await api.uploadFiles(Array.from(files), ctx);
      const runServerId = tabId ? session.runFor(tabId)?.serverId : undefined;
      if (attachments && runServerId) {
        for (const attachment of attachments) attachment.hostServerId = runServerId;
      }
      if (attachments) receive(attachments);
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

<Tooltip.Provider
  delayDuration={450}
  skipDelayDuration={300}
  disableHoverableContent
>
<div
  bind:this={overlayEl}
  data-solus-ui
  class="click-through-shell"
  style="position:fixed;inset:0;z-index:10010"
></div>

<div class="flex h-full w-full" style="background:var(--solus-container-bg);">
  <WebLayout onAttachFile={handleAttachFile} onAttachFiles={handleAttachFiles} />
</div>

<CommandPalette bind:open={commandPaletteOpen} commands={paletteCommands} />

{#if hasMountedDirectoryPicker}
  {#await import("@solus/workspace-ui/components/pickers/DirectoryPicker.svelte")}
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

{#if hasMountedAddServer}
  {#await import("@solus/workspace-ui/components/servers/AddServerModal.svelte")}
    {#if serversStore.addServerOpen}
      <div class="lazy-modal-loading" role="status">Loading server setup…</div>
    {/if}
  {:then addServerModule}
    {@const AddServerModal = addServerModule.default}
    <AddServerModal />
  {/await}
{/if}

{#if hasMountedServerSetup}
  {#await import("./components/ServerSetupSurface.svelte")}
    {#if webState.serverSetupOpen}
      <div class="lazy-modal-loading" role="status">Loading hosts…</div>
    {/if}
  {:then serverSetupModule}
    {@const ServerSetupSurface = serverSetupModule.default}
    <ServerSetupSurface />
  {/await}
{/if}

<!-- First run only. Mounted over everything, and never lazily pre-warmed: a
     client that has already been through it must not pay for the chunk. -->
{#if !settings.onboardingCompleted}
  {#await import("@solus/workspace-ui/components/onboarding/OnboardingSurface.svelte")}
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
  {#await import("@solus/workspace-ui/components/servers/OpenProjectDialog.svelte")}
    {#if openProjectStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading projects…</div>
    {/if}
  {:then openProjectModule}
    {@const OpenProjectDialog = openProjectModule.default}
    <OpenProjectDialog
      onOpenProject={(path) =>
        void openProjectAtPath(path, openProjectStore.source !== "local")}
      onBrowse={browseForOpenProject}
      onBackgroundCloneFailure={(failure) => toasts.error(failure.title)}
      localIdentity={localGitIdentity}
    />
  {/await}
{/if}

{#if hasMountedHostOnboarding}
  {#await import("@solus/workspace-ui/components/servers/HostOnboarding.svelte")}
    {#if hostOnboardingStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading host setup…</div>
    {/if}
  {:then hostOnboardingModule}
    {@const HostOnboarding = hostOnboardingModule.default}
    <HostOnboarding />
  {/await}
{/if}

{#if hasMountedShortcuts}
  {#await import("@solus/workspace-ui/components/KeyboardShortcutsModal.svelte")}
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

{#if taskComposer && taskComposerConfig !== undefined}
  {#await import("@solus/workspace-ui/components/tasks/TaskComposer.svelte")}
    <div class="lazy-modal-loading" role="status">Loading task composer…</div>
  {:then taskComposerModule}
    {@const TaskComposer = taskComposerModule.default}
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
          await session.tasksStore.create({ ...input, projectKey: input.projectKey ?? cwd });
          toasts.success("Task created");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toasts.error(`Couldn't create task: ${message}`);
          throw error;
        }
      }}
      onCancel={() => (session.ui.taskComposer = null)}
    />
  {/await}
{/if}

{#if isDraggingFile}
  <div data-solus-ui class="drop-overlay">
    <div class="drop-overlay-content">
      <DownloadSimpleIcon size={20} weight="regular" />
      <span>Drop files to attach</span>
    </div>
  </div>
{/if}
</Tooltip.Provider>

<style>
  .lazy-modal-loading {
    position: fixed;
    inset: 0;
    z-index: 10024;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--solus-container-bg) 72%, transparent);
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
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
