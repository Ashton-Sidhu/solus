<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    getWindowContext,
    getRunStore,
    getRunDockStore,
    getSettingsContext,
    getSessionEnvironmentStore,
    environmentBranchKey,
  } from "../../contexts";
  import ProjectPanel from "../project-panel/ProjectPanel.svelte";
  import RunDock from "../run/RunDock.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SessionSidebar from "../session/SessionSidebar.svelte";
  import FrameExpandButton from "./FrameExpandButton.svelte";
  import OuterScrollbar from "./OuterScrollbar.svelte";
  import TabStrip from "./TabStrip.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import Pane from "../ui/Pane.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import NewTabHome from "./NewTabHome.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { frameChrome } from "./frame-chrome.store.svelte";
  import {
    DEFAULT_PANEL_WIDTH,
    isArtifactContent,
    isMovableContent,
    isPageContent,
    type PaneContent,
    type PaneSlot,
  } from "../../contexts/workspace/pane-view.store.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    clampSecondaryPaneWidth,
    defaultWorkspaceRailWidth,
    focusedSplitChatTabId,
    hasStartedConversation,
    isSecondaryContentVisible,
    listSidebarPrimaryWidth,
    MIN_LIST_PRIMARY_PANE_WIDTH,
    MIN_PRIMARY_PANE_WIDTH,
    primaryPaneMinSize,
    primaryProjectPanelOpen,
    retainedConversationTabIds,
    secondaryPaneBounds,
    secondaryPaneDefaultSize,
    SECONDARY_CONTENT_DELAY_MS,
    SECONDARY_SHELL_EXIT_MS,
    visibleWorkspaceTabIds,
  } from "./lib/workspace-body";
  import { isProjectRailOpen } from "../project-panel/lib/rail-width";
  import * as Resizable from "../ui/resizable";
  import {
    paneBoundsPercent,
    percentToPixels,
    pixelsToPercent,
  } from "../../lib/resizablePane";
  import { provideOuterScrollbarContext } from "./lib/outer-scrollbar.context";

  interface Props {
    /** Whether this body is the active layout (drives keybindings + chrome reporting). */
    active: boolean;
    /** Show the right-hand ProjectPanel + its keybinding. */
    enableProjectPanel: boolean;
    /** Allow the floating run-log dock + its keybinding. */
    enableRunDock: boolean;
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
    enableRunDock,
    inputRow,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const settings = getSettingsContext();
  const runStore = getRunStore();
  const runDock = getRunDockStore();
  const environmentStore = getSessionEnvironmentStore();
  const panes = session.panes;
  let outerScrollTargets = $state<HTMLElement[]>([]);
  let outerScrollTarget = $state<HTMLElement | null>(null);

  provideOuterScrollbarContext({
    register(element) {
      if (!outerScrollTargets.includes(element)) outerScrollTargets.push(element);
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
  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const hasStartedSession = $derived(hasStartedConversation(sess));
  const activeProjectPanelTabKey = $derived(session.activeTabId || "new-tab-home");
  let projectPanelPopoutTabKey = $state<string | null>(null);
  const newTabProjectPanelPoppedOut = $derived(
    projectPanelPopoutTabKey === activeProjectPanelTabKey,
  );
  const isPrimaryProjectPanelOpen = $derived(
    primaryProjectPanelOpen(
      hasStartedSession,
      settings.projectPanelOpen,
      newTabProjectPanelPoppedOut,
    ),
  );
  // Popping the rail out on a fresh tab is intentionally transient. Starting
  // that session or moving to another tab returns control to the normal rule.
  $effect(() => {
    if (
      hasStartedSession ||
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
    environmentStore.environmentFor(focusedChatTabId),
  );
  const canShowFocusedDiffPanel = $derived(!!focusedEnvironment.cwd);
  const secondaryVisible = $derived.by(() =>
    isSecondaryContentVisible(panes.secondaryVisible, session),
  );
  const secondaryCollapsesSidebar = $derived(
    secondaryVisible && panes.secondaryVisible.kind !== "automation",
  );
  const primaryReviewOpen = $derived(panes.primaryContent.kind === "review");
  const sidebarOpenForChrome = $derived(
    sidebarOpen || secondaryCollapsesSidebar,
  );

  // The tab strip, the composer and the project rail are one set of chrome: all
  // three belong to a conversation in the primary slot. Any non-conversation
  // content — a page, artifact, or review — covers the conversation pool (hidden,
  // never unmounted) and its composer, and a maximized secondary (e.g. the
  // full-screen PR-review surface) covers the whole column, so the composer has
  // nothing to dock to. They step aside together rather than each being told to.
  const conversationChromeVisible = $derived(
    panes.primaryContent.kind === "conversation" && !panes.maximized,
  );
  // Run dock scope mirrors ProjectPanel: prefer the active session's worktree.
  const runCwd = $derived(
    sess?.gitContext?.worktreePath ??
      sess?.workingDirectory ??
      session.globalDefaults.workingDirectory,
  );
  const dockRuns = $derived(runStore.runsFor(runCwd) ?? []);
  const showRunDock = $derived(
    active && enableRunDock && runDock.open && conversationChromeVisible && dockRuns.length > 0,
  );

  const visibleTabIds = $derived.by(() =>
    visibleWorkspaceTabIds(
      session,
      session.activeTabId,
      panes.chatTabIn("secondary", session.activeTabId),
      (tabId) =>
        environmentBranchKey(
          session.environment.environmentFor(tabId),
          session.sessionFor(tabId)?.projectGroupPath,
      ),
    ),
  );

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
  let conversationAreaEl: HTMLDivElement | undefined = $state();
  // Measured so the floating run dock clears the input bar even as it grows
  // with multi-line input, instead of relying on a fixed bottom offset.
  let inputDockHeight = $state(0);
  let isResizingSecondary = $state(false);

  // Scale the sidebar with the viewport instead of two coarse breakpoints:
  // narrower on laptops (more room for the conversation), wider on large
  // displays so it doesn't look anemic beside a wide thread. ~19% of the
  // viewport, bounded to a usable band. The project rail scales the same way,
  // but against its conversation view — see project-panel/lib/rail-width.
  const initialViewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1440;
  const defaultSidebarWidth = defaultWorkspaceRailWidth(initialViewportWidth);

  let sidebarOpen = $state(true);
  let sidebarClosedForOverlay = $state(false);

  const sidebarBounds = $derived(
    paneBoundsPercent(workspaceBodyWidth, 160, 400),
  );
  const sidebarDefaultSize = $derived(
    workspaceBodyWidth > 0
      ? pixelsToPercent(defaultSidebarWidth, workspaceBodyWidth)
      : 19,
  );

  // Run dock height (persisted). The dock overlays the conversation above the
  // input bar; dragging its top edge resizes it without reflowing content.
  let dockHeight = $state(settings.runDockHeight);
  let isResizingDock = $state(false);
  let dockResizeStartY = 0;
  let dockResizeStartHeight = 0;
  const minDockHeight = 96;
  const effectiveDockHeight = $derived(Math.max(minDockHeight, dockHeight));

  // Seed open state from settings once; mirror future changes back.
  runDock.open = settings.runDockOpen;

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
    if (!sidebarOpen) {
      openSidebar();
    } else {
      closeSidebar();
    }
  }

  // Each conversation view owns its rail, so the shortcut acts on the one the
  // user is in. The tab strip's button only ever reaches the primary — it lives
  // in the primary's chrome; the split chat carries its own toggle.
  function toggleProjectPanel(slot: PaneSlot = "primary") {
    if (slot === "secondary") {
      settings.update({
        splitProjectPanelOpen: !settings.splitProjectPanelOpen,
      });
      return;
    }
    if (!hasStartedSession) {
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
  // Full-page views never host a split chat, so this only ever means the primary.
  frameChrome.expandProjectPanel = () => toggleProjectPanel("primary");
  $effect(() => {
    frameChrome.sidebarOpen = active ? sidebarOpenForChrome : true;
    frameChrome.projectPanelOpen = active ? isPrimaryProjectPanelOpen : true;
  });

  useKeybinding("global.toggle-sidebar", () => toggleSidebar(), {
    enabled: () => active,
  });
  useKeybinding(
    "global.toggle-project-panel",
    () =>
      toggleProjectPanel(
        panes.secondaryContent.kind === "conversation"
          ? panes.focusedPane
          : "primary",
      ),
    { enabled: () => active && enableProjectPanel },
  );
  useKeybinding(
    "global.new-split-chat",
    async () => {
      if (panes.secondaryContent.kind === "conversation") {
        session.closeSplitChat();
        requestInputFocus();
        return;
      }
      const tabId = await session.createTab(undefined, { activate: false, via: "keybinding" });
      session.openTabInSplit(tabId);
      requestInputFocus({ tabId });
    },
    { enabled: () => active },
  );
  useKeybinding(
    "global.toggle-files",
    () => {
      if (panes.secondaryOverlay?.kind === "files") panes.closeOverlay();
      else {
        panes.openFiles(
          focusedChatTabId,
          focusedEnvironment.cwd,
          focusedEnvironment.checkout,
        );
      }
      requestInputFocus();
    },
    { enabled: () => active && canShowFocusedDiffPanel },
  );
  useKeybinding(
    "global.open-in-split",
    () => {
      if (isMovableContent(panes.primaryContent)) {
        panes.moveToOppositeSlot(panes.primaryContent, "primary");
      } else if (isMovableContent(panes.secondaryContent)) {
        panes.moveToOppositeSlot(panes.secondaryContent, "secondary");
      } else if (
        panes.secondaryContent.kind === "conversation" &&
        panes.secondaryContent.tabId
      ) {
        // Promote the split chat back into the primary tab pool.
        session.promoteSplitToMainTab();
      } else if (panes.primaryContent.kind === "conversation" && tab) {
        // Plain conversation: split the active chat off to the side.
        session.openTabInSplit(tab.id);
      } else {
        return;
      }
      requestInputFocus();
    },
    { enabled: () => active },
  );

  function startDockResize(e: MouseEvent) {
    isResizingDock = true;
    dockResizeStartY = e.clientY;
    // Seed from the on-screen (clamped) height so the drag tracks the cursor
    // immediately, even when the persisted height exceeds this window's cap.
    dockResizeStartHeight = effectiveDockHeight;
    pendingDockHeight = effectiveDockHeight;
    e.preventDefault();
  }

  function handleDockResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      dockHeight = Math.max(minDockHeight, effectiveDockHeight + step);
      settings.update({ runDockHeight: dockHeight });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      dockHeight = Math.max(minDockHeight, effectiveDockHeight - step);
      settings.update({ runDockHeight: dockHeight });
    }
  }

  const secondaryContainerWidth = $derived(
    conversationSplitWidth || windowCtx.workAreaWidth,
  );
  // A PR review docks beside the PR inbox, which is a list sidebar rather than
  // a chat column — it gets the narrower floor so the review keeps the width.
  const primaryIsListSidebar = $derived(
    isPageContent(panes.primaryContent) &&
      panes.primaryContent.kind === "prs" &&
      panes.secondaryContent.kind === "pr-review",
  );
  const minPrimaryWidth = $derived(
    primaryIsListSidebar ? MIN_LIST_PRIMARY_PANE_WIDTH : MIN_PRIMARY_PANE_WIDTH,
  );
  const autoSecondaryWidth = $derived.by(() =>
    clampSecondaryPaneWidth(
      primaryIsListSidebar
        ? secondaryContainerWidth -
            listSidebarPrimaryWidth(secondaryContainerWidth)
        : Math.round(secondaryContainerWidth * panes.secondaryRatio),
      secondaryContainerWidth,
      minPrimaryWidth,
    ),
  );
  const secondaryBounds = $derived(
    secondaryPaneBounds(secondaryContainerWidth, minPrimaryWidth),
  );
  const primaryMinSize = $derived(
    primaryPaneMinSize(secondaryContainerWidth, minPrimaryWidth),
  );
  const secondaryDefaultSize = $derived.by(() => {
    const width = panes.hasResized ? panes.secondaryWidth : autoSecondaryWidth;
    return secondaryPaneDefaultSize(
      width,
      secondaryContainerWidth,
      secondaryBounds,
    );
  });

  function handleSecondaryLayout(layout: number[]) {
    if (layout.length !== 2 || conversationSplitWidth <= 0) return;
    panes.secondaryWidth = clampSecondaryPaneWidth(
      percentToPixels(layout[1], conversationSplitWidth),
      conversationSplitWidth,
      minPrimaryWidth,
    );
  }

  function handleSecondaryDragging(dragging: boolean) {
    isResizingSecondary = dragging;
    if (!dragging) return;
    panes.hasResized = true;
    if (panes.maximized) panes.maximized = false;
  }

  let panelResizeRaf = 0;
  // Scratch value; seeded in startDockResize before the rAF reads it.
  let pendingDockHeight = 0;

  function schedulePanelResizeCommit() {
    if (panelResizeRaf) return;
    panelResizeRaf = requestAnimationFrame(() => {
      panelResizeRaf = 0;
      if (isResizingDock) dockHeight = pendingDockHeight;
    });
  }

  function handleMouseMove(e: MouseEvent) {
    if (isResizingDock) {
      // Dragging the top edge up grows the dock.
      const delta = dockResizeStartY - e.clientY;
      pendingDockHeight = Math.max(
        minDockHeight,
        dockResizeStartHeight + delta,
      );
      schedulePanelResizeCommit();
      return;
    }
  }

  function handleMouseUp() {
    if (panelResizeRaf) {
      cancelAnimationFrame(panelResizeRaf);
      panelResizeRaf = 0;
    }
    if (isResizingDock) {
      dockHeight = pendingDockHeight;
      settings.update({ runDockHeight: dockHeight });
    }
    isResizingDock = false;
  }

  let renderSecondaryShell = $state(false);
  let renderSecondaryContent = $state(false);
  let secondaryPaneClosing = $state(false);
  let secondaryClosingWidth = $state(DEFAULT_PANEL_WIDTH);
  let displayedSecondaryContent = $state<PaneContent>({ kind: "empty" });
  let secondaryContentTimer: ReturnType<typeof setTimeout> | null = null;
  let secondaryShellTimer: ReturnType<typeof setTimeout> | null = null;
  function requestSplitFocusAfterRender(content: PaneContent) {
    const tabId = focusedSplitChatTabId(
      content,
      panes.focusedPane,
      panes.chatTabIn("secondary", session.activeTabId),
    );
    if (!tabId) return;
    requestAnimationFrame(() => {
      const currentSplitTabId = panes.chatTabIn("secondary", session.activeTabId);
      if (focusedSplitChatTabId(content, panes.focusedPane, currentSplitTabId)) {
        requestInputFocus({ tabId });
      }
    });
  }

  $effect(() => {
    if (!secondaryVisible) {
      if (secondaryContentTimer) {
        clearTimeout(secondaryContentTimer);
        secondaryContentTimer = null;
      }
      if (!renderSecondaryShell) return;
      secondaryClosingWidth =
        secondaryPaneEl?.clientWidth || secondaryClosingWidth;
      secondaryPaneClosing = true;
      const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches;
      secondaryShellTimer = setTimeout(
        () => {
          secondaryShellTimer = null;
          renderSecondaryShell = false;
          renderSecondaryContent = false;
          secondaryPaneClosing = false;
          displayedSecondaryContent = { kind: "empty" };
        },
        reduce ? 0 : SECONDARY_SHELL_EXIT_MS,
      );
      return;
    }

    if (secondaryShellTimer) {
      clearTimeout(secondaryShellTimer);
      secondaryShellTimer = null;
    }
    displayedSecondaryContent = panes.secondaryVisible;
    renderSecondaryShell = true;
    secondaryPaneClosing = false;

    if (renderSecondaryContent) {
      requestSplitFocusAfterRender(displayedSecondaryContent);
      return;
    }
    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches;
    secondaryContentTimer = setTimeout(
      () => {
        secondaryContentTimer = null;
        renderSecondaryContent = true;
        requestSplitFocusAfterRender(displayedSecondaryContent);
      },
      reduce ? 0 : SECONDARY_CONTENT_DELAY_MS,
    );

    return () => {
      if (secondaryContentTimer) {
        clearTimeout(secondaryContentTimer);
        secondaryContentTimer = null;
      }
      if (secondaryShellTimer) {
        clearTimeout(secondaryShellTimer);
        secondaryShellTimer = null;
      }
    };
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
      conversationChromeVisible &&
      isProjectRailOpen(
        isPrimaryProjectPanelOpen,
        projectRailContainerWidth,
        secondaryVisible,
      ),
  );

  function toggleSecondaryMaximize() {
    panes.maximized = !panes.maximized;
  }

  // Collapse the session sidebar while a full-width overlay is up — a secondary
  // pane, review guide, Workspace, or Settings — and restore it on close, the
  // same way the diff panel reclaims the width.
  $effect(() => {
    if (
      secondaryCollapsesSidebar ||
      primaryReviewOpen ||
      session.workspacePageOpen ||
      session.settingsOpen
    ) {
      if (sidebarOpen) {
        sidebarClosedForOverlay = true;
        closeSidebar();
      }
    } else if (sidebarClosedForOverlay) {
      sidebarClosedForOverlay = false;
      openSidebar();
    }
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

  // Opening a new secondary surface deliberately resets to its content-specific
  // ratio. Once the user drags, PaneForge keeps that manual layout until the next
  // surface open resets `hasResized` in PaneViewStore.
  $effect(() => {
    const pane = secondaryPane;
    const defaultSize = secondaryDefaultSize;
    if (!pane || !secondaryVisible || panes.hasResized || panes.maximized) return;
    pane.resize(defaultSize);
  });
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

{#snippet dragBar()}
  <div class="drag-bar flex-shrink-0">
    {#if conversationChromeVisible}
      <TabStrip
        variant="editor"
        tabIds={visibleTabIds}
        sidebarOpen={sidebarOpenForChrome}
        onToggleSidebar={toggleSidebar}
        projectPanelOpen={enableProjectPanel
          ? isPrimaryProjectPanelOpen
          : undefined}
        onToggleProjectPanel={enableProjectPanel
          ? () => toggleProjectPanel("primary")
          : undefined}
      />
    {:else}
      <!-- Full-page views own their page chrome. The OS header now provides
           the draggable titlebar space, so don't reserve an internal row. -->
      <div class="page-drag-strip" aria-hidden="true"></div>
    {/if}
  </div>
{/snippet}

<div
  class="workspace-body flex flex-1 min-w-0 min-h-0"
  class:is-resizing={isResizingSecondary}
  class:is-resizing-dock={isResizingDock}
  class:sidebar-collapsed={!sidebarOpen}
  class:page-flush={panes.primaryContent.kind === "settings" ||
    primaryIsListSidebar}
  class:project-panel-open={railOpen}
  class:project-panel-collapsed={enableProjectPanel && !railOpen}
  bind:clientWidth={workspaceBodyWidth}
>
  <OuterScrollbar target={active ? outerScrollTarget : null} />
  <Resizable.PaneGroup
    direction="horizontal"
    keyboardResizeBy={2}
    class="workspace-pane-group"
  >
    <Resizable.Pane
      bind:this={sidebarPane}
      order={1}
      defaultSize={sidebarOpen ? sidebarDefaultSize : 0}
      minSize={sidebarBounds.min}
      maxSize={sidebarBounds.max}
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
    <Resizable.Handle
      aria-label="Resize sidebar"
      disabled={!sidebarOpen}
      class={!sidebarOpen ? "pointer-events-none opacity-0" : ""}
    />

    <Resizable.Pane order={2} class="min-w-0">
      <!-- Conversation view | secondary. The conversation view owns the tab strip
           AND the project rail, so the strip spans exactly what it belongs to and
           its right edge tracks the secondary divider in this same layout pass —
           no measured width, no lag. The rail rides inside, which is why it needs
           no collapse rules of its own. -->
      <div
        class="conversation-split relative flex h-full min-h-0 min-w-0"
        bind:clientWidth={conversationSplitWidth}
      >
        <Resizable.PaneGroup
          direction="horizontal"
          keyboardResizeBy={2}
          class="flex-1 min-w-0"
          onLayoutChange={handleSecondaryLayout}
        >
          <Resizable.Pane
            order={1}
            minSize={renderSecondaryShell ? primaryMinSize : 100}
            class="min-w-0"
          >
            <div
              class="workspace-column flex h-full min-h-0 min-w-0 flex-col"
              bind:clientWidth={workspaceColumnWidth}
            >
              {@render dragBar()}
              <div class="conversation-view flex min-h-0 min-w-0 flex-1">
      <div class="content-column flex h-full flex-1 flex-col min-h-0 min-w-0 relative">
    <div class="conversation-card flex-1 flex flex-col min-h-0">
      <!-- Tagged so modals portaled into the global overlay layer (the directory
           picker) can centre on the conversation instead of the window. -->
      <div
        class="conversation-area flex-1 flex min-h-0 relative"
        data-conversation-space
        bind:this={conversationAreaEl}
      >
        <SessionPicker
          open={active && session.sessionPickerOpen}
          onClose={() => {
            session.sessionPickerOpen = false;
          }}
          portalTarget={conversationAreaEl}
        />

          <div class="primary-column relative flex h-full flex-1 flex-col min-w-0">
            <!-- Frame-level session-expand affordance. Rendered once here so
                 full-page views other than settings show it in the identical
                 top-left spot instead of each page placing its own. Self-gates
                 via frameChrome (hidden unless the sidebar is collapsed); the
                 lead inset var — published on the collapsed primary-column —
                 clears the mac traffic lights. Scoped to a non-conversation
                 primary so it never overlaps the conversation's TabStrip,
                 which carries its own sidebar toggle. -->
            {#if panes.primaryContent.kind !== "conversation" &&
              panes.primaryContent.kind !== "settings"}
              <div
                class="no-drag absolute left-[max(0.625rem,var(--solus-chrome-lead-inset,0px))] top-2.5 z-20"
              >
                <FrameExpandButton variant="sidebar" />
              </div>
            {/if}
            <!-- Pages, artifacts, and reviews render through the primary Pane
                 below. The conversation pool stays mounted underneath (hidden
                 via display:none) so closing a pane reveals every tab instantly
                 with derived state, scroll, and editor drafts intact — never
                 re-mounted. -->
            <div
              class="conversation-pool flex-1 flex flex-col min-h-0 no-drag"
              class:mode-hidden={panes.primaryContent.kind !== "conversation"}
              onfocusin={() => panes.focusPane("primary")}
            >
              {#if session.tabOrder.length === 0}
                <NewTabHome />
              {/if}
              {#each session.tabOrder as tId (tId)}
                {#if mountedTabIds.has(tId)}
                  <div
                    class="tab-slot h-full"
                    class:tab-hidden={tId !== session.activeTabId}
                  >
                    <ConversationView
                      tabId={tId}
                      surfaceVisible={active && conversationChromeVisible}
                      retainTranscriptRows={retainedTranscriptTabIds.has(tId)}
                      onDiffToggle={() =>
                        panes.toggleDiff(
                          !!session.sessionFor(tId)?.workingDirectory,
                          tId,
                        )}
                    />
                  </div>
                {/if}
              {/each}
            </div>
            {#if panes.primaryContent.kind !== "conversation"}
              <Pane
                content={panes.primaryContent}
                slot="primary"
                surfaceVisible={active}
                {onAttachFile}
                {onScreenshot}
                {onDesignMode}
              />
            {/if}

            {#if showRunDock}
              <div
                class="run-dock-wrap no-drag"
                style="height:{effectiveDockHeight}px;bottom:{inputDockHeight +
                  8}px"
              >
                <button
                  type="button"
                  class="dock-resize-handle"
                  onmousedown={startDockResize}
                  onkeydown={handleDockResizeKey}
                  aria-label="Resize run logs"
                ></button>
                <RunDock cwd={runCwd} />
              </div>
            {/if}

            <div
              class="input-dock no-drag shrink-0 px-4 pt-2.5 pb-2.5"
              class:mode-hidden={!conversationChromeVisible}
              bind:clientHeight={inputDockHeight}
              onfocusin={() => panes.focusPane("primary")}
            >
              {@render inputRow()}
            </div>
          </div>
      </div>
    </div>
      </div>
                <!-- The rail is chrome of THIS conversation, so it mounts and
                     unmounts with the tab strip and sizes itself against the
                     column. A secondary pane minimizes it temporarily without
                     changing the user's persisted preference. -->
                {#if enableProjectPanel && conversationChromeVisible}
                  <ProjectPanel
                    tabId={session.activeTabId}
                    slot="primary"
                    {active}
                    containerWidth={projectRailContainerWidth}
                    minimized={secondaryVisible ||
                      (!hasStartedSession && !newTabProjectPanelPoppedOut)}
                  />
                {/if}
              </div>
            </div>
          </Resizable.Pane>

          {#if renderSecondaryShell}
            {#if secondaryVisible}
              <Resizable.Handle
                aria-label="Resize panel"
                disabled={panes.maximized}
                class={panes.maximized ? "pointer-events-none opacity-0" : ""}
                onDraggingChange={handleSecondaryDragging}
              />
            {/if}
            <Resizable.Pane
              bind:this={secondaryPane}
              bind:ref={secondaryPaneEl}
              order={2}
              defaultSize={secondaryDefaultSize}
              minSize={secondaryBounds.min}
              maxSize={secondaryBounds.max}
              class={`secondary-pane-wrap relative ${panes.maximized
                ? "secondary-pane-wrap--maximized"
                : ""} ${secondaryPaneClosing
                ? "secondary-pane-wrap--closing"
                : ""} ${isArtifactContent(displayedSecondaryContent) ||
              displayedSecondaryContent.kind === "review" ||
              isPageContent(displayedSecondaryContent)
                ? "secondary-pane-wrap--framed"
                : ""} ${isResizingSecondary ? "is-resizing" : ""}`}
              style={secondaryPaneClosing
                ? `width:${secondaryClosingWidth}px`
                : undefined}
            >
              {#if renderSecondaryContent}
                <div class="secondary-pane-content h-full min-h-0">
                  <Pane
                    content={displayedSecondaryContent}
                    slot="secondary"
                    surfaceVisible={active && secondaryVisible}
                    {onAttachFile}
                    {onScreenshot}
                    {onDesignMode}
                    onToggleSecondaryMaximize={toggleSecondaryMaximize}
                  />
                </div>
              {/if}
            </Resizable.Pane>
          {/if}
        </Resizable.PaneGroup>
      </div>
    </Resizable.Pane>
  </Resizable.PaneGroup>
</div>

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
     controls never slide under the cluster. */
  .primary-column,
  :global(.secondary-pane-wrap) {
    --solus-pane-chrome-inset: 5.5rem;
  }
  /* The secondary pane is a sibling of the primary one, not a child of
     .content-column, so it has to spend the gutter itself. */
  :global(.secondary-pane-wrap) {
    padding-bottom: var(--solus-pane-gutter);
    opacity: 1;
    transform: translateX(0);
    transition:
      transform 180ms cubic-bezier(0.2, 0, 0, 1),
      opacity 160ms cubic-bezier(0.2, 0, 0, 1);
    will-change: transform, opacity;
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
  :global(.secondary-pane-wrap--maximized) {
    position: fixed;
    inset: 0;
    z-index: 10040;
    background: var(--solus-container-bg);
    /* Maximized panes cover the whole window (inset:0), so their top-left lands
       under the macOS traffic lights. Publish the lead inset so the surface's
       leading control strip clears them — this is the "diff fully expanded" and
       "PR review" case. */
    --solus-chrome-lead-inset: var(--solus-traffic-light-inset);
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
    --solus-chrome-lead-inset: var(--solus-traffic-light-inset);
  }
  .workspace-body.project-panel-open .content-column {
    padding-right: 0;
  }
  /* Settings and the docked PR inbox both own edge-to-edge surfaces, so the
     card gutter reads as their background failing to reach the window edge.
     Drop the padding while either owns the primary slot. Declared last so it
     beats the sidebar-collapsed and project-panel rules above (equal
     specificity). */
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
  .workspace-body.is-resizing-dock {
    user-select: none;
    cursor: row-resize;
  }
  .workspace-body.is-resizing :global(.side-panel-shell) {
    transition: none;
  }
  /* Slim drag handle shown on full-page views in place of the tab strip. */
  .page-drag-strip {
    height: 0;
  }
  .mode-hidden {
    display: none !important;
  }
  /* ── Run log dock overlay ── */
  .run-dock-wrap {
    position: absolute;
    left: 16px;
    right: 16px;
    /* `bottom` is set inline from the measured input-bar height so the panel
       floats just above the input dock as it grows. */
    z-index: 25;
    display: flex;
    flex-direction: column;
    min-height: 0;
    pointer-events: none;
  }
  /* The resize zone straddles the card's top border without adding visual chrome. */
  .dock-resize-handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 10px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: row-resize;
    z-index: 26;
    transform: translateY(-5px);
    pointer-events: auto;
  }
  .dock-resize-handle:focus-visible {
    outline: none;
  }
  .run-dock-wrap :global(.run-dock) {
    pointer-events: auto;
  }
</style>
