<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import {
    getWorkspaceContext,
    getWindowContext,
    getSettingsContext,
    getSessionEnvironmentStore,
  } from "../../contexts";
  import ProjectPanel from "../project-panel/ProjectPanel.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SessionSidebar from "../session/SessionSidebar.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import SessionBreadcrumb from "../conversation/SessionBreadcrumb.svelte";
  import FrameExpandButton from "./FrameExpandButton.svelte";
  import OuterScrollbar from "./OuterScrollbar.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import TaskPicker from "../session/TaskPicker.svelte";
  import Pane from "../ui/Pane.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { frameChrome } from "./frame-chrome.store.svelte";
  import type {
    PaneEntry,
    PaneId,
  } from "../../contexts/workspace/routing/location";
  import { visibleRef } from "../../contexts/workspace/routing/location";
  import { isMovableRoute } from "../../contexts/workspace/routing/route-registry";
  import { CompanionPanes } from "./lib/companion-panes.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    COMPANION_PANE_DEFAULT_SIZE,
    COMPANION_PANE_MIN_SIZE,
    isCompanionVisible,
    isFramedRoute,
    LIST_PRIMARY_PANE_MIN_SIZE,
    LIST_PRIMARY_PANE_SIZE,
    maximizeTargetPaneId,
    PRIMARY_PANE_MIN_SIZE,
    primaryProjectPanelOpen,
    retainedConversationTabIds,
    SIDEBAR_PANE_DEFAULT_SIZE,
    SIDEBAR_PANE_MAX_SIZE,
    SIDEBAR_PANE_MIN_SIZE,
  } from "./lib/workspace-body";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import { isProjectRailOpen } from "../project-panel/lib/rail-width";
  import * as Resizable from "../ui/resizable";
  import { provideOuterScrollbarContext } from "./lib/outer-scrollbar.context";

  interface Props {
    /** Whether this body is the active layout (drives keybindings + chrome reporting). */
    active: boolean;
    /** Show the right-hand ProjectPanel + its keybinding. */
    enableProjectPanel: boolean;
    /** Action buttons + InputBar row (varies between editor and web). */
    inputRow: Snippet;
    /** Tab-aware composer actions forwarded to a split conversation pane. */
    onAttachFile?: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let {
    active,
    enableProjectPanel,
    inputRow,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const settings = getSettingsContext();
  const environmentStore = getSessionEnvironmentStore();
  const router = session.router;
  const companions = new CompanionPanes(
    () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  let outerScrollTargets = $state<HTMLElement[]>([]);
  let outerScrollTarget = $state<HTMLElement | null>(null);

  provideOuterScrollbarContext({
    register(element) {
      if (!outerScrollTargets.includes(element))
        outerScrollTargets.push(element);
      outerScrollTarget = element;

      const activate = () => (outerScrollTarget = element);
      element.addEventListener("pointerenter", activate);
      element.addEventListener("focusin", activate);
      element.addEventListener("scroll", activate, { passive: true });

      return () => {
        element.removeEventListener("pointerenter", activate);
        element.removeEventListener("focusin", activate);
        element.removeEventListener("scroll", activate);
        const index = outerScrollTargets.indexOf(element);
        if (index !== -1) outerScrollTargets.splice(index, 1);
        if (outerScrollTarget === element) {
          outerScrollTarget = outerScrollTargets.at(-1) ?? null;
        }
      };
    },
  });
  const sess = $derived(session.sessionFor(session.activeTabId));
  const hasStartedSession = $derived(hasSessionStarted(sess));
  const leadingPane = $derived(router.leadingPane);
  const leadingRef = $derived(visibleRef(leadingPane));
  // The leading pane resting on the conversation pool: naming no session means
  // "whatever the active tab is", which is exactly what the pool renders.
  const poolInLead = $derived(
    leadingRef?.name === "chat" && !leadingRef.params.sessionId,
  );
  // The draft the leading pane is composing, when it holds one instead of a
  // conversation. It has no tab, so the band and the rail read it directly.
  const leadingDraft = $derived(
    leadingRef?.name === "draft"
      ? (session.sessionDrafts.get(leadingRef.params.draftId) ?? null)
      : null,
  );
  // A draft's rail follows the fresh-tab rule regardless of what the tab behind
  // it was doing: nothing has started here either.
  const leadingStarted = $derived(!leadingDraft && hasStartedSession);
  const activeProjectPanelTabKey = $derived(
    leadingDraft?.id ?? (session.activeTabId || "workspace"),
  );
  let projectPanelPopoutTabKey = $state<string | null>(null);
  const newTabProjectPanelPoppedOut = $derived(
    projectPanelPopoutTabKey === activeProjectPanelTabKey,
  );
  const isPrimaryProjectPanelOpen = $derived(
    primaryProjectPanelOpen(
      leadingStarted,
      settings.projectPanelOpen,
      newTabProjectPanelPoppedOut,
    ),
  );
  // Popping the rail out on a fresh tab is intentionally transient. Starting
  // that session or moving to another tab returns control to the normal rule.
  $effect(() => {
    if (
      leadingStarted ||
      (projectPanelPopoutTabKey !== null &&
        projectPanelPopoutTabKey !== activeProjectPanelTabKey)
    ) {
      projectPanelPopoutTabKey = null;
    }
  });
  const focusedChatTabId = $derived(
    session.focusedChatTabId ?? session.activeTabId,
  );
  const focusedEnvironment = $derived(
    environmentStore.environmentFor(session.sessionFor(focusedChatTabId)?.run),
  );
  const canShowFocusedDiffPanel = $derived(!!focusedEnvironment.cwd);
  // Companions, in render order, including one still animating out. The router
  // drops a closed pane immediately; CompanionPanes holds its last entry for the
  // length of the exit so the split collapses instead of snapping.
  const companionPanes = $derived(
    companions.ids
      .map((paneId) => router.pane(paneId) ?? companions.entry(paneId))
      .filter((pane): pane is PaneEntry => !!pane),
  );
  const companion = $derived(router.asidePanes[0] ?? null);
  const companionRef = $derived(companion ? visibleRef(companion) : null);
  const secondaryVisible = $derived(isCompanionVisible(companionRef, session));
  const secondaryCollapsesSidebar = $derived(
    secondaryVisible && companionRef?.name !== "automation",
  );
  // Dedicated review surfaces read edge-to-edge and do not want a session
  // column beside them. The pull requests page is a workspace list, so it keeps
  // the user's sidebar state like Automations and Workspace do.
  const primaryReviewOpen = $derived(
    leadingRef?.name === "review" ||
      leadingRef?.name === "prReview",
  );
  const maximizedPaneId = $derived(session.maximizedPaneId);

  // The tab strip, the composer and the project rail are one set of chrome: all
  // three belong to a conversation in the primary slot. Any non-conversation
  // content — a page, artifact, or review — covers the conversation pool (hidden,
  // never unmounted) and its composer, and a maximized secondary (e.g. the
  // full-screen PR-review surface) covers the whole column, so the composer has
  // nothing to dock to. They step aside together rather than each being told to.
  const conversationChromeVisible = $derived(
    poolInLead && maximizedPaneId === null,
  );
  // The band and the rail say where you are, which a draft answers as fully as
  // a conversation does — so they stay while the leading pane composes one,
  // even though the pool's composer and transcript have stepped aside for it.
  const locationChromeVisible = $derived(
    (poolInLead || !!leadingDraft) && maximizedPaneId === null,
  );
  // Lazy-mount-then-hide (see renderer CLAUDE.md): the project rail mounts the
  // first time the conversation chrome is visible and afterwards only toggles
  // display, so covering surfaces don't pay a Git/Task section rebuild on exit.
  let hasMountedProjectRail = $state(false);
  $effect(() => {
    if (enableProjectPanel && locationChromeVisible) hasMountedProjectRail = true;
  });
  // The one band over the leading pane, whatever it holds — a transcript, an
  // empty session, or a draft. It floats over the content rather than sitting in
  // a row, which is the only way it differs from the one `AsidePaneShell` draws;
  // the transcript underneath reserves its height.
  const showLeadingBand = $derived(
    active && locationChromeVisible && (!!leadingDraft || !!session.activeTabId),
  );
  const bandOffersNewSession = $derived(!leadingDraft);
  let homeSessionMenu = $state<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  $effect(() => {
    if (!showLeadingBand) homeSessionMenu = null;
  });
  // Lazy-mount the conversation pool: only mount a tab's ConversationView the
  // first time it becomes the active tab. Split chats own a separate force-visible
  // ConversationView in ConversationPane, so mounting them here would duplicate
  // the heavy transcript tree. This also prevents 20 heavy component trees from
  // being constructed and kept alive for tabs the user may never actually visit.
  // Start empty — the $effect below populates it reactively.
  const mountedTabIds = new SvelteSet<string>();
  const retainedTranscriptTabIds = new SvelteSet<string>();
  const transcriptRecency: string[] = [];
  $effect(() => {
    const displayedTabIds = (active ? [session.activeTabId] : []).filter(
      (tabId): tabId is string => !!tabId && !!session.tabs[tabId],
    );
    for (const id of displayedTabIds) mountedTabIds.add(id);
    for (const id of mountedTabIds) {
      if (!session.tabs[id]) mountedTabIds.delete(id);
    }

    const retained = active
      ? retainedConversationTabIds(
          transcriptRecency,
          displayedTabIds,
          session.tabOrder,
        )
      : [];
    transcriptRecency.splice(0, transcriptRecency.length, ...retained);
    for (const id of retained) retainedTranscriptTabIds.add(id);
    for (const id of retainedTranscriptTabIds) {
      if (!retained.includes(id)) retainedTranscriptTabIds.delete(id);
    }
  });

  // Geometry is driven for the trailing companion, which at MAX_PANES = 2 is
  // the only one. Raising the cap turns these into a map keyed by pane id.
  let secondaryPaneEl: HTMLDivElement | null = $state(null);
  let secondaryPane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  let sidebarPane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  let workspaceBodyWidth = $state(0);
  // The conversation view — tab strip, conversation, and the rail beside it. The
  // rail scales against this, and minimizes itself once the secondary pane has
  // taken enough of it that both can't fit.
  let workspaceColumnWidth = $state(0);
  // The conversation view and the secondary pane together: the container the
  // secondary's percentage geometry is measured in.
  let conversationSplitWidth = $state(0);
  let isResizingSecondary = $state(false);

  // Scale the sidebar with the viewport instead of two coarse breakpoints:
  // narrower on laptops (more room for the conversation), wider on large
  // displays so it doesn't look anemic beside a wide thread. ~19% of the
  // viewport, bounded to a usable band. The project rail takes the same measure
  // from the same width, so the two rails match — see
  // project-panel/lib/rail-width. Measured, not sampled once at mount: the app
  // window is what the sidebar shares, and it changes when the window is resized
  // or moved to another display.
  const workspaceWidth = $derived(
    workspaceBodyWidth ||
      window.innerWidth,
  );

  let sidebarOpen = $state(true);
  let sidebarClosedForOverlay = $state(false);
  // Overlay-driven collapse/expand lands in the same single layout pass as the
  // companion pane instead of animating: the pane already snaps into the split,
  // and animating flex-grow beside it relayouts the entire workspace —
  // transcript included — every frame for 240ms. User toggles stay animated.
  let sidebarSnapForOverlay = $state(false);
  let sidebarSnapTimer: ReturnType<typeof setTimeout> | undefined;

  function snapSidebarForOverlay(moveSidebar: () => void) {
    sidebarSnapForOverlay = true;
    moveSidebar();
    if (sidebarSnapTimer) clearTimeout(sidebarSnapTimer);
    // Long enough for the collapsed layout to apply and paint once before
    // transitions come back; short enough that a user toggle right after
    // animates normally.
    sidebarSnapTimer = setTimeout(() => (sidebarSnapForOverlay = false), 100);
  }
  $effect(() => () => clearTimeout(sidebarSnapTimer));


  function openSidebar() {
    sidebarOpen = true;
    sidebarPane?.expand();
  }

  function closeSidebar() {
    sidebarOpen = false;
    sidebarPane?.collapse();
    requestInputFocus();
  }

  function toggleSidebar() {
    // Once the user makes an explicit choice, closing the surface that caused
    // the automatic collapse must not override it.
    sidebarClosedForOverlay = false;
    if (!sidebarOpen) {
      openSidebar();
    } else {
      closeSidebar();
    }
  }

  // Each conversation view owns its rail, so the shortcut acts on the one the
  // user is in. The tab strip's button only ever reaches the leading pane — it
  // lives in that pane's chrome; the split chat carries its own toggle.
  function toggleProjectPanel(isSplit = false) {
    if (isSplit) {
      settings.update({
        splitProjectPanelOpen: !settings.splitProjectPanelOpen,
      });
      return;
    }
    if (!leadingStarted) {
      const open = !newTabProjectPanelPoppedOut;
      projectPanelPopoutTabKey = open ? activeProjectPanelTabKey : null;
      // An explicit reveal becomes the user's conversation preference once the
      // first session starts; hiding the empty-home rail remains transient.
      if (open && !settings.projectPanelOpen) {
        settings.update({ projectPanelOpen: true });
      }
      if (!open) requestInputFocus();
      return;
    }
    const open = !settings.projectPanelOpen;
    settings.update({ projectPanelOpen: open });
    if (!open) requestInputFocus();
  }

  // Publish the frame-level expand controls so full-page sub-views (Folio,
  // Plans, Settings) can host them inline in their own headers instead of in a
  // separate chrome strip. Settings owns the persisted project-panel flag;
  // this body owns the transient sidebar state and mirrors both here. When
  // this body is inactive (pill / mobile), report the panels as open so those
  // headers don't offer to expand chrome that isn't on screen.
  frameChrome.expandSidebar = toggleSidebar;
  // Full-page views never host a split chat, so this only ever means the lead.
  frameChrome.toggleProjectPanelFromFrame = () => toggleProjectPanel();
  $effect(() => {
    frameChrome.sidebarOpen = active ? sidebarOpen : true;
    frameChrome.projectPanelOpen = active ? isPrimaryProjectPanelOpen : true;
  });

  useKeybinding("global.toggle-sidebar", () => toggleSidebar(), {
    enabled: () => active,
  });
  // ⌥M maximizes the companion pane whatever surface it holds — the diff panel
  // used to own this key alone, so every other pane (files, review, plan, work,
  // split chat) had no keyboard way out of a half-width column.
  const maximizePaneId = $derived(
    maximizeTargetPaneId(
      router.asidePanes.map((pane) => pane.id),
      router.focusedPaneId,
      session.maximizedPaneId,
    ),
  );
  useKeybinding(
    "pane.maximize",
    () => {
      if (!maximizePaneId) return;
      session.maximizedPaneId =
        session.maximizedPaneId === maximizePaneId ? null : maximizePaneId;
    },
    { enabled: () => active && !!maximizePaneId },
  );
  useKeybinding(
    "global.toggle-project-panel",
    () =>
      toggleProjectPanel(
        !!session.splitChatTabId && router.focusedPaneId !== leadingPane.id,
      ),
    { enabled: () => active && enableProjectPanel },
  );
  useKeybinding(
    "global.new-split-chat",
    async () => {
      if (session.splitChatTabId) {
        session.closeSplitChat();
        requestInputFocus();
        return;
      }
      // A second composition beside the first: a draft in its own companion
      // pane, which becomes a split chat the moment it is sent.
      session.openSessionDraft({ target: "aside", via: "keybinding" });
      requestInputFocus();
    },
    { enabled: () => active },
  );
  useKeybinding(
    "global.toggle-files",
    () => {
      if (router.overlay?.name === "files") router.closeOverlay();
      else session.openFiles(focusedChatTabId);
      requestInputFocus();
    },
    { enabled: () => active && canShowFocusedDiffPanel },
  );
  useKeybinding(
    "global.open-in-split",
    () => {
      if (isMovableRoute(leadingRef)) {
        router.movePane(leadingPane.id, 1);
      } else if (companion && isMovableRoute(companionRef)) {
        router.movePane(companion.id, -1);
      } else if (session.splitChatTabId) {
        // Promote the split chat back into the leading pane's tab pool.
        session.promoteSplitToMainTab();
      } else if (poolInLead && session.activeTab) {
        // Plain conversation: split the active chat off to the side.
        session.openTabInSplit(session.activeTab.id);
      } else {
        return;
      }
      requestInputFocus();
    },
    { enabled: () => active },
  );

  // A PR review docks beside the PR inbox, which is a list sidebar rather than
  // a chat column — it gets the narrower floor so the review keeps the width.
  const primaryIsListSidebar = $derived(
    leadingRef?.name === "prs" && companionRef?.name === "prReview",
  );
  const primaryMinSize = $derived(
    primaryIsListSidebar ? LIST_PRIMARY_PANE_MIN_SIZE : PRIMARY_PANE_MIN_SIZE,
  );
  // Pages that own an edge-to-edge surface: each ends in its own footer band or
  // full-bleed background, so the card gutter would read as that background
  // failing to reach the window edge rather than as breathing room.
  const FLUSH_PAGES = new Set([
    "settings",
    "tasks",
    "task",
    "prs",
    "prReview",
    "folio",
  ]);
  const pageFlush = $derived(FLUSH_PAGES.has(leadingRef?.name ?? ""));
  const secondaryBounds = $derived({
    min: COMPANION_PANE_MIN_SIZE,
    max: 100 - primaryMinSize,
  });
  // The companion states its own measure when it opens — a diff asks for more of
  // the split than a goal does. A docked list sidebar is the one case the
  // *primary* names its share instead, so the companion takes the rest.
  const secondaryDefaultSize = $derived(
    primaryIsListSidebar
      ? 100 - LIST_PRIMARY_PANE_SIZE
      : (companion?.defaultSize ?? COMPANION_PANE_DEFAULT_SIZE),
  );

  function handleCompanionDragging(dragging: boolean) {
    isResizingSecondary = dragging;
  }

  // Frozen the moment a companion starts closing: the pane leaves the layout
  // flow to fade out, so it needs the width it had rather than a share.
  let secondaryClosingWidth = $state(560);

  // One effect drives every companion's mount/exit timing, keyed by pane id.
  // The location is the only thing tracked here: `sync` reads and writes the
  // state it owns, so tracking it would make this effect retrigger itself — the
  // failure mode the one-directional router exists to rule out.
  $effect(() => {
    const live = router.asidePanes;
    untrack(() => {
      if (live.length === 0 && secondaryPaneEl) {
        secondaryClosingWidth =
          secondaryPaneEl.clientWidth || secondaryClosingWidth;
      }
      companions.sync(live);
      // A maximized pane covers the window, so a stale id would keep the whole
      // workspace hidden behind a surface that has already closed.
      if (
        session.maximizedPaneId &&
        !router.panes.some((pane) => pane.id === session.maximizedPaneId)
      ) {
        session.maximizedPaneId = null;
      }
    });
  });
  $effect(() => () => companions.dispose());

  // A pinned chat that takes focus gets the caret, once its surface is on
  // screen. Re-checked inside the frame so a fast close doesn't steal focus.
  $effect(() => {
    const paneId = router.focusedPaneId;
    if (paneId === leadingPane.id || !companions.settled.has(paneId)) return;
    const tabId = session.chatTabIn(paneId);
    if (!tabId) return;
    requestAnimationFrame(() => {
      if (router.focusedPaneId !== paneId) return;
      if (session.chatTabIn(paneId) !== tabId) return;
      requestInputFocus({ tabId });
    });
  });

  // As soon as the secondary stops owning layout space, reopen the rail in the
  // same transition instead of waiting for the fading secondary shell to unmount.
  // Use the split container's final width while returning to the primary view so
  // the rail starts toward one stable target rather than retargeting after the
  // primary column's ResizeObserver catches up.
  const projectRailContainerWidth = $derived(
    secondaryVisible
      ? workspaceColumnWidth
      : conversationSplitWidth || workspaceColumnWidth,
  );
  const railOpen = $derived(
    enableProjectPanel &&
      locationChromeVisible &&
      isProjectRailOpen(
        isPrimaryProjectPanelOpen,
        projectRailContainerWidth,
        secondaryVisible,
      ),
  );

  // Collapse the session sidebar when a full-width surface opens — a secondary
  // pane, review guide, or Settings — and restore it on close, the same way the
  // diff panel reclaims the width. Track only the surface transition: the user
  // can reopen the sidebar while that surface remains open without this effect
  // immediately closing it again. The Workspace is not one of them: it dropped
  // its own left rail, so it no longer competes for the sidebar's width.
  $effect(() => {
    const sidebarOverlayOpen =
      secondaryCollapsesSidebar ||
      primaryReviewOpen ||
      router.at("settings");

    untrack(() => {
      if (sidebarOverlayOpen) {
        if (sidebarOpen) {
          sidebarClosedForOverlay = true;
          snapSidebarForOverlay(closeSidebar);
        }
      } else if (sidebarClosedForOverlay) {
        sidebarClosedForOverlay = false;
        snapSidebarForOverlay(openSidebar);
      }
    });
  });

  // PaneForge owns the geometry while Solus owns whether the sidebar is
  // logically open. This effect bridges toolbar/keybinding state to the
  // imperative collapse API without unmounting the panel. The project rail needs
  // no equivalent: it is not a pane, and its visibility is derived.
  $effect(() => {
    const pane = sidebarPane;
    if (!pane) return;
    if (sidebarOpen && pane.isCollapsed()) pane.expand();
    else if (!sidebarOpen && !pane.isCollapsed()) pane.collapse();
  });

  // A *new* surface entering the pane resets it to that surface's own measure.
  // Nothing else may resize: a re-render, the layout PaneForge restored on mount,
  // and the user's own drag all have to stand, or the saved layout is overwritten
  // by the default the moment anything upstream recomputes. The key is what the
  // pane is showing and what it asked for, so only a genuine change fires it.
  let lastCompanionMeasure: string | null = null;
  $effect(() => {
    const paneId = companion?.id;
    const defaultSize = secondaryDefaultSize;
    if (!paneId || !secondaryVisible) {
      lastCompanionMeasure = null;
      return;
    }
    const measure = `${paneId}:${defaultSize}`;
    if (measure === lastCompanionMeasure) return;
    const isFirstMeasure = lastCompanionMeasure === null;
    lastCompanionMeasure = measure;
    // On the first pass the pane's own `defaultSize` prop — or the layout
    // PaneForge restored — already applies. Only a later change is a reset.
    if (isFirstMeasure || maximizedPaneId !== null) return;
    untrack(() => secondaryPane?.resize(defaultSize));
  });
</script>

{#snippet dragBar()}
  <!-- No chrome row at all: the conversation names where you are with the
       SessionBreadcrumb band floating over its own transcript, full-page views
       own their headers, and macOS `hiddenInset` supplies the draggable
       titlebar space. Zero height, so the content starts at the top. -->
  <div class="drag-bar flex-shrink-0">
    <div class="page-drag-strip" aria-hidden="true"></div>
  </div>
{/snippet}

<div
  class="workspace-body flex flex-1 min-w-0 min-h-0"
  class:is-resizing={isResizingSecondary}
  class:sidebar-snap={sidebarSnapForOverlay}
  class:sidebar-collapsed={!sidebarOpen}
  class:page-flush={pageFlush}
  class:project-panel-open={railOpen}
  class:project-panel-collapsed={enableProjectPanel && !railOpen}
  bind:clientWidth={workspaceBodyWidth}
>
  <OuterScrollbar target={active ? outerScrollTarget : null} />
  <!-- `autoSaveId` hands PaneForge the widths outright: it restores the layout on
       mount and writes every drag back itself, which is why no width is measured,
       converted, or stored here. It only works because the constraints below are
       fixed percentages — PaneForge keys a saved layout by them, so a constraint
       derived from the live container width would change the key on every window
       resize and lose the layout it had just saved. -->
  <Resizable.PaneGroup
    direction="horizontal"
    keyboardResizeBy={2}
    autoSaveId="solus-workspace-rail"
    class="workspace-pane-group"
  >
    <Resizable.Pane
      bind:this={sidebarPane}
      order={1}
      defaultSize={sidebarOpen ? SIDEBAR_PANE_DEFAULT_SIZE : 0}
      minSize={SIDEBAR_PANE_MIN_SIZE}
      maxSize={SIDEBAR_PANE_MAX_SIZE}
      collapsedSize={0}
      collapsible
      onCollapse={closeSidebar}
      onExpand={openSidebar}
      aria-hidden={!sidebarOpen}
      class="workspace-rail-pane"
    >
      <SessionSidebar
        open={sidebarOpen}
        managedWidth
        onToggleCollapse={toggleSidebar}
      />
    </Resizable.Pane>
    <!-- The panel is inset 4px and its 1px border paints inward, so its
         centreline sits 4.5px left of the PaneForge boundary. -->
    <Resizable.Handle
      aria-label="Resize sidebar"
      disabled={!sidebarOpen}
      class={`-translate-x-[4.5px] ${!sidebarOpen ? "pointer-events-none opacity-0" : ""}`}
    />

    <Resizable.Pane order={2} class="min-w-0">
      <!-- Conversation view | secondary. The conversation view owns the
           breadcrumb band AND the project rail, so the band spans exactly what
           it belongs to and its right edge tracks the secondary divider in this
           same layout pass — no measured width, no lag. The rail rides inside,
           which is why it needs no collapse rules of its own. -->
      <div
        class="conversation-split relative flex h-full min-h-0 min-w-0"
        bind:clientWidth={conversationSplitWidth}
      >
        <Resizable.PaneGroup
          direction="horizontal"
          keyboardResizeBy={2}
          autoSaveId="solus-workspace-split"
          class="flex-1 min-w-0"
        >
          <Resizable.Pane
            order={1}
            minSize={companionPanes.length > 0 ? primaryMinSize : 100}
            class="min-w-0"
          >
            <div
              class="workspace-column flex h-full min-h-0 min-w-0 flex-col"
              bind:clientWidth={workspaceColumnWidth}
            >
              {@render dragBar()}
              <div class="conversation-view flex min-h-0 min-w-0 flex-1">
                <div
                  class="content-column flex h-full flex-1 flex-col min-h-0 min-w-0 relative"
                >
                  <div class="conversation-card flex-1 flex flex-col min-h-0">
                    <div
                      class="conversation-area flex-1 flex min-h-0 relative"
                      data-conversation-space
                    >
                      <SessionPicker
                        open={active && session.sessionPickerOpen}
                        onClose={() => {
                          session.sessionPickerOpen = false;
                        }}
                      />
                      <TaskPicker
                        open={active && session.taskPickerOpen}
                        onClose={() => {
                          session.taskPickerOpen = false;
                        }}
                      />

                      <div
                        class="primary-column relative flex h-full flex-1 flex-col min-w-0"
                      >
                        {#if showLeadingBand}
                          <SessionBreadcrumb
                            tabId={leadingDraft ? "" : session.activeTabId}
                            draft={leadingDraft}
                            showNewSessionAction={bandOffersNewSession}
                          />
                        {/if}
                        <!-- Frame-level session-expand affordance. Rendered once here so
                 every view shows it in the identical top-left spot instead of
                 each page placing its own. Self-gates via frameChrome (hidden
                 unless the sidebar is collapsed); the lead inset var —
                 published on the collapsed primary-column — clears the mac
                 traffic lights. Conversations rely on it too now: the chrome
                 row that used to carry their sidebar toggle is gone, and the
                 capsule is centred, so nothing collides at the left edge. -->
                        {#if leadingRef?.name !== "settings"}
                          <div
                            class="no-drag absolute left-[var(--solus-chrome-control-left,var(--solus-titlebar-control-left))] top-[var(--solus-titlebar-control-top)] z-20"
                          >
                            <FrameExpandButton variant="sidebar" size="header" />
                          </div>
                        {/if}
                        <!-- Pages, artifacts, and reviews render through the leading Pane
                 below. The conversation pool stays mounted underneath (hidden
                 via display:none) so closing a pane reveals every tab instantly
                 with derived state, scroll, and editor drafts intact — never
                 re-mounted. That is what `keepAlive` declares in the registry:
                 the pool owns a chat's lifecycle, not the route. -->
                        <div
                          class="conversation-pool flex min-h-0 flex-1 flex-col"
                          class:mode-hidden={!poolInLead}
                          onfocusin={() => router.focusPane(leadingPane.id)}
                        >
                          {#each session.tabOrder as tId (tId)}
                            {#if mountedTabIds.has(tId)}
                              <div
                                class="tab-slot h-full"
                                class:tab-hidden={tId !== session.activeTabId}
                              >
                                <ConversationView
                                  tabId={tId}
                                  surfaceVisible={active &&
                                    conversationChromeVisible}
                                  retainTranscriptRows={retainedTranscriptTabIds.has(
                                    tId,
                                  )}
                                />
                              </div>
                            {/if}
                          {/each}
                        </div>
                        {#if !poolInLead}
                          <Pane
                            pane={leadingPane}
                            surfaceVisible={active}
                            {onAttachFile}
                            {onScreenshot}
                            {onDesignMode}
                          />
                        {/if}

                        <div
                          class="input-dock no-drag shrink-0 px-4 pt-2.5 pb-2.5"
                          class:mode-hidden={!conversationChromeVisible}
                          onfocusin={() => router.focusPane(leadingPane.id)}
                        >
                          {@render inputRow()}
                        </div>

                      </div>
                    </div>
                  </div>
                </div>
                <!-- The rail is chrome of THIS conversation and sizes itself
                     against the column. It mounts on first reveal, then hides
                     with display:none while a page, review, or maximized pane
                     covers it — unmounting here made every maximize/restore
                     and page open rebuild the Git/Task sections. A secondary
                     pane minimizes it temporarily without changing the user's
                     persisted preference. -->
                {#if enableProjectPanel && hasMountedProjectRail}
                  <div
                    class="project-rail contents"
                    class:mode-hidden={!locationChromeVisible}
                  >
                    <ProjectPanel
                      sourceId={leadingDraft?.id ?? session.activeTabId}
                      {active}
                      containerWidth={projectRailContainerWidth}
                      {workspaceWidth}
                      minimized={secondaryVisible ||
                        (!leadingStarted && !newTabProjectPanelPoppedOut)}
                      onCollapse={() => toggleProjectPanel()}
                    />
                  </div>
                {/if}
              </div>
            </div>
          </Resizable.Pane>

          {#each companionPanes as pane, index (pane.id)}
            {@const closing = companions.isClosing(pane.id)}
            {@const ref = visibleRef(pane)}
            {@const maximized = session.maximizedPaneId === pane.id}
            {#if !closing}
              <Resizable.Handle
                aria-label="Resize panel"
                disabled={maximized}
                class={maximized ? "pointer-events-none opacity-0" : ""}
                onDraggingChange={handleCompanionDragging}
              />
            {/if}
            <Resizable.Pane
              bind:this={secondaryPane}
              bind:ref={secondaryPaneEl}
              order={index + 2}
              defaultSize={secondaryDefaultSize}
              minSize={secondaryBounds.min}
              maxSize={secondaryBounds.max}
              class={`secondary-pane-wrap relative ${
                closing ? "secondary-pane-wrap--closing" : ""
              } ${
                isFramedRoute(ref) ? "secondary-pane-wrap--framed" : ""
              } ${
                FLUSH_PAGES.has(ref?.name ?? "")
                  ? "secondary-pane-wrap--flush"
                  : ""
              } ${isResizingSecondary ? "is-resizing" : ""}`}
              style={closing ? `width:${secondaryClosingWidth}px` : undefined}
            >
              {#if companions.settled.has(pane.id) || ref?.name === "review"}
                <!-- Maximize fixes THIS element, not the pane wrap: the wrap
                     keeps holding its slot in the split, so the fully-covered
                     workspace behind never relayouts on maximize or restore —
                     only the surface re-measures to the window. -->
                <div
                  class="secondary-pane-content h-full min-h-0"
                  class:secondary-pane-content--maximized={maximized}
                  class:secondary-pane-content--continuous={ref?.name === "review"}
                >
                  <Pane
                    {pane}
                    surfaceVisible={active && secondaryVisible}
                    {onAttachFile}
                    {onScreenshot}
                    {onDesignMode}
                  />
                </div>
              {/if}
            </Resizable.Pane>
          {/each}
        </Resizable.PaneGroup>
      </div>
    </Resizable.Pane>
  </Resizable.PaneGroup>
</div>

{#if homeSessionMenu}
  <SessionContextMenu
    x={homeSessionMenu.x}
    y={homeSessionMenu.y}
    tabId={homeSessionMenu.tabId}
    onClose={() => (homeSessionMenu = null)}
  />
{/if}

<style>
  .workspace-body {
    position: relative;
    /* Where every pane's content box stops, so a composer docked in any pane —
       primary conversation, split chat, diff, review guide — lands on the same
       line. Both pane containers below spend it; nothing else should. */
    --solus-pane-gutter: 8px;
  }
  :global(.workspace-rail-pane) {
    background: var(--solus-container-bg);
    transition: flex-grow 240ms cubic-bezier(0.2, 0, 0, 1);
  }
  :global(
    .workspace-pane-group:has([data-pane-resizer][data-active])
      .workspace-rail-pane
  ) {
    transition: none;
  }
  .drag-bar {
    height: auto;
    flex-shrink: 0;
    position: relative;
  }
  /* Horizontal room the pane's floating chrome cluster (PaneChrome) occupies at
     the top-right. In-content top strips reserve it as padding so their own
     controls never slide under the cluster. Measured off the cluster's real box
     — its 0.625rem right inset, three 1.625rem buttons and the two 0.25rem gaps
     between them — plus one more gap, so a header's last control clears the
     first icon at the cluster's own rhythm instead of touching it. */
  .primary-column,
  :global(.secondary-pane-wrap) {
    --solus-pane-chrome-inset: 6.25rem;
  }
  /* Touch grows every chrome button to 2.75rem (PAGE_ICON_BTN), so the same
     arithmetic gives the cluster proportionally more room. */
  @media (pointer: coarse) {
    .primary-column,
    :global(.secondary-pane-wrap) {
      --solus-pane-chrome-inset: 9.625rem;
    }
  }
  /* The secondary pane is a sibling of the primary one, not a child of
     .content-column, so it has to spend the gutter itself. */
  :global(.secondary-pane-wrap) {
    padding-bottom: var(--solus-pane-gutter);
    opacity: 1;
    /* No resting transform, and none may be added: any transform other than
       `none` makes this wrap the containing block for the `position: fixed`
       maximized surface inside it, so `inset: 0` would resolve to the pane's own
       box and maximize would only ever fill the pane. The exit transition below
       still runs — `none` interpolates as the identity transform. */
    /* No standing will-change here: it pinned every open pane (a full-height
       surface) to its own compositing layer for its whole lifetime to serve a
       180ms close transition the browser layerizes on its own anyway. */
    transition:
      transform 180ms cubic-bezier(0.2, 0, 0, 1),
      opacity 160ms cubic-bezier(0.2, 0, 0, 1);
  }
  /* …unless it holds a full-page surface, whose footer band has to reach the
     window edge the same way it does in the primary slot. */
  :global(.secondary-pane-wrap--flush) {
    padding-bottom: 0;
  }
  :global(.secondary-pane-wrap--closing) {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    flex: none;
    opacity: 0;
    transform: translateX(0.375rem);
    pointer-events: none;
  }
  .secondary-pane-content--maximized {
    position: fixed;
    inset: 0;
    z-index: 10040;
    background: var(--solus-container-bg);
    /* Maximized panes cover the whole window (inset:0), so their top-left lands
       under the macOS traffic lights. Publish the lead inset so the surface's
       leading control strip clears them — this is the "diff fully expanded" and
       "PR review" case. */
    --solus-chrome-lead-inset: var(--solus-traffic-light-inset);
    --solus-page-top-inset: var(--solus-titlebar-height);
  }
  :global(.secondary-pane-wrap--framed) {
    border-left: 1px solid
      color-mix(in srgb, var(--solus-container-border) 45%, transparent);
    /* The thread stays the brighter surface: a pane opened beside it steps back
       by 1.5% so the eye keeps the conversation as the primary object. */
    background: color-mix(in oklch, var(--foreground) 1.5%, var(--card));
  }
  .content-column {
    padding: 0 var(--solus-pane-gutter) var(--solus-pane-gutter) 0;
  }
  .workspace-body.sidebar-collapsed .content-column {
    padding-left: var(--solus-pane-gutter);
  }
  /* With the sidebar collapsed the primary column is the leftmost chrome, so a
     primary-slot pane header or full-page view header sits under the traffic
     lights. Publish the lead inset here (not on the whole content column, which
     also holds the right-hand secondary pane) so only the leftmost surface
     reserves the space. The secondary pane provides its own inset when
     maximized. No-op off the mac editor window (the inset var is 0). */
  .workspace-body.sidebar-collapsed .workspace-column,
  .workspace-body.sidebar-collapsed .primary-column {
    /* The frame toggle owns the first safe app-control slot. Headers beside it
       begin after the complete control + gap, never at the toggle's own x. */
    --solus-chrome-control-left: var(--solus-titlebar-control-left);
    --solus-chrome-lead-inset: var(--solus-titlebar-content-inset);
    --solus-page-top-inset: var(--solus-titlebar-height);
  }
  .workspace-body.project-panel-open .content-column {
    padding-right: 0;
  }
  /* Full-page surfaces (settings, tasks, pull requests) run edge to edge and
     end in their own footer band, so the card gutter reads as that background
     failing to reach the window edge. Drop the padding while one owns the
     primary slot. Declared last so it beats the sidebar-collapsed and
     project-panel rules above (equal specificity). */
  .workspace-body.page-flush .content-column {
    padding: 0;
  }
  .conversation-card {
    background: var(--solus-container-bg);
    overflow: hidden;
  }
  .tab-slot {
    content-visibility: auto;
    contain-intrinsic-size: auto 1000px;
  }
  .tab-hidden,
  .mode-hidden {
    display: none !important;
  }
  .conversation-area {
    overflow: hidden;
  }
  .input-dock {
    contain: layout paint;
  }
  .workspace-body.is-resizing,
  .is-resizing {
    user-select: none;
    cursor: col-resize;
  }
  .workspace-body.is-resizing :global(.side-panel-shell) {
    transition: none;
  }
  /* Overlay-driven sidebar moves snap (see snapSidebarForOverlay): the whole
     workspace relayouts once with the arriving/leaving pane instead of every
     frame for 240ms. */
  .workspace-body.sidebar-snap :global(.workspace-rail-pane),
  .workspace-body.sidebar-snap :global(.side-panel-shell) {
    transition: none;
  }
  /* The rail moves in one layout pass. SidePanel's default is a width/padding
     transition, which cannot reach the compositor: it relayouts this whole
     column — transcript included — on every one of its 240ms, and the rail
     usually moves because the pane took a draft, so a composer is mounting in
     those same frames. The move is the user's own ⌥M or the pane changing under
     them; neither needs narrating. Scoped to the rail: the session sidebar is a
     .side-panel-shell too and keeps its collapse fade. */
  .project-rail :global(.side-panel-shell) {
    transition: none;
  }
  /* While the OS window frame is resizing (maximize, restore, edge drags —
     window.context flags the root), these widths retarget their 240ms
     transitions every frame and rubber-band behind the window edge, then keep
     settling after it stops. Track the window 1:1 instead. */
  :global(html.solus-resizing .workspace-rail-pane),
  :global(html.solus-resizing .side-panel-shell),
  :global(html.solus-resizing .secondary-pane-wrap) {
    transition: none;
  }
  /* The surface mounts one beat after the pane shell (companions.settled);
     a compositor-only fade turns that mount from a pop into a reveal. */
  .secondary-pane-content {
    animation: secondary-content-in 160ms cubic-bezier(0.2, 0, 0, 1) backwards;
  }
  /* Review mounts its async outlet immediately and paints a final-shape
     skeleton. Fading that outlet from opacity:0 would reveal the framed pane's
     stepped background before drawing the container-colour surface. */
  .secondary-pane-content--continuous {
    animation: none;
  }
  @keyframes secondary-content-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .secondary-pane-content {
      animation: none;
    }
    :global(.workspace-rail-pane),
    :global(.secondary-pane-wrap) {
      transition: none;
    }
  }
  /* Slim drag handle shown on full-page views in place of the tab strip. */
  .page-drag-strip {
    height: 0;
  }
  .mode-hidden {
    display: none !important;
  }
</style>
