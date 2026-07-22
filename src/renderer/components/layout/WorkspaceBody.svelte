<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    getWindowContext,
    getRunStore,
    getRunDockStore,
    getSettingsContext,
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
  } from "../../contexts/workspace/pane-view.store.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    clampSecondaryPaneWidth,
    defaultWorkspaceRailWidth,
    focusedSplitChatTabId,
    isSecondaryContentVisible,
    primaryPaneMinSize,
    secondaryPaneBounds,
    secondaryPaneDefaultSize,
    SECONDARY_CONTENT_DELAY_MS,
    SECONDARY_SHELL_EXIT_MS,
    shouldCollapseProjectPanelForSecondary,
    visibleWorkspaceTabIds,
  } from "./lib/workspace-body";
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
  const focusedChatTabId = $derived(
    session.focusedChatTabId ?? session.activeTabId,
  );
  const focusedSess = $derived(session.sessionFor(focusedChatTabId));
  const canShowFocusedDiffPanel = $derived(!!focusedSess?.workingDirectory);
  const secondaryVisible = $derived.by(() =>
    isSecondaryContentVisible(panes.secondaryVisible, session),
  );
  const secondaryCollapsesProjectPanel = $derived(
    shouldCollapseProjectPanelForSecondary(panes.secondaryVisible, secondaryVisible),
  );
  const secondaryCollapsesSidebar = $derived(
    secondaryVisible && panes.secondaryVisible.kind !== "automation",
  );
  const primaryReviewOpen = $derived(panes.primaryContent.kind === "review");
  const sidebarOpenForChrome = $derived(
    sidebarOpen || secondaryCollapsesSidebar,
  );

  // Any non-conversation content in the primary slot — a page, artifact, or
  // review — covers the conversation pool (hidden, never unmounted) and its
  // composer. A maximized secondary (e.g. the full-screen PR-review surface)
  // covers the whole column too, so the composer has nothing to dock to.
  const inputDockHidden = $derived(
    panes.primaryContent.kind !== "conversation" || panes.maximized,
  );
  // Run dock scope mirrors ProjectPanel: prefer the active session's worktree.
  const runCwd = $derived(
    sess?.gitContext?.worktreePath ??
      sess?.workingDirectory ??
      session.globalDefaults.workingDirectory,
  );
  const dockRuns = $derived(runStore.runsFor(runCwd) ?? []);
  const showRunDock = $derived(
    enableRunDock && runDock.open && !inputDockHidden && dockRuns.length > 0,
  );

  const splitTabId = $derived(
    panes.chatTabIn("secondary", session.activeTabId),
  );
  const visibleTabIds = $derived.by(() =>
    visibleWorkspaceTabIds(session, sess, splitTabId),
  );

  // Lazy-mount the conversation pool: only mount a tab's ConversationView the
  // first time it becomes the active tab (or is visible on load). This prevents
  // 20 heavy component trees from being constructed and kept alive in memory
  // for tabs the user may never actually visit in the current session.
  // Start empty — the $effect below populates it reactively so Svelte tracks
  // `visibleTabIds` properly rather than only capturing the initial value.
  const mountedTabIds = new SvelteSet<string>();
  $effect(() => {
    for (const id of visibleTabIds) mountedTabIds.add(id);
    for (const id of mountedTabIds) {
      if (!session.tabs[id]) mountedTabIds.delete(id);
    }
  });

  let secondaryPaneEl: HTMLDivElement | null = $state(null);
  let secondaryPane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  let sidebarPane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  let projectPanelPane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  let workspaceBodyWidth = $state(0);
  let conversationAreaEl: HTMLDivElement | undefined = $state();
  let conversationAreaWidth = $state(0);
  // Measured so the floating run dock clears the input bar even as it grows
  // with multi-line input, instead of relying on a fixed bottom offset.
  let inputDockHeight = $state(0);
  let isResizingSecondary = $state(false);

  // Scale the rails with the viewport instead of two coarse breakpoints:
  // narrower on laptops (more room for the conversation), wider on large
  // displays so the rails don't look anemic beside a wide thread. Both rails
  // share one width; ~19% of the viewport, bounded to a usable band.
  const initialViewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1440;
  const defaultSidebarWidth = defaultWorkspaceRailWidth(initialViewportWidth);

  let sidebarOpen = $state(true);
  let sidebarClosedForOverlay = $state(false);

  let projectPanelOpen = $state(settings.projectPanelOpen);
  const maxProjectPanelWidth = DEFAULT_PANEL_WIDTH;
  let projectPanelClosedForSecondary = $state(false);

  const sidebarBounds = $derived(
    paneBoundsPercent(workspaceBodyWidth, 160, 400),
  );
  const projectPanelBounds = $derived(
    paneBoundsPercent(workspaceBodyWidth, 240, maxProjectPanelWidth),
  );
  const sidebarDefaultSize = $derived(
    workspaceBodyWidth > 0
      ? pixelsToPercent(defaultSidebarWidth, workspaceBodyWidth)
      : 19,
  );
  const projectPanelDefaultSize = $derived(
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

  function closeProjectPanel() {
    projectPanelOpen = false;
    projectPanelPane?.collapse();
    settings.update({ projectPanelOpen: false });
    requestInputFocus();
  }

  function openProjectPanel() {
    projectPanelOpen = true;
    projectPanelPane?.expand();
    settings.update({ projectPanelOpen: true });
  }

  function toggleProjectPanel() {
    if (!projectPanelOpen) {
      openProjectPanel();
    } else {
      closeProjectPanel();
    }
  }

  // Publish the frame-level expand controls so full-page sub-views (Folio,
  // Plans, Settings) can host them inline in their own headers instead of in a
  // separate chrome strip. This body stays the source of truth; this mirrors
  // its state and registers the toggles for those headers to call. When this
  // body is inactive (pill / mobile), report the panels as open so those
  // headers don't offer to expand chrome that isn't on screen.
  frameChrome.expandSidebar = toggleSidebar;
  frameChrome.expandProjectPanel = toggleProjectPanel;
  $effect(() => {
    frameChrome.sidebarOpen = active ? sidebarOpenForChrome : true;
    frameChrome.projectPanelOpen = active ? projectPanelOpen : true;
  });

  useKeybinding("global.toggle-sidebar", () => toggleSidebar(), {
    enabled: () => active,
  });
  useKeybinding("global.toggle-project-panel", () => toggleProjectPanel(), {
    enabled: () => active && enableProjectPanel,
  });
  useKeybinding(
    "global.new-split-chat",
    async () => {
      const tabId = await session.createTab(undefined, { activate: false });
      session.openTabInSplit(tabId);
      requestInputFocus({ tabId });
    },
    { enabled: () => active },
  );
  useKeybinding(
    "global.toggle-files",
    () => {
      if (panes.secondaryOverlay?.kind === "files") panes.closeOverlay();
      else panes.openFiles(focusedChatTabId);
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
    conversationAreaWidth || conversationAreaEl?.clientWidth || windowCtx.workAreaWidth,
  );
  const autoSecondaryWidth = $derived(
    clampSecondaryPaneWidth(
      Math.round(secondaryContainerWidth * panes.secondaryRatio),
      secondaryContainerWidth,
    ),
  );
  const secondaryBounds = $derived(secondaryPaneBounds(secondaryContainerWidth));
  const primaryMinSize = $derived(primaryPaneMinSize(secondaryContainerWidth));
  const secondaryDefaultSize = $derived.by(() => {
    const width = panes.hasResized ? panes.secondaryWidth : autoSecondaryWidth;
    return secondaryPaneDefaultSize(
      width,
      secondaryContainerWidth,
      secondaryBounds,
    );
  });

  function handleSecondaryLayout(layout: number[]) {
    if (layout.length !== 2 || conversationAreaWidth <= 0) return;
    panes.secondaryWidth = clampSecondaryPaneWidth(
      percentToPixels(layout[1], conversationAreaWidth),
      conversationAreaWidth,
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
    const tabId = focusedSplitChatTabId(content, panes.focusedPane, splitTabId);
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

  function toggleSecondaryMaximize() {
    panes.maximized = !panes.maximized;
  }

  // A work/plan document shell in the primary pane should claim the full width
  // like the diff panel does — collapse the project panel while it's open and
  // restore it on close. The session sidebar deliberately stays put.
  const documentShellOpen = $derived(
    isArtifactContent(panes.primaryContent),
  );

  // Collapse the session sidebar while a full-width overlay is up — a secondary
  // pane, review guide, or the settings page — and restore it on close, the same
  // way the diff panel reclaims the width.
  $effect(() => {
    if (
      secondaryCollapsesSidebar ||
      primaryReviewOpen ||
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

  // Edge-triggered on the collapse condition only: fire on the transition, not
  // on every projectPanelOpen change. Otherwise re-opening the panel (e.g. via
  // the expand button) while a shell is open would immediately re-collapse it.
  let prevPanelCollapseTrigger = false;
  $effect(() => {
    const trigger =
      secondaryCollapsesProjectPanel ||
      documentShellOpen ||
      primaryReviewOpen ||
      session.settingsOpen;
    if (trigger === prevPanelCollapseTrigger) return;
    prevPanelCollapseTrigger = trigger;
    if (trigger) {
      if (projectPanelOpen) {
        projectPanelClosedForSecondary = true;
        closeProjectPanel();
      }
    } else if (projectPanelClosedForSecondary) {
      projectPanelClosedForSecondary = false;
      openProjectPanel();
    }
  });

  // PaneForge owns the geometry while Solus owns whether these durable panes are
  // logically open. These effects bridge toolbar/keybinding state to the
  // imperative collapse API without unmounting either panel.
  $effect(() => {
    const pane = sidebarPane;
    if (!pane) return;
    if (sidebarOpen && pane.isCollapsed()) pane.expand();
    else if (!sidebarOpen && !pane.isCollapsed()) pane.collapse();
  });

  $effect(() => {
    const pane = projectPanelPane;
    if (!pane) return;
    if (projectPanelOpen && pane.isCollapsed()) pane.expand();
    else if (!projectPanelOpen && !pane.isCollapsed()) pane.collapse();
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
    {#if !inputDockHidden}
      <TabStrip
        variant="editor"
        tabIds={visibleTabIds}
        sidebarOpen={sidebarOpenForChrome}
        onToggleSidebar={toggleSidebar}
        projectPanelOpen={enableProjectPanel ? projectPanelOpen : undefined}
        onToggleProjectPanel={enableProjectPanel
          ? toggleProjectPanel
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
  class:project-panel-open={enableProjectPanel && projectPanelOpen}
  class:project-panel-collapsed={enableProjectPanel && !projectPanelOpen}
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
      <div class="content-column flex h-full flex-col min-h-0 min-w-0 relative">
    <div class="conversation-card flex-1 flex flex-col min-h-0">
      <div
        class="conversation-area flex-1 flex min-h-0 relative"
        bind:this={conversationAreaEl}
        bind:clientWidth={conversationAreaWidth}
      >
        <SessionPicker
          open={active && session.sessionPickerOpen}
          onClose={() => {
            session.sessionPickerOpen = false;
          }}
          portalTarget={conversationAreaEl}
        />

        <Resizable.PaneGroup
          direction="horizontal"
          keyboardResizeBy={2}
          class="flex-1 min-w-0 relative"
          onLayoutChange={handleSecondaryLayout}
        >
          <Resizable.Pane
            order={1}
            minSize={renderSecondaryShell ? primaryMinSize : 100}
            class="min-w-0"
          >
          <div class="primary-column relative flex h-full flex-col min-w-0">
            {@render dragBar()}
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
              class="input-dock no-drag flex-shrink-0"
              class:mode-hidden={inputDockHidden}
              style="padding:10px 16px 12px;background:var(--solus-container-bg)"
              bind:clientHeight={inputDockHeight}
              onfocusin={() => panes.focusPane("primary")}
            >
              {@render inputRow()}
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
              displayedSecondaryContent.kind === "pr-review" ||
              displayedSecondaryContent.kind === "pr-review-loading" ||
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
    </div>
      </div>
    </Resizable.Pane>

    {#if enableProjectPanel}
      <Resizable.Handle
        aria-label="Resize project panel"
        disabled={!projectPanelOpen}
        class={!projectPanelOpen ? "pointer-events-none opacity-0" : ""}
      />
      <Resizable.Pane
        bind:this={projectPanelPane}
        order={3}
        defaultSize={projectPanelOpen ? projectPanelDefaultSize : 0}
        minSize={projectPanelBounds.min}
        maxSize={projectPanelBounds.max}
        collapsedSize={0}
        collapsible
        onCollapse={closeProjectPanel}
        onExpand={openProjectPanel}
        aria-hidden={!projectPanelOpen}
        class="workspace-rail-pane"
      >
        <ProjectPanel
          open={projectPanelOpen}
          managedWidth
          onClose={closeProjectPanel}
        />
      </Resizable.Pane>
    {/if}
  </Resizable.PaneGroup>
</div>

<style>
  .workspace-body {
    position: relative;
  }
  :global(.workspace-rail-pane) {
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
  /* The secondary pane now spans the full card height, so its header sits in
     the same chrome row as the tab strip. Pane headers consume these vars to
     match the tab bar's height and continue its bottom seam as one line. */
  :global(.secondary-pane-wrap) {
    --solus-chrome-row-h: 2.5rem;
    --solus-chrome-row-border: color-mix(
      in srgb,
      var(--solus-container-border) 50%,
      transparent
    );
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
    /* Maximized panes cover the whole window (inset:0), so their header lands at
       the top-left under the macOS traffic lights. Publish the lead inset so the
       pane's chrome-row header clears them — this is the "diff fully expanded"
       and "PR review" case. */
    --solus-chrome-lead-inset: var(--solus-traffic-light-inset);
  }
  :global(.secondary-pane-wrap--framed) {
    border-left: 1px solid
      color-mix(in srgb, var(--solus-container-border) 45%, transparent);
  }
  .content-column {
    padding: 0 8px 8px 0;
  }
  .workspace-body.sidebar-collapsed .content-column {
    padding-left: 8px;
  }
  /* With the sidebar collapsed the primary column is the leftmost chrome, so a
     primary-slot pane header or full-page view header sits under the traffic
     lights. Publish the lead inset here (not on the whole content column, which
     also holds the right-hand secondary pane) so only the leftmost surface
     reserves the space. The secondary pane provides its own inset when
     maximized. No-op off the mac editor window (the inset var is 0). */
  .workspace-body.sidebar-collapsed .primary-column {
    --solus-chrome-lead-inset: var(--solus-traffic-light-inset);
  }
  .workspace-body.project-panel-open .content-column {
    padding-right: 0;
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
