import { onMount, untrack } from "svelte";

import {
  projectsStore,
  serversStore,
  atlassianStore,
  connectRequestStore,
  seatsStore,
  presenceStore,
  uplinkStore,
  parseRoute,
  runtime,
  listenForProjectDirectory,
  hosts,
} from "@solus/workspace-ui/contexts";
import { snapshotPersistedTabs } from "@solus/workspace-ui/contexts/workspace/tab-snapshot";

import { toasts } from "@solus/workspace-ui/lib/toasts";


import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
import { materializeTabs } from "@solus/workspace-ui/contexts/workspace/session-bootstrap";

import { serverConnections } from "@solus/client-core/server-connections";

import { subscribeAllHosts } from "@solus/client-core/host-events";
import { localApi } from "@solus/client-core/local-api";
import { notificationsStore } from "@solus/workspace-ui/contexts/notifications/notifications.store.svelte";
import { notificationHubStore } from "@solus/workspace-ui/contexts/notifications/notification-hub.store.svelte";
import { browserStore } from "@solus/workspace-ui/contexts/browser/browser.store.svelte";
import { devicesStore } from "@solus/workspace-ui/contexts/devices/devices.store.svelte";
import { revealDeviceSurface } from "@solus/workspace-ui/components/devices/lib/device-entry";
import { subscribeWorkReviewChanges } from "@solus/workspace-ui/contexts/works/work-review-changes";
import { deliverRecording } from "@solus/workspace-ui/components/browser/lib/recording-actions";

import { connectionState } from "@solus/client-core/connection-state";
import {
  createReconnectDetector,
  initializeRuntime,
  refreshRuntime,
  refreshTheme,
} from "@solus/workspace-ui/contexts/app/runtime-boot";
import {
  savePersistedTabsDebounced,
  flushPersistedTabs,
  savePersistedSessionDraftsDebounced,
  flushPersistedSessionDrafts,
  patchActiveDraft,
  flushDrafts,
  type PersistedTabs,
} from "@solus/workspace-ui/contexts/workspace/tab-persistence";

import { KEYBINDINGS } from "@solus/workspace-ui/lib/keybindings/manifest";
import {
  defaultCombo,
  eventMatches,
} from "@solus/workspace-ui/lib/keybindings/match";

import {
  dictation,
  isDictationTarget,
} from "@solus/workspace-ui/lib/dictation.svelte";

