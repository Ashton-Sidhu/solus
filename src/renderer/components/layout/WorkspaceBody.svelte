<script lang="ts">
  import type { Snippet } from "svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { getRunStore } from "../../contexts/run.store.svelte";
  import { getRunDockStore } from "../../contexts/run-dock.store.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import ProjectPanel from "../project-panel/ProjectPanel.svelte";
  import RunDock from "../run/RunDock.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SessionSidebar from "../session/SessionSidebar.svelte";
  import FrameExpandButton from "./FrameExpandButton.svelte";
  import TabStrip from "./TabStrip.svelte";
  import SessionPicker from "../session/SessionPicker.svelte";
  import Pane from "../ui/Pane.svelte";
  import ConversationView from "../conversation/ConversationView.svelte";
  import NewTabHome from "./NewTabHome.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { frameChrome } from "../../contexts/frame-chrome.store.svelte";
  import {
    DEFAULT_PANEL_WIDTH,
    DEFAULT_SECONDARY_RATIO,
    isArtifactContent,
    isMovableContent,
    isPageContent,
    type PaneContent,
  } from "../../contexts/pane-view.store.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { branchKeyFor } from "../../lib/sessionUtils";

  interface Props {
    /** Whether this body is the active layout (drives keybindings + chrome reporting). */
    active: boolean;
    /** Show the right-hand ProjectPanel + its keybinding. */
    enableProjectPanel: boolean;
    /** Allow the floating run-log dock + its keybinding. */
    enableRunDock: boolean;
    /** Action buttons + InputBar row (varies between editor and web). */
    inputRow: Snippet;
    /** Status bar contents (StatusBarControls, plus web extras). */
    statusBar: Snippet;
  }
  let {
    active,
    enableProjectPanel,
    enableRunDock,
    inputRow,
    statusBar,
  }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const settings = getSettingsContext();
  const runStore = getRunStore();
  const runDock = getRunDockStore();
  const av = session.artifactViewer;
  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const canShowDiffPanel = $derived(!!sess?.workingDirectory);
  const canShowSidePanel = $derived(canShowDiffPanel);

  const secondaryVisible = $derived(
    av.secondaryOpen &&
      (av.secondary.kind !== "diff" || (!!tab && canShowSidePanel)),
  );
  const secondaryCollapsesSidebar = $derived(
    secondaryVisible && av.secondary.kind !== "automation",
  );
  const sidebarOpenForChrome = $derived(
    sidebarOpen || secondaryCollapsesSidebar,
  );

  // Any non-conversation content in the primary slot — a page, artifact, or
  // review — covers the conversation pool (hidden, never unmounted) and its
  // composer. A maximized secondary (e.g. the full-screen PR-review surface)
  // covers the whole column too, so the composer has nothing to dock to.
  const inputDockHidden = $derived(
    av.primary.kind !== "conversation" || av.maximized,
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

  const activeBranchKey = $derived(branchKeyFor(sess));
  const visibleTabIds = $derived.by(() => {
    const openTabIds = session.tabOrder.filter((id) => session.tabs[id]);
    if (sess?.loadingHistory) return openTabIds;
    return openTabIds.filter(
      (id) => branchKeyFor(session.sessionFor(id)) === activeBranchKey,
    );
  });

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

  let inputFocused = $state(false);
  let secondaryPaneEl: HTMLDivElement | undefined = $state();
  let conversationAreaEl: HTMLDivElement | undefined = $state();
  let conversationAreaWidth = $state(0);
  // Measured so the floating run dock clears the input bar even as it grows
  // with multi-line input, instead of relying on a fixed bottom offset.
  let inputDockHeight = $state(0);
  let isResizingSecondary = $state(false);
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  // Scale the rails with the viewport instead of two coarse breakpoints:
  // narrower on laptops (more room for the conversation), wider on large
  // displays so the rails don't look anemic beside a wide thread. Both rails
  // share one width; ~19% of the viewport, bounded to a usable band.
  const initialViewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1440;
  const defaultSidebarWidth = Math.round(
    Math.min(400, Math.max(280, initialViewportWidth * 0.19)),
  );

  let sidebarOpen = $state(true);
  let sidebarWidth = $state(defaultSidebarWidth);
  let isResizingSidebar = $state(false);
  let sidebarResizeStartX = 0;
  let sidebarResizeStartWidth = 0;
  let sidebarClosedForOverlay = $state(false);

  let projectPanelOpen = $state(settings.projectPanelOpen);
  const maxProjectPanelWidth = DEFAULT_PANEL_WIDTH;
  let projectPanelWidth = $state(defaultSidebarWidth);
  let isResizingProjectPanel = $state(false);
  let projectPanelResizeStartX = 0;
  let projectPanelResizeStartWidth = 0;
  let projectPanelClosedForSecondary = $state(false);

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
  function toggleRunDock() {
    runDock.toggle();
    settings.update({ runDockOpen: runDock.open });
    if (!runDock.open) requestInputFocus();
  }

  function openSidebar() {
    sidebarOpen = true;
  }

  function closeSidebar() {
    sidebarOpen = false;
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
    settings.update({ projectPanelOpen: false });
    requestInputFocus();
  }

  function openProjectPanel() {
    projectPanelOpen = true;
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
  useKeybinding("global.toggle-run-dock", () => toggleRunDock(), {
    enabled: () => active && enableRunDock,
  });
  useKeybinding(
    "global.toggle-files",
    () => {
      if (av.secondary.kind === "files") av.closeSecondary();
      else av.openFiles();
      requestInputFocus();
    },
    { enabled: () => active && canShowDiffPanel },
  );
  useKeybinding(
    "global.open-in-split",
    () => {
      if (isMovableContent(av.primary)) {
        av.moveToOppositeSlot(av.primary, "primary");
      } else if (isMovableContent(av.secondary)) {
        av.moveToOppositeSlot(av.secondary, "secondary");
      } else if (av.secondary.kind === "conversation" && av.secondary.tabId) {
        // Toggle off: promote the split chat back to the main view.
        session.selectTab(av.secondary.tabId);
      } else if (av.primary.kind === "conversation" && tab) {
        // Plain conversation: split the active chat off to the side.
        session.openTabInSplit(tab.id);
      } else {
        return;
      }
      requestInputFocus();
    },
    { enabled: () => active },
  );

  function startSidebarResize(e: MouseEvent) {
    isResizingSidebar = true;
    sidebarResizeStartX = e.clientX;
    sidebarResizeStartWidth = sidebarWidth;
    e.preventDefault();
  }

  function handleSidebarResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      sidebarWidth = Math.min(400, Math.max(160, sidebarWidth + step));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      sidebarWidth = Math.min(400, Math.max(160, sidebarWidth - step));
    }
  }

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

  function startProjectPanelResize(e: MouseEvent) {
    isResizingProjectPanel = true;
    projectPanelResizeStartX = e.clientX;
    projectPanelResizeStartWidth = projectPanelWidth;
    e.preventDefault();
  }

  function handleProjectPanelResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      projectPanelWidth = clampProjectPanelWidth(projectPanelWidth + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      projectPanelWidth = clampProjectPanelWidth(projectPanelWidth - step);
    }
  }

  // Split-pane floors. The divider drag is zero-sum, so both panes get a
  // minimum: the secondary can't shrink below a usable column, and it can't
  // grow so far that the primary chat pane is squeezed to nothing.
  const minPrimaryWidth = 400;
  const minSecondaryWidth = 360;

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function clampProjectPanelWidth(desired: number) {
    return clamp(desired, 240, maxProjectPanelWidth);
  }

  // Clamp a desired secondary width to keep both panes usable. On a work area
  // too narrow to honor both floors, fall back to a 50/50 split so the clamp
  // doesn't silently pin the pane to one edge.
  function clampSecondaryWidth(desired: number) {
    const containerW =
      conversationAreaWidth ||
      conversationAreaEl?.clientWidth ||
      windowCtx.workAreaWidth;
    if (containerW < minPrimaryWidth + minSecondaryWidth) {
      return Math.round(containerW / 2);
    }
    return clamp(desired, minSecondaryWidth, containerW - minPrimaryWidth);
  }

  const autoSecondaryWidth = $derived(
    clampSecondaryWidth(
      Math.round(
        (conversationAreaWidth ||
          conversationAreaEl?.clientWidth ||
          windowCtx.workAreaWidth) * av.secondaryRatio,
      ),
    ),
  );
  const secondaryPaneStyle = $derived.by(() => {
    if (av.maximized) return "";
    if (av.hasResized) return `width:${av.secondaryWidth}px`;
    if (av.secondaryRatio === DEFAULT_SECONDARY_RATIO) return "";
    return `width:${autoSecondaryWidth}px`;
  });

  function startSecondaryResize(e: MouseEvent) {
    if (!av.hasResized && secondaryPaneEl) {
      av.secondaryWidth = secondaryPaneEl.clientWidth;
      av.hasResized = true;
    }
    if (av.maximized) av.maximized = false;
    isResizingSecondary = true;
    resizeStartX = e.clientX;
    resizeStartWidth = av.secondaryWidth;
    e.preventDefault();
  }

  let panelResizeRaf = 0;
  let pendingSidebarWidth = defaultSidebarWidth;
  let pendingSecondaryWidth = DEFAULT_PANEL_WIDTH;
  let pendingProjectPanelWidth = defaultSidebarWidth;
  // Scratch value; seeded in startDockResize before the rAF reads it.
  let pendingDockHeight = 0;

  function schedulePanelResizeCommit() {
    if (panelResizeRaf) return;
    panelResizeRaf = requestAnimationFrame(() => {
      panelResizeRaf = 0;
      if (isResizingSidebar) sidebarWidth = pendingSidebarWidth;
      if (isResizingSecondary) av.secondaryWidth = pendingSecondaryWidth;
      if (isResizingProjectPanel) projectPanelWidth = pendingProjectPanelWidth;
      if (isResizingDock) dockHeight = pendingDockHeight;
    });
  }

  function handleMouseMove(e: MouseEvent) {
    if (isResizingSidebar) {
      const delta = e.clientX - sidebarResizeStartX;
      pendingSidebarWidth = clamp(sidebarResizeStartWidth + delta, 160, 400);
      schedulePanelResizeCommit();
      return;
    }
    if (isResizingSecondary) {
      const delta = resizeStartX - e.clientX;
      pendingSecondaryWidth = clampSecondaryWidth(resizeStartWidth + delta);
      schedulePanelResizeCommit();
      return;
    }
    if (isResizingProjectPanel) {
      const delta = projectPanelResizeStartX - e.clientX;
      pendingProjectPanelWidth = clampProjectPanelWidth(
        projectPanelResizeStartWidth + delta,
      );
      schedulePanelResizeCommit();
      return;
    }
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
    if (isResizingSidebar) sidebarWidth = pendingSidebarWidth;
    if (isResizingSecondary) av.secondaryWidth = pendingSecondaryWidth;
    if (isResizingProjectPanel) projectPanelWidth = pendingProjectPanelWidth;
    if (isResizingDock) {
      dockHeight = pendingDockHeight;
      settings.update({ runDockHeight: dockHeight });
    }
    isResizingSecondary = false;
    isResizingSidebar = false;
    isResizingProjectPanel = false;
    isResizingDock = false;
  }

  let renderSecondaryShell = $state(false);
  let renderSecondaryContent = $state(false);
  let secondaryPaneClosing = $state(false);
  let secondaryClosingWidth = $state(DEFAULT_PANEL_WIDTH);
  let displayedSecondaryContent = $state<PaneContent>({ kind: "empty" });
  let secondaryContentTimer: ReturnType<typeof setTimeout> | null = null;
  let secondaryShellTimer: ReturnType<typeof setTimeout> | null = null;
  const SECONDARY_CONTENT_DELAY_MS = 90;
  const SECONDARY_SHELL_EXIT_MS = 140;

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
    displayedSecondaryContent = av.secondary;
    renderSecondaryShell = true;
    secondaryPaneClosing = false;

    if (renderSecondaryContent) return;
    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches;
    secondaryContentTimer = setTimeout(
      () => {
        secondaryContentTimer = null;
        renderSecondaryContent = true;
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

  function handleSecondaryResizeKey(e: KeyboardEvent) {
    if (!av.hasResized && secondaryPaneEl) {
      av.secondaryWidth = secondaryPaneEl.clientWidth;
      av.hasResized = true;
    }
    if (av.maximized) av.maximized = false;
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      av.secondaryWidth = clampSecondaryWidth(av.secondaryWidth + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      av.secondaryWidth = clampSecondaryWidth(av.secondaryWidth - step);
    }
  }

  function toggleSecondaryMaximize() {
    av.maximized = !av.maximized;
  }

  // A work/plan document shell in the primary pane should claim the full width
  // like the diff panel does — collapse the project panel while it's open and
  // restore it on close. The session sidebar deliberately stays put.
  const documentShellOpen = $derived(isArtifactContent(av.primary));

  // Collapse the session sidebar while a full-width overlay is up — a secondary
  // pane or the settings page — and restore it on close, the
  // same way the diff panel reclaims the width.
  $effect(() => {
    if (secondaryCollapsesSidebar || session.settingsOpen) {
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
      secondaryVisible || documentShellOpen || session.settingsOpen;
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
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<div
  class="workspace-body flex flex-1 min-w-0 min-h-0"
  class:is-resizing={isResizingSecondary ||
    isResizingSidebar ||
    isResizingProjectPanel ||
    isResizingDock}
  class:has-secondary-pane={av.secondaryOpen && (av.hasResized || av.maximized)}
  class:has-document-shell={documentShellOpen}
  class:sidebar-collapsed={!sidebarOpen}
  class:project-panel-open={enableProjectPanel && projectPanelOpen}
  class:project-panel-collapsed={enableProjectPanel && !projectPanelOpen}
>
  <SessionSidebar
    open={sidebarOpen}
    width={sidebarWidth}
    onToggleCollapse={toggleSidebar}
  />
  <div
    class="sidebar-resize-handle"
    class:sidebar-closed={!sidebarOpen}
    onmousedown={startSidebarResize}
    onkeydown={handleSidebarResizeKey}
    role="slider"
    tabindex={sidebarOpen ? 0 : -1}
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuenow={sidebarWidth}
    aria-valuemin={160}
    aria-valuemax={400}
  >
    <span class="sidebar-resize-grip" aria-hidden="true"></span>
  </div>

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

  <div class="content-column flex-1 flex flex-col min-h-0 min-w-0 relative">
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

        <div class="flex-1 flex min-w-0 relative">
          <div class="primary-column relative flex-1 flex flex-col min-w-0">
            {@render dragBar()}
            <!-- Frame-level session-expand affordance. Rendered once here so
                 every full-page view (settings + galleries + PRs) shows it in
                 the identical top-left spot instead of each page placing its
                 own. Self-gates via frameChrome (hidden unless the sidebar is
                 collapsed); the lead inset var — published on the collapsed
                 primary-column — clears the mac traffic lights. Scoped to a
                 non-conversation primary so it never overlaps the
                 conversation's TabStrip, which carries its own sidebar toggle. -->
            {#if av.primary.kind !== "conversation"}
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
              class:mode-hidden={av.primary.kind !== "conversation"}
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
                      onDiffToggle={() => av.toggleDiff(canShowDiffPanel)}
                    />
                  </div>
                {/if}
              {/each}
            </div>
            {#if av.primary.kind !== "conversation"}
              <Pane content={av.primary} slot="primary" />
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
            >
              <div
                class="editor-input-card overflow-hidden"
                style="max-width:var(--solus-reading-max);margin-inline:auto"
                class:is-focused={inputFocused}
                onfocusin={() => (inputFocused = true)}
                onfocusout={() => (inputFocused = false)}
              >
                {@render inputRow()}
                <div class="editor-input-statusbar no-drag">
                  {@render statusBar()}
                </div>
              </div>
            </div>
          </div>

          {#if renderSecondaryShell}
            <div
              bind:this={secondaryPaneEl}
              class="secondary-pane-wrap relative {!av.maximized &&
              !av.hasResized
                ? av.secondaryRatio === DEFAULT_SECONDARY_RATIO
                  ? 'flex-1'
                  : 'flex-none'
                : ''}"
              class:secondary-pane-wrap--maximized={av.maximized}
              class:secondary-pane-wrap--closing={secondaryPaneClosing}
              class:secondary-pane-wrap--framed={isArtifactContent(
                displayedSecondaryContent,
              ) ||
                displayedSecondaryContent.kind === "review" ||
                isPageContent(displayedSecondaryContent)}
              style={secondaryPaneClosing
                ? `width:${secondaryClosingWidth}px`
                : secondaryPaneStyle}
              class:is-resizing={isResizingSecondary}
            >
              <div
                class="pane-resize-handle"
                onmousedown={startSecondaryResize}
                onkeydown={handleSecondaryResizeKey}
                role="slider"
                tabindex="0"
                aria-orientation="vertical"
                aria-label="Resize panel"
                aria-valuenow={av.secondaryWidth}
                aria-valuemin={280}
              >
                <span class="pane-resize-grip" aria-hidden="true"></span>
              </div>
              {#if renderSecondaryContent}
                <div class="secondary-pane-content h-full min-h-0">
                  <Pane
                    content={displayedSecondaryContent}
                    slot="secondary"
                    onToggleSecondaryMaximize={toggleSecondaryMaximize}
                  />
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  {#if enableProjectPanel}
    <div
      class="project-panel-resize-handle"
      class:project-panel-closed={!projectPanelOpen}
      onmousedown={startProjectPanelResize}
      onkeydown={handleProjectPanelResizeKey}
      role="slider"
      tabindex={projectPanelOpen ? 0 : -1}
      aria-orientation="vertical"
      aria-label="Resize project panel"
      aria-valuenow={projectPanelWidth}
      aria-valuemin={240}
      aria-valuemax={maxProjectPanelWidth}
    >
      <span class="project-panel-resize-grip" aria-hidden="true"></span>
    </div>
    <ProjectPanel
      open={projectPanelOpen}
      width={projectPanelWidth}
      onClose={closeProjectPanel}
    />
  {/if}
</div>

<style>
  .workspace-body {
    position: relative;
  }
  .drag-bar {
    height: auto;
    flex-shrink: 0;
    position: relative;
  }
  /* The secondary pane now spans the full card height, so its header sits in
     the same chrome row as the tab strip. Pane headers consume these vars to
     match the tab bar's height and continue its bottom seam as one line. */
  .secondary-pane-wrap {
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
  .secondary-pane-wrap--closing {
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
  .secondary-pane-wrap--maximized {
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
  .secondary-pane-wrap--framed {
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
  .editor-input-card {
    border-radius: 16px;
    padding: 0;
    border: 1px solid var(--solus-container-border);
    background: var(--solus-input-pill-bg);
    box-shadow: var(--solus-card-shadow-collapsed);
    transition:
      box-shadow 0.18s ease,
      border-color 0.18s ease;
  }
  .editor-input-card.is-focused {
    border-color: var(--solus-input-focus-border);
    box-shadow:
      0 0 0 3px var(--solus-input-focus-ring),
      var(--solus-card-shadow-collapsed);
  }
  .editor-input-statusbar {
    border-top: 1px solid
      color-mix(in srgb, var(--solus-container-border) 55%, transparent);
  }
  .pane-resize-handle {
    position: absolute;
    left: -4px;
    top: 0;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pane-resize-grip {
    position: relative;
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--solus-text-tertiary);
    opacity: 0;
    transform: scaleY(0.6);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      background-color 0.15s ease;
    pointer-events: none;
  }
  .pane-resize-handle:hover .pane-resize-grip,
  .is-resizing .pane-resize-grip {
    opacity: 1;
    transform: scaleY(1);
    background: var(--solus-accent);
  }
  .workspace-body.is-resizing,
  .is-resizing {
    user-select: none;
    cursor: col-resize;
  }
  .workspace-body.is-resizing :global(.side-panel-shell) {
    transition: none;
  }
  /* Slim drag handle shown on full-page views in place of the tab strip. */
  .page-drag-strip {
    height: 0;
  }
  .sidebar-resize-handle {
    width: 0;
    flex-shrink: 0;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: visible;
    z-index: 11;
    transform: translateX(-8px);
    transition: opacity 180ms cubic-bezier(0.2, 0, 0, 1);
  }
  .sidebar-resize-handle.sidebar-closed {
    opacity: 0;
    pointer-events: none;
  }
  .sidebar-resize-handle::before,
  .workspace-body.has-secondary-pane .sidebar-resize-handle::before,
  .workspace-body.has-document-shell .sidebar-resize-handle::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
  }
  .sidebar-resize-grip {
    position: relative;
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--solus-text-tertiary);
    opacity: 0;
    transform: scaleY(0.6);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      background-color 0.15s ease;
    pointer-events: none;
  }
  .sidebar-resize-handle:hover .sidebar-resize-grip {
    opacity: 1;
    transform: scaleY(1);
    background: var(--solus-accent);
  }
  .mode-hidden {
    display: none !important;
  }
  .project-panel-resize-handle {
    width: 0;
    flex-shrink: 0;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: visible;
    z-index: 11;
    transform: translateX(8px);
    transition: opacity 180ms cubic-bezier(0.2, 0, 0, 1);
  }
  .project-panel-resize-handle.project-panel-closed {
    opacity: 0;
    pointer-events: none;
  }
  .project-panel-resize-handle::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
  }
  .project-panel-resize-grip {
    position: relative;
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--solus-text-tertiary);
    opacity: 0;
    transform: scaleY(0.6);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      background-color 0.15s ease;
    pointer-events: none;
  }
  .project-panel-resize-handle:hover .project-panel-resize-grip {
    opacity: 1;
    transform: scaleY(1);
    background: var(--solus-accent);
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
