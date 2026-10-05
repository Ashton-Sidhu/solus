<script lang="ts">
  import LazyDialog from "@solus/workspace-ui/components/pickers/LazyDialog.svelte";
  import { hostUpdatesStore } from "@solus/workspace-ui/contexts/updates/host-updates.store.svelte";
  import { onMount, untrack } from "svelte";
  import SessionLinkPrompts from "@solus/workspace-ui/components/session/SessionLinkPrompts.svelte";
  import { Building2 as OrganizationIcon, Download as DownloadSimpleIcon } from "@lucide/svelte";
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
  import { nextPermissionMode } from "@solus/workspace-ui/contexts/workspace/run-config";
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
  } from "@solus/workspace-ui/contexts";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { browserStore } from "@solus/workspace-ui/contexts/browser/browser.store.svelte";
  import { devicesStore } from "@solus/workspace-ui/contexts/devices/devices.store.svelte";
  import { deviceCommands, revealDeviceSurface } from "@solus/workspace-ui/components/devices/lib/device-entry";
  import { settingsOwnerCommands } from "@solus/workspace-ui/components/settings/lib/settings-commands";
  import { subscribeWatchChanges } from "@solus/workspace-ui/contexts/watches/watch-changes";
  import { subscribeWorkReviewChanges } from "@solus/workspace-ui/contexts/works/work-review-changes";
  import {
    browserRecordingCommands,
    focusLeadingComposer,
    deliverRecording,
  } from "@solus/workspace-ui/components/browser/lib/recording-actions";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { notificationsStore } from "@solus/workspace-ui/contexts/notifications/notifications.store.svelte";
  import { notificationHubStore } from "@solus/workspace-ui/contexts/notifications/notification-hub.store.svelte";
  import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";
  import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
  import { cloudOnboardingStore } from "@solus/workspace-ui/components/onboarding/cloud-onboarding.store.svelte";
  import { skipsOnboarding } from "@solus/workspace-ui/components/onboarding/lib/skip-onboarding";
  import { webState } from "./lib/web-state.svelte";
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
  import { afterPaint } from "@solus/workspace-ui/lib/after-paint";
  const commandPaletteComponent = afterPaint().then(() => import("@solus/workspace-ui/components/command-palette/CommandPalette.svelte"));
  import { activeSessionShareTarget, listenForProjectDirectory, presenceStore, seatsStore, sharesStore, uplinkStore } from "@solus/workspace-ui/contexts";
  import type { Command } from "@solus/workspace-ui/components/command-palette/lib/commands";
  import { newChatCommand } from "@solus/workspace-ui/components/command-palette/lib/new-chat-command";
  import { openChatDraft } from "@solus/workspace-ui/contexts/workspace/new-chat";
  import { workReviewPaletteCommands } from "@solus/workspace-ui/components/work/lib/work-review-commands";
  import { comboHint } from "@solus/workspace-ui/lib/keybindings/manifest";
  import { createWebAttachments } from "./components/input/lib/attachments";
  import { createProjectPicker } from "@solus/workspace-ui/components/servers/project-picker.svelte";
  import { hostSetupStore } from "@solus/workspace-ui/components/servers/host-setup.store.svelte";
  import WebLayout from "./shell/WebLayout.svelte";
  import BusyTreeConfirm from "@solus/workspace-ui/components/busy-tree/BusyTreeConfirm.svelte";
  import { WebShell } from "./shell/web-shell.svelte";

  const shell = new WebShell();
  const skipOnboarding = skipsOnboarding(window.location.search);

  const {
    settings,
    sessionSidebarStore,
    voiceModelStore,
    session,
    agent,
    keybindings,
  } = createAppCore(shell);

  const projectPicker = createProjectPicker(session);

  // A bare host has no commit identity; this client's default machine has the
  // obvious prefill, so it is read once the Open project flow is on screen.
  const identityServerId = $derived(
    openProjectStore.isOpen ? serverConnections.defaultMachineId() : null,
  );
  const localGitIdentity = $derived(
    identityServerId ? hostSetupStore.readinessByHost[identityServerId]?.git.identity ?? null : null,
  );
  $effect(() => {
    const serverId = identityServerId;
    if (!serverId) return;
    untrack(() => {
      if (!hostSetupStore.hasProbed(serverId)) void hostSetupStore.probeHost(serverId);
    });
  });
  const { attachFile: handleAttachFile, attachFiles: handleAttachFiles } = createWebAttachments(session);

  initAnalytics({
    // Undecided consent stays off until the person chooses (plans/018 §3.1).
    enabled: settings.clientAnalyticsEnabled === true,
    platform: "web-desktop",
    viewMode: "wide",
  });
  track("app_opened", {});

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

  session.lifecycle.hydrateStaticInfoFromCache();
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
    if (session.lifecycle.hydrating) return;
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
    if (session.lifecycle.hydrating) return;
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
    if (session.lifecycle.hydrating) return;
    savePersistedSessionDraftsDebounced(session.drafts.sessionDraftsSnapshot);
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
      void session.lifecycle.refreshPluginCommands(session.tabCtx.workingDirectory),
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
  let hasMountedShareDialog = $state(false);
  let shortcutsActiveScopes = $state<import("@solus/workspace-ui/lib/keybindings/types").Scope[]>([]);

  $effect(() => {
    if (sharesStore.dialog) hasMountedShareDialog = true;
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
  const permissionMode = $derived(composerRun?.permissionMode ?? "full-access");
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
      const defaultServerId = serverConnections.defaultMachineId();
      if (defaultServerId) void voiceModelStore.refresh(defaultServerId);
      const unsubProjectDirectory = listenForProjectDirectory();
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
      // Watches wait on a host and change state with no client in the loop.
      const unsubWatches = subscribeWatchChanges(session.watchesStore);
      // Review requests and decisions reach the reader on every client.
      const unsubWorkReviews = subscribeWorkReviewChanges(session.worksStore, (workId) => session.openWork(workId));
      const unsubUsage = subscribeAllHosts('usage.limitsChanged', (_serverId, { snapshots }) =>
        agent.applyUsage(snapshots),
      );
      void agent.refreshUsage();
      // A member's provider seat changes on the host, at a turn's end or in the
      // browser; the settings row and the connect card both read the store.
      const unsubSeats = seatsStore.listen();
      // Who else is on each host, and what they are looking at; the rooms arrive
      // as snapshots and every presence surface reads the one store.
      const unsubPresence = presenceStore.listen();
      // The tunnel comes up after the host has answered the link; the cloud row follows it.
      const unsubUplink = uplinkStore.listen();
      // Browser pages are host state; the pane, a recording's running time,
      // and a recording a limit stopped all follow the host's page events.
      browserStore.onRecordingSaved = (serverId, result) =>
        deliverRecording(session.leadingInput, serverId, result);
      const unsubBrowser = browserStore.subscribe();
      devicesStore.onSurfaceRequested = (serverId, payload) => revealDeviceSurface(session, serverId, payload);
      const unsubDevices = devicesStore.subscribe();
      return () => {
        unsubVoiceModel();
        unsubSessionStatuses();
        unsubProjectDirectory();
        unsubAutomations();
        unsubWatches();
        unsubWorkReviews();
        unsubUsage();
        unsubSeats();
        unsubPresence();
        unsubUplink();
        browserStore.onRecordingSaved = null;
        unsubBrowser();
        unsubDevices();
      };
    }),
  );

  // Tell the host which session or work the focused pane shows, so teammates
  // can see where this person is and jump to them.
  $effect(() => presenceStore.reportWorkspaceFocus(session));
  // And go along with a followed teammate when they move.
  $effect(() => presenceStore.syncFollow(session));

  // The notifications hub reads every source once for the page and the badge (plan 015).
  $effect(() => untrack(() => notificationHubStore.start()));

  $effect(() => {
    return untrack(() => notificationsStore.start({
      preferences: () => settings.notifications,
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

  // The nearby-host discovery toast fires from a store, which has no way to
  // reach the settings pane on its own.
  onMount(() => {
    const showConnections = () => session.showSettings("api-access");
    window.addEventListener("solus:show-connections", showConnections);
    return () => window.removeEventListener("solus:show-connections", showConnections);
  });

  onMount(() => initializeRuntime(session, sessionSidebarStore));

  // At a Solus Cloud origin, onboarding belongs to the account: it is shown
  // until the account finished or skipped it, on any browser, and again when a
  // "Get started" item reopens it at one stage. Elsewhere it is
  // this device's first run (docs/plans/cloud-onboarding.md §3.6).
  onMount(() => void cloudOnboardingStore.load());
  const showsOnboarding = $derived(
    !skipOnboarding && (cloudOnboardingStore.isCloud ? cloudOnboardingStore.isOpen : !settings.onboardingCompleted),
  );

  const detectReconnect = createReconnectDetector(webState.connectionStatus);
  $effect(() => {
    const connectionStatus = webState.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    untrack(() => {
      if (connectionStatus === 'connected') track(reconnected ? 'client_reconnected' : 'client_connected', reconnected ? { attempt: webState.connectionAttempt } : {});
      if (connectionStatus === 'connected') {
        const defaultServerId = serverConnections.defaultMachineId();
        if (defaultServerId) {
          void connectionsStore.refreshCapabilities({ serverId: defaultServerId });
        }
      }
      if (reconnected) {
        settings.setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
        refreshRuntime(session, sessionSidebarStore);
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
        ? session.projectPageScope.checkout?.serverId
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
  useKeybinding("global.new-session", () => {
    session.drafts.openSessionDraft({ freshTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session-without-task", () => {
    session.drafts.openSessionDraft({ withoutTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-chat", () => openChatDraft(session, "keybinding"));
  useKeybinding("global.new-session-in-task", () =>
    void session.drafts.openSessionDraft({ via: "keybinding" }),
  );
  // Starts a new task in the active session's project. The tasks page
  // binds this id too, so this handler stands down while that page is up.
  useKeybinding(
    "global.new-task",
    () => {
      const context = session.taskCreationContext;
      if (context) void session.startNewTask(context.serverId, context.projectKey, true);
    },
    {
      enabled: () => !!session.tasksProjectCwd && !session.router.at("tasks"),
    },
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
    session.setPermissionMode(nextPermissionMode(permissionMode), composerSourceId, "keybinding");
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) sessionSidebarStore.closeTabs([activeTabId], "keybinding");
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
  useKeybinding("global.toggle-notifications", () => session.toggleNotifications("keybinding"));
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
  // Sharing (docs/plans/multiplayer-sharing.md §4.1): the active session, once it has one.
  const shareTarget = $derived(activeSessionShareTarget(session));
  useKeybinding("global.share", () => { if (shareTarget) sharesStore.open(shareTarget); });
  // The window's organization (organization-scope §2): the palette opens on
  // its list, and choosing one filters what this window shows beside Local.
  let paletteInitialPage = $state<{ id: string; title: string } | null>(null);
  useKeybinding("global.switch-organization", () => {
    paletteInitialPage = { id: "switch-organization", title: "Switch organization" };
    commandPaletteOpen = true;
  }, { enabled: () => serversStore.organizations.length > 0 });
  const paletteCommands = $derived.by((): Command[] => [
    ...workReviewPaletteCommands(session),
    ...(shareTarget ? [{
      id: "share-session", label: "Share…", group: "General",
      hint: comboHint("global.share"), keywords: ["share", "access", "link", "team", "guest"],
      run: () => sharesStore.open(shareTarget),
    }] : []),
    ...(serversStore.organizations.length > 0 ? [{
      id: "switch-organization", label: "Switch organization…", group: "General", icon: OrganizationIcon,
      hint: comboHint("global.switch-organization"), keywords: ["organization", "org", "team", "workspace", "cloud"],
      children: serversStore.organizations.map((organization) => ({
        id: `switch-organization:${organization.organizationId}`,
        label: organization.name,
        group: "Organizations",
        icon: OrganizationIcon,
        hint: organization.isActive ? "Active" : organization.policy.allowsPersonalHosts ? undefined : "Personal computers not allowed",
        keywords: ["organization", "org", organization.organizationId],
        run: () => serversStore.selectOrganization(organization.organizationId),
      })),
    }] : []),
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
      id: "new-project",
      label: "New project…",
      group: "General",
      keywords: ["create", "folder", "start", "empty", "git init", "website", "app"],
      run: () => projectPicker.startOpenProject({ sourceId: composerSourceId, source: "new" }),
    },
    {
      id: "new-session",
      label: "New session",
      group: "General",
      hint: comboHint("global.new-session"),
      keywords: ["create", "chat", "tab"],
      run: () => session.drafts.openSessionDraft({ freshTask: true, via: "palette" }),
    },
    {
      id: "new-session-in-task",
      label: "New session in task",
      group: "General",
      hint: comboHint("global.new-session-in-task"),
      keywords: ["create", "chat", "tab", "task"],
      run: () => session.drafts.openSessionDraft({ via: "palette" }),
    },
    {
      id: "new-session-without-task",
      label: "New session without task",
      group: "General",
      hint: comboHint("global.new-session-without-task"),
      keywords: ["create", "chat", "tab", "no task"],
      run: () =>
        session.drafts.openSessionDraft({ withoutTask: true, via: "palette" }),
    },
    newChatCommand(session),
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
      id: "notifications",
      label: "Open notifications",
      group: "View",
      hint: comboHint("global.toggle-notifications"),
      keywords: ["inbox", "assigned", "review request", "mentions", "alerts"],
      run: () => session.openNotifications("palette"),
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
    ...browserRecordingCommands(() => focusLeadingComposer(session.router)),
    ...deviceCommands(session),
    ...settingsOwnerCommands(session),
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
    session.config.switchActiveAgent(next.id, composerSourceId, via);
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
  <WebLayout onAttachFile={handleAttachFile} />
</div>

{#await commandPaletteComponent then module}
  {@const CommandPalette = module.default}
  <CommandPalette bind:open={commandPaletteOpen} bind:initialPage={paletteInitialPage} commands={paletteCommands} />
{:catch}
  <p role="alert">Could not load the command palette.</p>
{/await}
<BusyTreeConfirm />
{#if hasMountedShareDialog}
  {#await import("@solus/workspace-ui/components/sharing/ShareDialog.svelte") then module}
    {@const ShareDialog = module.default}
    <ShareDialog />
  {:catch}
    {#if sharesStore.dialog}
      <p role="alert">Could not load the share dialog.</p>
    {/if}
  {/await}
{/if}

{#if projectPicker.directoryPickerApi}
  {@const directoryPickerApi = projectPicker.directoryPickerApi}
  <LazyDialog
    open={projectPicker.directoryPickerOpen}
    load={() => import("@solus/workspace-ui/components/pickers/DirectoryPicker.svelte")}
    placeholder="Filter folders"
    centered
    class="h-[clamp(28rem,65vh,43rem)] max-h-none w-[clamp(42rem,72vw,64rem)]"
    onclose={projectPicker.handleDirectoryPickerClose}
  >
    {#snippet children(DirectoryPicker)}
      <DirectoryPicker
        bind:open={projectPicker.directoryPickerOpen}
        onClose={projectPicker.handleDirectoryPickerClose}
        onSelect={projectPicker.handleDirectorySelected}
        initialPath={projectPicker.directoryPickerInitialPath}
        title={projectPicker.directoryPickerTitle}
        actionLabel={projectPicker.directoryPickerAction}
        api={directoryPickerApi}
        hostLabel={projectPicker.directoryPickerHostLabel}
        serverId={projectPicker.directoryPickerServerId}
      />
    {/snippet}
  </LazyDialog>
{/if}

<LazyDialog
  open={serversStore.addServerOpen}
  load={() => import("@solus/workspace-ui/components/servers/AddServerModal.svelte")}
  title="Add server"
  class="w-[28rem]"
  onclose={() => serversStore.closeAddServer()}
>
  {#snippet children(AddServerModal)}
    <AddServerModal />
  {/snippet}
</LazyDialog>

<LazyDialog
  open={webState.serverSetupOpen}
  load={() => import("./components/ServerSetupSurface.svelte")}
  title="Hosts"
  class="w-[26rem]"
  onclose={() => webState.closeServerSetup()}
>
  {#snippet children(ServerSetupSurface)}
    <ServerSetupSurface />
  {/snippet}
</LazyDialog>

<!-- First run only. Mounted over everything, and never lazily pre-warmed: a
     client that has already been through it must not pay for the chunk. -->
{#if !skipOnboarding && cloudOnboardingStore.isAwaitingAccount}
  <!-- At a cloud origin, until the account says whether onboarding is due: an
       opaque cover, not the workspace, so the draft composer never flashes
       before onboarding. Same composite as the onboarding surface. -->
  <div
    class="fixed inset-0 z-[10005]"
    style="background: linear-gradient(var(--background), var(--background)) var(--solus-edge-bg)"
  ></div>
{:else if showsOnboarding}
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

<LazyDialog
  open={openProjectStore.isOpen}
  load={() => import("@solus/workspace-ui/components/servers/OpenProjectDialog.svelte")}
  title="Open project"
  class="w-[42rem]"
  onclose={() => openProjectStore.close()}
>
  {#snippet children(OpenProjectDialog)}
    <OpenProjectDialog
      onOpenProject={(path) =>
        void projectPicker.openProjectAtPath(path, openProjectStore.source)}
      onBrowse={projectPicker.browseForOpenProject}
      onBackgroundCloneFailure={(failure) => toasts.error(failure.title)}
      localIdentity={localGitIdentity}
    />
  {/snippet}
</LazyDialog>

<LazyDialog
  open={hostOnboardingStore.isOpen}
  load={() => import("@solus/workspace-ui/components/servers/HostOnboarding.svelte")}
  title="Set up host"
  centered
  class="min-h-[26rem] w-[58.75rem]"
  onclose={() => hostOnboardingStore.close()}
>
  {#snippet children(HostOnboarding)}
    <HostOnboarding />
  {/snippet}
</LazyDialog>

<LazyDialog
  open={shortcutsModalOpen}
  load={() => import("@solus/workspace-ui/components/KeyboardShortcutsModal.svelte")}
  placeholder="Search shortcuts…"
  centered
  class="max-h-[70vh] w-[41.25rem]"
  onclose={() => (shortcutsModalOpen = false)}
>
  {#snippet children(KeyboardShortcutsModal)}
    <KeyboardShortcutsModal
      bind:open={shortcutsModalOpen}
      activeScopes={shortcutsActiveScopes}
    />
  {/snippet}
</LazyDialog>

<SessionLinkPrompts />

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
