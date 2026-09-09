<script lang="ts">
  import { hostUpdatesStore } from "@solus/workspace-ui/contexts/updates/host-updates.store.svelte";
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
  import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
  import {
    materializeTabs,
    reconcileReloadLocation,
  } from "@solus/workspace-ui/contexts/workspace/session-bootstrap";
  import {
    createReconnectDetector,
    initializeRuntime,
    refreshRuntime,
  } from "@solus/workspace-ui/contexts/app/runtime-boot";
  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { subscribe } from "@solus/client-core/connection-state";
  import {
    connectionsStore,
    parseRoute,
    serversStore,
    runtime,
  } from "@solus/workspace-ui/contexts";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { notificationsStore } from "@solus/workspace-ui/contexts/notifications/notifications.store.svelte";
  import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";
  import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
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
  import { createWebAttachments } from "./components/input/lib/attachments";
  import { createWebProjectPicker } from "./components/projects/lib/project-picker.svelte";
  import WebLayout from "./shell/WebLayout.svelte";
  import { WebShell } from "./shell/web-shell.svelte";

  const shell = new WebShell();

  const {
    settings,
    projectConfigStore,
    sessionSidebarStore,
    voiceModelStore,
    pullRequests,
    session,
    agent,
    keybindings,
  } = createAppCore(shell);

  const projectPicker = createWebProjectPicker(session);
  const { attachFile: handleAttachFile, attachFiles: handleAttachFiles } = createWebAttachments(session);

  const taskComposer = $derived(session.ui.taskComposer);
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
      ? projectConfigStore.configFor(taskComposerServerId, taskComposer.projectKey)
      : undefined,
  );
  const taskComposerProvider = $derived(
    taskComposerConfig?.taskProvider ?? "local",
  );
  const taskComposerTasks = $derived(
    taskComposer ? session.tasksStore.tasksForProject(taskComposer.projectKey) : [],
  );
  const taskComposerEpics = $derived(
    taskComposerTasks.filter((task) => task.kind === "epic"),
  );
  const taskComposerLabels = $derived(
    Array.from(new Set(taskComposerTasks.flatMap((task) => task.labels))).sort(),
  );

  $effect(() => {
    if (!taskComposer || !taskComposerHost) return;
    const host = taskComposerHost;
    const cwd = taskComposer.projectKey;
    untrack(() => void projectConfigStore.load(host, cwd));
  });

  const initialLayout = shell.layout;

  initAnalytics({
    enabled: settings.analyticsEnabled,
    platform: initialLayout === "mobile" ? "web-mobile" : "web-desktop",
    viewMode: initialLayout,
  });
  track("app_opened", {});

  $effect(() => {
    const layout = shell.layout;
    registerSuperProps({
      view_mode: layout,
      platform: layout === "mobile" ? "web-mobile" : "web-desktop",
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
  onMount(() => {
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

  let shortcutsModalOpen = $state(false);
  let commandPaletteOpen = $state(false);
  let hasMountedDirectoryPicker = $state(false);
  let hasMountedShortcuts = $state(false);
  let hasMountedOpenProject = $state(false);
  let hasMountedHostOnboarding = $state(false);
  let hasMountedAddServer = $state(false);
  let hasMountedServerSetup = $state(false);
  let shortcutsActiveScopes = $state<import("@solus/workspace-ui/lib/keybindings/types").Scope[]>([]);

  $effect(() => {
    if (projectPicker.directoryPickerOpen) hasMountedDirectoryPicker = true;
    if (shortcutsModalOpen) hasMountedShortcuts = true;
    if (openProjectStore.isOpen) hasMountedOpenProject = true;
    if (hostOnboardingStore.isOpen) hasMountedHostOnboarding = true;
    if (serversStore.addServerOpen) hasMountedAddServer = true;
    if (webState.serverSetupOpen) hasMountedServerSetup = true;
  });

  const activeTabId = $derived(session.activeTabId);
  // Keyboard next/prev follows the order WebLayout actually renders: raw tabOrder.
  const visualTabOrder: string[] = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  const composerSourceId = $derived(session.focusedSourceId ?? undefined);
  const composerRun = $derived(
    composerSourceId ? session.runFor(composerSourceId) : session.activeSession?.run,
  );
  const composerSession = $derived(
    composerSourceId ? session.sessionFor(composerSourceId) : session.activeSession,
  );
  const isRunning = $derived(composerSession?.status === "running" || composerSession?.status === "connecting");
  const permissionMode = $derived(composerRun?.permissionMode ?? "auto");
  const composerMetadata = $derived(
    agent.metadata[composerRun?.provider ?? settings.activeAgent] ??
      agent.activeMetadata,
  );

  onMount(() => {
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
    untrack(() => void webPushState.syncEnabled(enabled).catch((error) =>
      toasts.error(error instanceof Error ? error.message : "Notifications could not be updated"),
    ));
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
  onMount(() => {
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

  onMount(() => initializeRuntime(session, sessionSidebarStore));

  const detectReconnect = createReconnectDetector(webState.connectionStatus);
  $effect(() => {
    const connectionStatus = webState.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    untrack(() => {
      if (connectionStatus === 'connected') track(reconnected ? 'client_reconnected' : 'client_connected', reconnected ? { attempt: webState.connectionAttempt } : {});
      if (connectionStatus === 'connected') {
        const defaultServerId = serverConnections.defaultServerId();
        if (defaultServerId) {
          void connectionsStore.refreshCapabilities({ serverId: defaultServerId });
        }
      }
      if (reconnected) {
        settings.setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
        refreshRuntime(session, sessionSidebarStore);
        pullRequests.checks.reportActivity(
          session.apiForContext(session.ctx), session.ctx,
          session.router.at("review") || session.router.at("prReview"), runtime.isWindowForeground,
        );
      }
    });
  });

  // ── Keybindings ──────────────────────────────────────────────────────────
  installGlobalDispatcher(keybindings, () => settings.keybindings);

  useKeybinding("global.select-project", () => {
    projectPicker.startOpenProject({ sourceId: composerSourceId });
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
    void session.openSessionDraft({ via: "keybinding" }),
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
    void window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.session-picker-j", () =>
    void window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
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
    const targetStatus = targetTabId ? session.sessionFor(targetTabId)?.status : undefined;
    if (targetStatus === "running" || targetStatus === "connecting") return;
    window.dispatchEvent(
      new CustomEvent("solus:toggle-session-settings-picker", {
        detail: { tabId: targetTabId },
      }),
    );
  });
  useKeybinding("global.toggle-diff-panel", () =>
    void window.dispatchEvent(new CustomEvent("solus:toggle-diff-panel")),
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
  useKeybinding("global.check-for-updates", () => void hostUpdatesStore.checkAll());
  const paletteCommands = $derived.by((): Command[] => [
    {
      id: 'check-for-updates', label: 'Check for updates', group: 'General',
      hint: comboHint('global.check-for-updates'), keywords: ['update', 'version', 'provider'],
      run: () => void hostUpdatesStore.checkAll(),
    },
    {
      id: "open-project",
      label: "Open project…",
      group: "General",
      hint: comboHint("global.select-project"),
      keywords: ["folder", "directory", "repository", "host"],
      run: () => projectPicker.startOpenProject({ sourceId: composerSourceId }),
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

  onMount(() => {
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
      await handleAttachFiles(Array.from(files));
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

{#if hasMountedDirectoryPicker && projectPicker.directoryPickerApi}
  {#await import("@solus/workspace-ui/components/pickers/DirectoryPicker.svelte")}
    {#if projectPicker.directoryPickerOpen}
      <div class="lazy-modal-loading" role="status">Loading folders…</div>
    {/if}
  {:then directoryPickerModule}
    {@const DirectoryPicker = directoryPickerModule.default}
    <DirectoryPicker
      bind:open={projectPicker.directoryPickerOpen}
      onClose={projectPicker.handleDirectoryPickerClose}
      onSelect={projectPicker.handleDirectorySelected}
      initialPath={projectPicker.directoryPickerInitialPath}
      title={projectPicker.directoryPickerTitle}
      actionLabel={projectPicker.directoryPickerAction}
      api={projectPicker.directoryPickerApi}
      hostLabel={projectPicker.directoryPickerHostLabel}
      serverId={projectPicker.directoryPickerServerId}
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
        void projectPicker.openProjectAtPath(path, openProjectStore.source !== "local")}
      onBrowse={projectPicker.browseForOpenProject}
      onBackgroundCloneFailure={(failure) => toasts.error(failure.title)}
      localIdentity={projectPicker.localGitIdentity}
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
      workingDirectory={taskComposer.workingDirectory}
      provider={settings.activeAgent}
      onCreate={async (input) => {
        const cwd = taskComposer?.projectKey;
        if (!cwd) return;
        try {
          await session.tasksStore.create({ ...input, projectKey: cwd });
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
      <DownloadSimpleIcon size={20} />
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
