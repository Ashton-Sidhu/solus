import { onMount, untrack } from "svelte";

import {
  projectsStore,
  connectionsStore,
  serversStore,
  atlassianStore,
  connectRequestStore,
  parseRoute,
  runtime,
} from "@solus/workspace-ui/contexts";
import { snapshotPersistedTabs } from "@solus/workspace-ui/contexts/workspace/tab-snapshot";

import { toasts } from "@solus/workspace-ui/lib/toasts";

import { projectScopeOf } from "@solus/contracts/types";
import type { AgentId } from "@solus/contracts/types";

import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
import { materializeTabs } from "@solus/workspace-ui/contexts/workspace/session-bootstrap";

import { serverConnections } from "@solus/client-core/server-connections";

import { subscribeAllHosts } from "@solus/client-core/host-events";
import { localApi } from "@solus/client-core/local-api";
import { notificationsStore } from "@solus/workspace-ui/contexts/notifications/notifications.store.svelte";
import { browserStore } from "@solus/workspace-ui/contexts/browser/browser.store.svelte";

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
import { consumeSessionHandoff } from "@solus/workspace-ui/contexts/workspace/active-session-pointer";

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
import type { DesktopWindow } from "./desktop-window.svelte";

export function installDesktopRuntime(
  core: DesktopAppCore,
  windowCtx: DesktopWindow,
) {
  const {
    settings,
    sessionEnvironmentStore,
    voiceModelStore,
    pullRequests,
    session,
    sessionSidebarStore,
    agent,
  } = core;
  const viewMode = $derived(windowCtx.viewMode);
  const isEditorMode = $derived(viewMode === "editor");
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
      return (
        sess?.agentSessionId === ptr.sessionId &&
        sess.run.serverId === ptr.serverId
      );
    });
    if (isOpenHere) {
      session.openRoute({
        name: "chat",
        params: { sessionId: ptr.sessionId, serverId: ptr.serverId },
      });
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
    untrack(
      () => void session.refreshPluginCommands(session.tabCtx.workingDirectory),
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
      if (connectionStatus === "connected") {
        const defaultServerId = serverConnections.defaultServerId();
        if (defaultServerId) {
          void connectionsStore.refreshCapabilities({
            serverId: defaultServerId,
          });
        }
      }
      if (reconnected) {
        refreshTheme(settings.setSystemTheme.bind(settings));
        const defaultServerId = serverConnections.defaultServerId();
        if (defaultServerId) {
          sessionEnvironmentStore.invalidateRegistrationsForHost(
            defaultServerId,
          );
        }
        refreshRuntime(session, sessionSidebarStore);
      }
    });
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
      if (shouldIgnore) localApi.setIgnoreMouseEvents(true, { forward: true });
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
    return untrack(() =>
      notificationsStore.start({
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
      const unsubVoiceModel = subscribeAllHosts(
        "voice.modelStatusChanged",
        (serverId, status) => voiceModelStore.apply(status, serverId),
      );
      const unsubSessionStatuses =
        sessionSidebarStore.subscribeSessionStatuses();
      const unsubPrLifecycle = sessionSidebarStore.subscribePrLifecycle();
      const defaultServerId = serverConnections.defaultServerId();
      if (defaultServerId) void voiceModelStore.refresh(defaultServerId);
      // The promoted settings tier lives on the host so it follows the user
      // between desktop, web, and mobile. The localStorage copy already painted
      // this boot; this reconciles it with whatever another client last set.
      if (defaultServerId) void settings.hydrateFromHost(defaultServerId);
      const unsubHostConfig = settings.listenForHostConfigChanges();
      const unsubUsage = subscribeAllHosts(
        "usage.limitsChanged",
        (_serverId, { snapshots }) => agent.applyUsage(snapshots),
      );
      void agent.refreshUsage();
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
      const unsubStackGraph = pullRequests.stacks.subscribe();
      // A browser page an agent opened has nowhere to render until a pane shows
      // it, so the request is answered app-wide rather than by a surface that
      // may not be mounted. Explicitly invoked — nothing here auto-opens.
      browserStore.onSurfaceRequested = () => session.openBrowser();
      const unsubBrowser = browserStore.subscribe();
      const unsubChecks = pullRequests.checks.subscribe(activePrScope);
      const unsubGuideStatus = pullRequests.guides.subscribe();
      const unsubPullRequestChanges =
        pullRequests.projects.subscribeLifecycleChanges();
      const unsubNeedsReview =
        pullRequests.needsReview.subscribe(activePrScope);
      // An agent can need an account before any surface that would show its
      // status has been opened, so the request is heard app-wide, not by the card.
      const unsubConnectRequests = connectRequestStore.listen();
      // The Atlassian sign-in finishes in a browser and lands on the host, not
      // on the tab that opened it — so the completion is heard app-wide too.
      const unsubAtlassian = atlassianStore.listenForOAuthCompletion();
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
        browserStore.onSurfaceRequested = null;
        unsubBrowser();
        unsubChecks();
        unsubGuideStatus();
        unsubPullRequestChanges();
        unsubNeedsReview();
        unsubConnectRequests();
        unsubHostConfig();
        unsubAtlassian();
        unsubShown();
      };
    }),
  );

  const activeProjectScope = $derived(projectScopeOf(session.ctx.session));

  // What the host sets its checks poll cadence from. Every input is a primitive
  // derived, so the report goes out only when one of them changes: a tab switch
  // inside the same project, or a focus event that lands on the same state,
  // sends nothing. The connection is an input too — the host forgets a client's
  // activity when it disconnects, and a reconnect restores it here.
  const checksReviewSurfaceOpen = $derived(
    session.router.at("prs") ||
      session.router.at("reviewMode") ||
      !!session.activeSession?.prReview,
  );
  const activeServerId = $derived(
    serverConnections.serverIdForApi(session.apiFor(session.activeTabId)),
  );
  const hostConnected = $derived(serversStore.connectionStatus === "connected");
  $effect(() => {
    const reviewSurfaceOpen = checksReviewSurfaceOpen;
    const active = runtime.isWindowForeground;
    void activeProjectScope;
    void activeServerId;
    if (!hostConnected) return;
    untrack(() => {
      const scope = activePrScope();
      pullRequests.checks.reportActivity(
        scope.api,
        scope.ctx,
        reviewSurfaceOpen,
        active,
      );
    });
  });

  // The needs-review count answers "in this project", so crossing into another
  // one makes the count the sidebar is showing not just stale but wrong — the
  // store zeroes it rather than report another project's number. Fetch the new
  // project now; leaving it to the poll blanks the badge for up to a cycle.
  $effect(() => {
    void activeProjectScope;
    untrack(() => {
      const scope = activePrScope();
      void pullRequests.needsReview
        .refresh(scope.api, scope.serverId, scope.ctx)
        .catch(() => {});
    });
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
    () => voiceModelStore.ready,
  );
}