import {
  identifyInstallation,
  initAnalytics,
  registerSuperProps,
  track,
} from "@solus/workspace-ui/lib/analytics";
import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
type DesktopAppCore = ReturnType<typeof createAppCore>;
export function installDesktopRuntime(core: DesktopAppCore) {
  const {
    settings,
    sessionEnvironmentStore,
    pullRequests,
    session,
    sessionSidebarStore,
  } = core;

  // Materialize tabs synchronously during component init — before first paint —
  // so the tab strip, titles, drafts, and active tab (with its loading skeleton)
  // render in the first mounted frame with zero server round trips. The cached
  // start() payload is applied first so persisted tabs can fall back to the last
  // known workspace path. The async runtime attach (createTab/bind/transcript)
  // and fresh start() reconciliation run later from the effect below.
  session.lifecycle.hydrateAgentsFromCache();
  materializeTabs(session);

  // Electron-only: analytics is desktop-side.
  initAnalytics({
    // Undecided consent stays off until the person chooses (plans/018 §3.1).
    enabled: settings.clientAnalyticsEnabled === true,
    platform: "desktop",
    viewMode: "wide",
  });
  track("app_opened", {});

  $effect(() => {
    const installationId = connectionState.target?.installationId;
    const appVersion = hosts.find(connectionState.target?.id)?.capabilityRecord?.version;
    if (!installationId || !appVersion) return;
    identifyInstallation(installationId);
    registerSuperProps({ app_version: appVersion });
  });

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
      strips: session.router.persistedStrips,
    };
    savePersistedTabsDebounced(snapshot);
  });

  // Drafts persist on their own key: they have no tab to ride, and a prompt the
  // user already wrote must survive a reload. Reading the whole map is cheap —
  // there are only ever as many drafts as open panes.
  $effect(() => {
    if (session.lifecycle.hydrating) return;
    savePersistedSessionDraftsDebounced(session.drafts.sessionDraftsSnapshot);
  });

  // Unsent input drafts persist per-keystroke on a debounce. Only reads the active
  // tab's input — other tabs' drafts are patched into the persisted map individually
  // as the user visits each tab, rather than re-reading all N tabs every keystroke.
  $effect(() => {
    if (session.lifecycle.hydrating) return;
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
      projectsStore.flush();
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

  // Slash command discovery is backend-scoped, so refresh when the active agent changes.
  // Keep the whole refresh outside tracking: the command loader reads more session
  // state synchronously before its first await, but only an agent change belongs here.
  // Explicit refreshes in createTab/setBaseDirectory handle directory changes.
  $effect(() => {
    void settings.activeAgent;
    untrack(
      () => void session.lifecycle.refreshPluginCommands(session.tabCtx.workingDirectory),
    );
  });

  setupAgentEvents(session);
  // Refresh the key the project panel reads: the worktree path when the tab has one.
  session.onTurnSettled = (sessionId, cwd) => {
    const sess = session.sessions.byId[sessionId];
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

  $effect(() => {
    refreshTheme(settings.setSystemTheme.bind(settings));
    const unsub = window.solusNative.onThemeChange((isDark: boolean) =>
      settings.setSystemTheme(isDark),
    );
    return unsub;
  });

  onMount(() => initializeRuntime(session, sessionSidebarStore));

  const detectReconnect = createReconnectDetector(
    serversStore.connectionStatus,
  );
  $effect(() => {
    const connectionStatus = serversStore.connectionStatus;
    const reconnected = detectReconnect(connectionStatus);
    untrack(() => {
      if (reconnected) {
        refreshTheme(settings.setSystemTheme.bind(settings));
        // The status above is the active host's, so it is the one whose registrations went stale.
        sessionEnvironmentStore.invalidateRegistrationsForHost(
          serversStore.activeServerId,
        );
        refreshRuntime(session, sessionSidebarStore);
      }
    });
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

  // The notifications hub reads every source once for the page and the badge (plan 015).
  $effect(() => untrack(() => notificationHubStore.start()));

  $effect(() => {
    return untrack(() =>
      notificationsStore.start({
        preferences: () => settings.notifications,
        hostDisplay: (serverId) => {
          const host = serversStore.hostFor(serverId);
          const display: import("@solus/workspace-ui/contexts/notifications/notifications.store.svelte").NotificationHostDisplay =
            {
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
      }),
    );
  });

  // These are lifetime subscriptions. Some installers read active-session state
  // for their first report, but session changes must not reinstall every listener.
  $effect(() =>
    untrack(() => {
      const unsubSessionStatuses =
        sessionSidebarStore.subscribeSessionStatuses();
      const unsubProjectDirectory = listenForProjectDirectory();
      // Live automation state: scheduler fires, run transitions, and agent-tool
      // saves all land here. Failures get a toast — an unattended run breaking
      // is otherwise invisible until the user happens to open the page.
      const unsubAutomations = subscribeAllHosts(
        "automation.changed",
        (serverId, event) => {
          session.automationsStore.applyChange(serverId, event);
          if (event.kind === "run-finished" && event.run.status === "failed") {
            toasts.error(`Automation "${event.automation.name}" failed`, {
              action: {
                label: "View",
                onAction: () => session.openAutomations(event.automation.id),
              },
            });
          }
        },
      );
      // Review requests and decisions reach the reader on every client.
      const unsubWorkReviews = subscribeWorkReviewChanges(session.worksStore, (workId) => session.openWork(workId));
      // An agent left comment threads on a plan or a work. Re-read that target's
      // annotations so the rail updates under the reader, rather than making them
      // close and reopen the document to see the review.
      const unsubAnnotations = subscribeAllHosts(
        "annotations.changed",
        (serverId, change) => {
          if (change.kind === "work")
            void session.worksStore.loadAnnotations(change.targetId, serverId);
          else
            void session.planStore.hydrateAnnotations(
              change.targetId,
              serverId,
            );
        },
      );
      // A browser page an agent opened has nowhere to render until a pane shows
      // it, so the request is answered app-wide rather than by a surface that
      // may not be mounted. The agent asked, not the user, so it never takes
      // the place of a surface the user is reading.
      browserStore.onSurfaceRequested = () => session.openBrowser(undefined, undefined, { automatic: true });
      // A stopped recording goes to the composer the user is writing in, from
      // whichever entry point stopped it, and when a limit stopped it.
      browserStore.onRecordingSaved = (serverId, result) =>
        deliverRecording(session.leadingInput, serverId, result);
      const unsubBrowser = browserStore.subscribe();
      // A device an agent opens is revealed beside its own conversation only.
      devicesStore.onSurfaceRequested = (serverId, payload) => revealDeviceSurface(session, serverId, payload);
      const unsubDevices = devicesStore.subscribe();
      const unsubGuideStatus = pullRequests.guides.subscribe();
      // An agent can need an account before any surface that would show its
      // status has been opened, so the request is heard app-wide, not by the card.
      const unsubConnectRequests = connectRequestStore.listen();
      // A member's provider seat changes on the host, at a turn's end or in the
      // browser; the settings row and the connect card both read the store.
      const unsubSeats = seatsStore.listen();
      // Who else is on each host, and what they are looking at; the rooms arrive
      // as snapshots and every presence surface reads the one store.
      const unsubPresence = presenceStore.listen();
      // The tunnel comes up after the host has answered the link; the cloud row follows it.
      const unsubUplink = uplinkStore.listen();
      // The Atlassian sign-in finishes in a browser and lands on the host, not
      // on the tab that opened it — so the completion is heard app-wide too.
      const unsubAtlassian = atlassianStore.listenForOAuthCompletion();
      const unsubShown = window.solusNative.onWindowShown(() => {
        const run = session.sessionFor(session.activeTabId)?.run ?? session.defaultRunConfig;
        const cwd = run.gitContext?.worktreePath ?? run.workingDirectory;
        if (cwd)
          void sessionEnvironmentStore.refreshEnvironment(session, {
            sourceId: session.activeTabId,
            cwd,
            level: "status",
            force: false,
          });
      });
      return () => {
        unsubSessionStatuses();
        unsubAutomations();
        unsubWorkReviews();
        unsubAnnotations();
        browserStore.onSurfaceRequested = null;
        browserStore.onRecordingSaved = null;
        unsubBrowser();
        unsubDevices();
        unsubGuideStatus();
        unsubConnectRequests();
        unsubSeats();
        unsubUplink();
        unsubPresence();
        unsubProjectDirectory();
        unsubAtlassian();
        unsubShown();
      };
    }),
  );

  // Tell the host which session or work the focused pane shows, so teammates
  // can see where this person is and jump to them.
  $effect(() => presenceStore.reportWorkspaceFocus(session));
  // And go along with a followed teammate when they move.
  $effect(() => presenceStore.syncFollow(session));

  // Keep main informed of whether the live text selection sits inside the
  // conversation view, so its native right-click menu can offer "Quote in
  // reply" only there. Pushed ahead of the click (on selectionchange) so main
  // already has the answer when the context menu fires — no IPC race. A
  // right-click on a link needs no selection, so the contextmenu event pushes
  // the conversation under the pointer before the native menu opens.
  $effect(() => {
    let lastSourceTabId: string | null = null;
    const pushSourceTabId = (sourceTabId: string | null) => {
      if (sourceTabId === lastSourceTabId) return;
      lastSourceTabId = sourceTabId;
      localApi.setQuoteContext(sourceTabId);
    };
    const conversationTabIdOf = (el: Element | null | undefined) =>
      el?.closest<HTMLElement>(".conversation-selectable")?.dataset
        .conversationTabId ?? null;
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
        sourceTabId = conversationTabIdOf(
          node instanceof Element ? node : node.parentElement,
        );
      }
      pushSourceTabId(sourceTabId);
    };
    const onContextMenu = (event: MouseEvent) => {
      pushSourceTabId(
        event.target instanceof Element ? conversationTabIdOf(event.target) : null,
      );
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("contextmenu", onContextMenu, true);
      localApi.setQuoteContext(null);
    };
  });

  $effect(() =>
    localApi.onAskSelectionInNewSession((text, sourceTabId) => {
      void session
        .opening.askInNewSession(sourceTabId, text)
        .catch(() => toasts.error("Couldn't start a new session"));
    }),
  );

  $effect(() =>
    localApi.onOpenSelectedLink((url, sourceTabId) => {
      const serverId = session.sessionFor(sourceTabId)?.run.serverId;
      if (!serverId) return;
      void session.openUrlInBrowser(url, serverId).catch((error) => {
        toasts.error("Couldn't open the link", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    }),
  );

  $effect(() => {
    // Pre-listener for the voice shortcut: always claims the combo so the OS
    // never sees it
    // (exclusive scopes in DocumentShell block the normal dispatcher for global
    // bindings, which would otherwise let macOS insert the  character).
    // Handles dictation into the focused registered plain field or prose
    // editor. Other cases (for example the chat composer) continue through the
    // normal dispatcher when no exclusive scope is active.
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
      if (dictation.toggleFocusedRecorder(document.activeElement)) {
        // The focused field has handled this reserved shortcut. Do not let the
        // normal dispatcher invoke the editor-local handler with the same key
        // event and immediately toggle recording off again.
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", handleVoiceKey, true);
    return () => document.removeEventListener("keydown", handleVoiceKey, true);
  });

  // Native text fields outside the shared Input/Textarea primitives still get
  // the same focused-field shortcut behavior. Structured text fields opt out
  // with `data-dictation="false"`; the shared primitives remain the preferred
  // path because they also render the full recording controls.
  $effect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (isDictationTarget(target)) dictation.focusGained(target);
    };
    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (isDictationTarget(target)) dictation.focusLost(target);
    };
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  });

  // Direct native fields have no component-owned recording overlay. Mark the
  // active target so the global stylesheet can show a state without changing
  // its layout. Shared fields hide this element and show richer controls.
  $effect(() => {
    const target = dictation.mode === "insert" ? dictation.target : null;
    const state = dictation.starting ? "recording" : dictation.state;
    if (!target || state === "idle") return;
    if (
      target.parentElement?.matches(
        '[data-slot="input-wrap"], [data-slot="textarea-wrap"]',
      )
    ) {
      return;
    }
    target.dataset.solusVoiceState = state;
    return () => delete target.dataset.solusVoiceState;
  });

  dictation.configure(
    () => settings.vadSilenceMs,
    () => settings.voiceModeEnabled,
    () => hosts.transcription?.voiceReady ?? false,
  );
}
