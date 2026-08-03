<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { DownloadSimpleIcon } from "phosphor-svelte";
  import { setPopoverLayer } from "@renderer/components/popoverLayer.svelte";
  import {
    savePersistedTabs,
    saveDraftsDebounced,
    flushDrafts,
    type PersistedTabs,
  } from "@renderer/contexts/workspace/tab-persistence";
  import { setupAgentEvents } from "@renderer/hooks/agentEvents.svelte";
  import { materializeTabs } from "@renderer/contexts/workspace/session-bootstrap";
  import { loadServers, LOCAL_SERVER_ID } from "@client-core/server-registry";
  import {
    createReconnectDetector,
    initializeRuntime,
  } from "@renderer/contexts/app/runtime-boot";
  import { createAppCore } from "@renderer/contexts/app/app-core";
  import { subscribe } from "@client-core/connection-state";
  import { connectionsStore, serversStore, toasts as rendererToasts, runtime } from "@renderer/contexts";
  import { serverConnections } from "@client-core/server-connections";
  import { openProjectStore } from "@renderer/components/servers/open-project.store.svelte";
  import { hostOnboardingStore } from "@renderer/components/servers/host-onboarding.store.svelte";
  import { retargetSessionHost, isRunOnHostLocked } from "@renderer/components/servers/run-on";
  import { Toaster } from "@renderer/components/ui/sonner/index.js";
  import { webState } from "./lib/web-state.svelte";
  import {
    useKeybinding,
    installGlobalDispatcher,
  } from "@renderer/lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import {
    identifyInstallation,
    initAnalytics,
    registerSuperProps,
    track,
  } from "@renderer/lib/analytics";
  import { invalidateHomeCache } from "@renderer/components/layout/NewTabHome.svelte";
  import * as Tooltip from "@renderer/components/ui/tooltip";
  import WebLayout from "./components/WebLayout.svelte";

  const {
    settings,
    windowCtx,
    planStore,
    runStore,
    sessionSidebarStore,
    session,
    agent,
    keybindings,
  } = createAppCore();

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

  // Persist open-tab snapshot to localStorage so it survives refresh and cold restarts.
  // Reads only the persisted fields, so it won't re-run on message streaming.
  // Skipped while bootstrap is in progress so an empty initial state doesn't clobber saved data.
  $effect(() => {
    if (session.hydrating) return;
    const savedServers = loadServers();
    const tabs = session.tabOrder
      .filter((id) => session.tabs[id])
      .map((tabId) => {
        const tab = session.tabs[tabId];
        const sess = session.sessionFor(tabId);
        return {
          tabId,
          title: tab.title ?? "New Tab",
          titleCustom: tab.titleCustom ?? false,
          serverId: sess?.serverId ?? LOCAL_SERVER_ID,
          serverInstallationId: savedServers.find(
            (server) => server.id === sess?.serverId,
          )?.installationId,
          agentSessionId: sess?.agentSessionId ?? null,
          provider: sess?.provider ?? null,
          workingDirectory: sess?.workingDirectory ?? session.globalDefaults.workingDirectory,
          additionalDirs: sess ? [...sess.additionalDirs] : [],
          gitContext: sess?.gitContext ? { ...sess.gitContext } : null,
          worktreeBaseBranch: sess?.worktreeBaseBranch ?? null,
          modelConfig: sess ? { ...sess.modelConfig } : { ...session.globalDefaults.modelConfig },
          permissionMode: sess?.permissionMode ?? session.globalDefaults.permissionMode,
          hasUnread: tab.hasUnread ?? false,
        };
      });
    const snapshot: PersistedTabs = {
      version: 1,
      activeTabId: session.activeTabId,
      tabOrder: [...session.tabOrder],
      tabs,
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
      const tab = session.tabs[tabId];
      if (tab) tabs[tabId] = tab.input.text;
    }
    saveDraftsDebounced({ activeInputText: session.activeInput.text, tabs });
  });

  // Flush pending drafts before the window unloads so the latest keystrokes survive.
  $effect(() => {
    const flush = () => flushDrafts();
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  });

  // Slash command discovery is backend-scoped, so refresh when the active agent changes.
  // untrack the directory so this doesn't re-run on every session mutation.
  $effect(() => {
    void settings.activeAgent;
    void session.refreshPluginCommands(untrack(() => session.tabCtx.workingDirectory));
  });

  setupAgentEvents(session);

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();

  const TOAST_HOTKEY = ["altKey", "shiftKey", "KeyT"];

  let directoryPickerOpen = $state(false);
  let directoryPickerNewTab = $state(false);
  let directoryPickerTargetTabId = $state<string | undefined>(undefined);
  // Set when a caller names the host to browse — the "Run on" picker and the
  // Open project flow both browse a host no tab points at yet.
  let directoryPickerServerIdOverride = $state<string | undefined>(undefined);
  let directoryPickerRequireWorktree = $state(false);
  // "Choose location…" in the Open project flow borrows the same browser; its
  // selection is handed back to that flow instead of retargeting a tab here.
  let directoryPickerForOpenProject = $state(false);
  let shortcutsModalOpen = $state(false);
  let hasMountedDirectoryPicker = $state(false);
  let hasMountedShortcuts = $state(false);
  let hasMountedOpenProject = $state(false);
  let hasMountedHostOnboarding = $state(false);
  let hasMountedAddServer = $state(false);
  let hasMountedServerSetup = $state(false);
  /** Offered as the prefill when a remote host has no commit identity of its own. */
  let localGitIdentity = $state<{ name: string; email: string } | null>(null);
  let shortcutsActiveScopes = $state<import("@renderer/lib/keybindings/types").Scope[]>([]);

  $effect(() => {
    if (directoryPickerOpen) hasMountedDirectoryPicker = true;
    if (shortcutsModalOpen) hasMountedShortcuts = true;
    if (openProjectStore.isOpen) hasMountedOpenProject = true;
    if (hostOnboardingStore.isOpen) hasMountedHostOnboarding = true;
    if (serversStore.addServerOpen) hasMountedAddServer = true;
    if (webState.serverSetupOpen) hasMountedServerSetup = true;
  });

  // A bare host has no commit identity; this machine's is the obvious prefill.
  // On web "local" resolves to the connected server, which plays that role.
  $effect(() => {
    if (!openProjectStore.isOpen || localGitIdentity || !serverConnections.connectionFor()) return;
    void serverConnections
      .apiFor(LOCAL_SERVER_ID)
      .setupHostReadiness()
      .then((readiness) => (localGitIdentity = readiness.git.identity))
      .catch(() => {});
  });

  const activeTabId = $derived(session.activeTabId);
  const isRunning = $derived.by(() => {
    const s = session.activeSession?.status;
    return s === "running" || s === "connecting";
  });

  // Keyboard next/prev follows the order WebLayout actually renders: raw tabOrder.
  const visualTabOrder: string[] = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  const permissionMode = $derived(
    session.activeSession?.permissionMode ?? "auto",
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
  // Browse the host the tab actually runs on; an explicit override wins.
  const directoryPickerServerId = $derived(
    directoryPickerServerIdOverride ??
      (directoryPickerTargetTabId
        ? session.sessionFor(directoryPickerTargetTabId)?.serverId
        : session.activeSession?.serverId) ??
      LOCAL_SERVER_ID,
  );
  // apiFor() opens the connection as a side effect, so only reach for it while
  // the picker is actually on screen. On web, LOCAL resolves to the primary.
  const directoryPickerApi = $derived(
    !directoryPickerOpen || directoryPickerServerId === LOCAL_SERVER_ID
      ? window.solus
      : (serverConnections.apiFor(directoryPickerServerId) as typeof window.solus),
  );
  const directoryPickerHostLabel = $derived.by(() => {
    const host = serversStore.hostFor(directoryPickerServerId);
    return host && !host.local ? host.label : undefined;
  });
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = directoryPickerTargetTabId
      ? session.sessionFor(directoryPickerTargetTabId)
      : null;
    if (targetSession?.serverId === directoryPickerServerId) {
      return targetSession.workingDirectory;
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

  $effect(() => {
    const events = serverConnections.eventsFor();
    const unsubRun = events.subscribe('run.statusChanged', (status) => runStore.apply(status));
    const unsubUsage = events.subscribe('usage.limitsChanged', ({ snapshots }) =>
      agent.applyUsage(snapshots),
    );
    void agent.refreshUsage();
    return () => {
      unsubRun();
      unsubUsage();
    };
  });

  $effect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId;
      if (!sessionId) return;
      const tabId = session.tabOrder.find((candidate) => {
        const candidateSession = session.sessionFor(candidate);
        return candidateSession?.agentSessionId === sessionId ||
          candidateSession?.forkedFromSessionId === sessionId;
      });
      if (tabId) session.selectTab(tabId);
      requestInputFocus();
    };
    window.addEventListener("solus:focus-session", handler);
    return () => window.removeEventListener("solus:focus-session", handler);
  });

  $effect(() => {
    initializeRuntime(session, sessionSidebarStore);
  });

  $effect(() => {
    void connectionsStore.refreshCapabilities();
  });

  const detectReconnect = createReconnectDetector(webState.connectionStatus);
  $effect(() => {
    const connectionStatus = webState.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    if (connectionStatus === 'connected') track(reconnected ? 'client_reconnected' : 'client_connected', reconnected ? { attempt: webState.connectionAttempt } : {});
    if (reconnected) {
      settings.setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
      initializeRuntime(session, sessionSidebarStore);
      void connectionsStore.refreshCapabilities();
      session.prsStore.reportChecksActivity(session.ctx);
    }
  });

  // ── Keybindings ──────────────────────────────────────────────────────────
  installGlobalDispatcher(keybindings, () => settings.keybindings);

  useKeybinding("global.select-project", () => {
    if (isRunning) return;
    directoryPickerOpen = true;
  });
  useKeybinding("global.open-host-project", () => {
    if (!isRunning) startOpenProject();
  });
  useKeybinding("global.new-tab", () => session.createTab(undefined, { via: "keybinding" }));
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
        (modes.indexOf(permissionMode as (typeof modes)[number]) + 1) %
          modes.length
      ];
    session.setPermissionMode(next, undefined, "keybinding");
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
    const models = agent.activeMetadata?.models;
    if (!models || models.length === 0) return;
    const defaultModel = agent.activeMetadata?.defaultModel;
    const currentModel =
      session.activeSession?.modelConfig.modelId ??
      session.activeSession?.sessionModel ??
      defaultModel ??
      models[0].id;
    const idx = models.findIndex((m) => m.id === currentModel);
    session.updateModelConfig({
      modelId: models[((idx === -1 ? 0 : idx) + 1) % models.length].id,
    }, undefined, "keybinding");
  });
  useKeybinding("global.toggle-reasoning", () => {
    if (isRunning) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-session-settings-picker"));
  });
  useKeybinding("global.toggle-diff-panel", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-diff-panel")),
  );
  useKeybinding("global.toggle-plans", () => session.togglePlansGallery("keybinding"));
  useKeybinding("global.toggle-folio", () => session.toggleFolioGallery("keybinding"));
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.toggle-worktree", () => session.toggleWorktreeMode(undefined, "keybinding"));
  useKeybinding("global.switch-worktree", () => {
    if (session.activeSession?.agentSessionId) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding("global.show-shortcuts", () => {
    shortcutsActiveScopes = keybindings.activeScopes();
    shortcutsModalOpen = true;
  });

  $effect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          tabId?: string;
          serverId?: string;
          requireWorktree?: boolean;
        }>
      ).detail;
      const targetTabId = detail?.tabId;
      const tab = targetTabId ? session.tabs[targetTabId] : null;
      const opensInNewTab = tab?.sessionId != null;
      directoryPickerNewTab = opensInNewTab;
      directoryPickerTargetTabId = opensInNewTab ? undefined : targetTabId;
      directoryPickerServerIdOverride = detail?.serverId;
      directoryPickerRequireWorktree = detail?.requireWorktree === true;
      directoryPickerForOpenProject = false;
      directoryPickerOpen = true;
    };
    const openProjectHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string } | undefined>)
        .detail;
      startOpenProject({ tabId: detail?.tabId });
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
    invalidateHomeCache();
    if (directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir);
      return;
    }
    const targetTabId = directoryPickerTargetTabId;
    const overrideServerId = directoryPickerServerIdOverride;
    const requireWorktree = directoryPickerRequireWorktree;
    directoryPickerServerIdOverride = undefined;
    directoryPickerRequireWorktree = false;
    if (directoryPickerNewTab) {
      directoryPickerNewTab = false;
      const newTabId = await session.createTab(dir);
      if (overrideServerId) {
        moveTabToHost(newTabId, overrideServerId, dir, { requireWorktree });
      }
    } else if (
      targetTabId &&
      overrideServerId &&
      session.sessionFor(targetTabId)?.serverId !== overrideServerId
    ) {
      // The folder lives on another host, so the tab has to move there too —
      // setBaseDirectory alone would point the current host at a missing path.
      moveTabToHost(targetTabId, overrideServerId, dir, { requireWorktree });
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
    directoryPickerRequireWorktree = false;
    // Cancelling a browse that the Open project flow started returns to that
    // flow, on the step it left — not to an empty screen.
    if (directoryPickerForOpenProject) {
      directoryPickerForOpenProject = false;
      openProjectStore.back();
      return;
    }
    requestInputFocus();
  }

  function moveTabToHost(
    tabId: string,
    serverId: string,
    path: string,
    options: { requireWorktree?: boolean } = {},
  ) {
    retargetSessionHost({
      workspace: session,
      tabId,
      serverId,
      isLocalHost: serverId === LOCAL_SERVER_ID,
      path,
      requireWorktree: options.requireWorktree,
    });
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

    // A started session keeps its folder — the project opens beside it instead.
    const reusableTabId =
      tabId &&
      session.tabs[tabId] &&
      !isRunOnHostLocked(session.sessionFor(tabId))
        ? tabId
        : null;
    const targetTabId = reusableTabId ?? (await session.createTab(path));
    moveTabToHost(targetTabId, serverId, path);
    requestInputFocus({ tabId: targetTabId });

    // A clone that authenticated as nobody works right up until the push, which
    // is 25 minutes away at PR time. Say so now, without blocking the session.
    if (pushNote) {
      const onboardingHost = { id: serverId, label: hostLabel || serverId };
      rendererToasts.info(pushNote, {
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
    rendererToasts.success(
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
    directoryPickerRequireWorktree = false;
    directoryPickerOpen = true;
  }

  /** A folder chosen for the flow: opened as-is, or used as the clone's parent. */
  async function finishBrowsedOpenProject(dir: string) {
    directoryPickerForOpenProject = false;
    directoryPickerServerIdOverride = undefined;
    directoryPickerRequireWorktree = false;
    openProjectStore.back();
    if (openProjectStore.source === "local") {
      await openProjectAtPath(dir, false);
      return;
    }
    const clonedPath = await openProjectStore.cloneInto(dir);
    if (clonedPath) await openProjectAtPath(clonedPath, true);
  }

  async function handleAttachFile(tabId?: string) {
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
  }

  async function cycleAgentProvider(via: "click" | "keybinding" | "palette" = "click") {
    const enabledAgents = agent.agents.filter(
      (candidate) => agent.metadata[candidate.id]?.available === true,
    );
    if (enabledAgents.length <= 1) return;

    const currentAgent =
      session.activeSession?.provider ?? settings.activeAgent;
    const idx = enabledAgents.findIndex(
      (candidate) => candidate.id === currentAgent,
    );
    const next = enabledAgents[(idx + 1) % enabledAgents.length];
    session.switchActiveAgent(next.id, undefined, via);
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
      const attachments = await (window.solus as any).uploadFiles(Array.from(files));
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

<svelte:window onkeydowncapture={rendererToasts.handleKeydown} />

<Tooltip.Provider
  delayDuration={450}
  skipDelayDuration={300}
  disableHoverableContent
>
<Toaster
  theme={settings.isDark ? "dark" : "light"}
  position={runtime.isMobileViewport ? "top-center" : "top-right"}
  offset={{ top: "1rem", right: "1rem" }}
  visibleToasts={1}
  duration={6000}
  hotkey={TOAST_HOTKEY}
/>

<div
  bind:this={overlayEl}
  data-solus-ui
  class="click-through-shell"
  style="position:fixed;inset:0;z-index:10010"
></div>

<div class="flex h-full w-full" style="background:var(--solus-container-bg);">
  <WebLayout onAttachFile={handleAttachFile} />
</div>

{#if hasMountedDirectoryPicker}
  {#await import("@renderer/components/pickers/DirectoryPicker.svelte")}
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
  {#await import("@renderer/components/servers/AddServerModal.svelte")}
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

{#if hasMountedOpenProject}
  {#await import("@renderer/components/servers/OpenProjectDialog.svelte")}
    {#if openProjectStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading projects…</div>
    {/if}
  {:then openProjectModule}
    {@const OpenProjectDialog = openProjectModule.default}
    <OpenProjectDialog
      onOpenProject={(path) =>
        void openProjectAtPath(path, openProjectStore.source !== "local")}
      onBrowse={browseForOpenProject}
      onBackgroundCloneFailure={(failure) => rendererToasts.error(failure.title)}
      localIdentity={localGitIdentity}
    />
  {/await}
{/if}

{#if hasMountedHostOnboarding}
  {#await import("@renderer/components/servers/HostOnboarding.svelte")}
    {#if hostOnboardingStore.isOpen}
      <div class="lazy-modal-loading" role="status">Loading host setup…</div>
    {/if}
  {:then hostOnboardingModule}
    {@const HostOnboarding = hostOnboardingModule.default}
    <HostOnboarding />
  {/await}
{/if}

{#if hasMountedShortcuts}
  {#await import("@renderer/components/KeyboardShortcutsModal.svelte")}
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

{#if isDraggingFile}
  <div data-solus-ui class="drop-overlay">
    <div class="drop-overlay-content">
      <DownloadSimpleIcon size={24} weight="regular" />
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
    font-size: 0.75rem;
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
