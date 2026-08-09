<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    SidebarSimpleIcon,
    PlusIcon,
    CaretDownIcon,
    GitBranchIcon,
    PlugsIcon,
    XIcon,
  } from "phosphor-svelte";
  import { serverConnections } from "@client-core/server-connections";
  import InputBar from "@renderer/components/input/InputBar.svelte";
  import InputBarHeader from "@renderer/components/input/InputBarHeader.svelte";
  import GitDropdown from "@renderer/components/GitDropdown.svelte";
  import GoalSection from "@renderer/components/project-panel/GoalSection.svelte";
  import SolusTips from "@renderer/components/layout/SolusTips.svelte";
  import { isHomeVisible } from "@renderer/components/layout/lib/workspace-body";
  import {
    getWorkspaceContext,
    getPlanStore,
    runtime,
    serversStore,
  } from "@renderer/contexts";
  import {
    sessionTitle,
    getStatusIcon,
    hasSessionStarted,
  } from "@renderer/lib/sessionUtils";
  import type { WorktreeEntry } from "@shared/types";
  import WebSidebarDrawer from "./WebSidebarDrawer.svelte";
  import MobilePlusMenu from "./MobilePlusMenu.svelte";
  import MobileModelPicker from "./MobileModelPicker.svelte";
  import MobileServerSheet from "./MobileServerSheet.svelte";
  import { virtualKeyboard } from "../lib/virtual-keyboard.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { webState } from "../lib/web-state.svelte";

  interface Props {
    chatContent: Snippet;
    diffContent: Snippet;
    onAttachFile: () => void;
    overlayOpen: boolean;
    diffPanelOpen: boolean;
    canShowDiffPanel: boolean;
    changedFilesCount: number;
    onToggleWorkspace: () => void;
    onToggleDiff: () => void;
  }
  let {
    chatContent,
    diffContent,
    onAttachFile,
    overlayOpen,
    diffPanelOpen,
    canShowDiffPanel,
    changedFilesCount,
    onToggleWorkspace,
    onToggleDiff,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const mobileGoalSessionId = $derived(
    session.router.params("goal")?.sessionId ?? null,
  );

  // A tab that has not started has no prompt to name it after, so it says what
  // it will become instead.
  const title = $derived(
    tab && sess && hasSessionStarted(sess)
      ? sessionTitle(sess)
      : sess?.task.kind === "existing"
        ? "New session"
        : "New task",
  );
  const statusIcon = $derived(
    (tab && sess) ? getStatusIcon(sess.status) : null,
  );
  const branch = $derived(sess?.run.gitContext?.branch);
  // The destination strip (project · start-in · branch) is editable exactly
  // until the session starts — the same lifetime it has on desktop.
  const sessionStarted = $derived(hasSessionStarted(sess));
  // A started session that runs on another host names it in the navbar, since
  // the strip that would have said so is gone by then.
  const hostGlyph = $derived(serversStore.affinityFor(sess?.run.serverId));
  const hostName = $derived.by(() => {
    const host = serversStore.hostFor(sess?.run.serverId);
    return host && !host.local ? host.label : null;
  });
  // Nothing runs until a host is chosen, so the strip carries the way to fix
  // that. A host only ever arrives by page reload, so this is settled at mount.
  const noHost = !serverConnections.connectionFor();

  let goalCollapsed = $state(false);
  let plusMenuOpen = $state(false);
  let sidebarDrawerOpen = $state(false);
  let serverSheetOpen = $state(false);
  let gitOpen = $state(false);
  let gitTriggerEl: HTMLButtonElement | null = $state(null);
  let inputFocused = $state(false);

  // Browser/OS back closes the topmost open mobile overlay (last registered wins).
  registerBackOverlay("mobile-git", () => gitOpen, () => (gitOpen = false));
  registerBackOverlay("mobile-session-picker", () => runtime.isMobileViewport && session.sessionPickerOpen, () => (session.sessionPickerOpen = false));
  registerBackOverlay("mobile-drawer", () => sidebarDrawerOpen, () => (sidebarDrawerOpen = false));
  registerBackOverlay("mobile-plus-menu", () => plusMenuOpen, () => (plusMenuOpen = false));
  registerBackOverlay("mobile-server-sheet", () => serverSheetOpen, () => (serverSheetOpen = false));

  const kbHeight = $derived(virtualKeyboard.keyboardHeight);

  $effect(() => {
    if (virtualKeyboard.isKeyboardVisible) {
      window.dispatchEvent(
        new CustomEvent("solus:scroll-conversation-bottom", {
          detail: { tabId: session.activeTabId },
        }),
      );
    }
  });

  // iOS convention: a swipe in from the left screen edge opens the drawer.
  // Only a clearly horizontal drag that started at the edge counts, so code
  // blocks and the conversation keep their own horizontal scrolling.
  let edgeTouch: { x: number; y: number } | null = null;

  function onShellTouchStart(e: TouchEvent) {
    const touch = e.touches[0];
    edgeTouch = touch.clientX <= 20 && !sidebarDrawerOpen
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  }

  function onShellTouchMove(e: TouchEvent) {
    if (!edgeTouch) return;
    const touch = e.touches[0];
    const dx = touch.clientX - edgeTouch.x;
    const dy = Math.abs(touch.clientY - edgeTouch.y);
    if (dx > 24 && dx > dy * 1.5) {
      sidebarDrawerOpen = true;
      edgeTouch = null;
    }
  }

  function toggleGitMenu() {
    if (!branch) return;
    gitOpen = !gitOpen;
  }

  function selectBranch(picked: string) {
    // The branch you are already on means this checkout as it stands,
    // uncommitted work and all, so it names no base to cut a worktree from.
    session.setWorktreeBaseBranch(picked === branch ? null : picked);
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    await session.switchToWorktree(worktree.path, tab?.id);
  }
</script>

<!-- Passive edge-swipe gesture listeners, not interactive semantics. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-solus-ui
  class="mobile-shell"
  ontouchstart={onShellTouchStart}
  ontouchmove={onShellTouchMove}
>
  <header
    class="mh-navbar"
    class:mode-hidden={(diffPanelOpen && canShowDiffPanel) ||
      overlayOpen ||
      session.router.at("folio")}
  >
    <div class="mh-navbar-top">
      <button
        class="mh-navbar-side-btn"
        onclick={() => { sidebarDrawerOpen = true; }}
        aria-label="Sessions"
      >
        <SidebarSimpleIcon size={18} />
      </button>

      <button
        class="mh-navbar-center"
        onclick={() => { session.sessionPickerOpen = true; }}
      >
        <div class="mh-navbar-title-group">
          {#if statusIcon}
            <span
              class="mh-navbar-status {statusIcon.spin ? 'animate-spin' : ''}"
              style="color:{statusIcon.color}"
            >
              <statusIcon.component size={12} />
            </span>
          {/if}
          <span class="mh-navbar-title">{title}</span>
          <CaretDownIcon size={11} class="mh-navbar-caret" />
        </div>
      </button>

      <button
        class="mh-navbar-side-btn mh-navbar-side-btn--accent"
        onclick={() => session.openSessionDraft({ via: "click" })}
        aria-label="New session"
      >
        <PlusIcon size={18} weight="bold" />
      </button>
    </div>

    {#if branch || noHost || (sessionStarted && hostGlyph)}
      <div class="mh-navbar-strip">
        {#if noHost}
          <button
            class="mh-navbar-chip"
            onclick={() => webState.openServerSetup()}
          >
            <PlugsIcon size={12} />
            <span>No host</span>
          </button>
        {/if}
        {#if sessionStarted && hostGlyph && hostName}
          {@const HostIcon = hostGlyph.icon}
          <span class="mh-navbar-chip mh-navbar-chip--inert" title={hostGlyph.tooltip}>
            <HostIcon size={12} class={hostGlyph.className} />
            <span>{hostName}</span>
          </span>
        {/if}
        {#if branch}
          <button
            bind:this={gitTriggerEl}
            class="mh-navbar-chip"
            onclick={toggleGitMenu}
          >
            <GitBranchIcon size={12} />
            <span>{branch}</span>
          </button>
        {/if}
      </div>
    {/if}
  </header>

  <div class="mobile-content">
    {#if mobileGoalSessionId}
      <!-- Mobile has no project rail, so the goal card the rail hosts on
           desktop takes over the content area here. -->
      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <div class="flex justify-end">
          <button
            type="button"
            class="grid size-8 place-items-center rounded-lg text-(--solus-text-tertiary)"
            aria-label="Close goal"
            onclick={() => session.router.close("goal")}
          >
            <XIcon size={16} />
          </button>
        </div>
        <GoalSection
          sessionId={mobileGoalSessionId}
          collapsed={goalCollapsed}
          onToggle={() => (goalCollapsed = !goalCollapsed)}
          onCleared={() => session.router.close("goal")}
        />
      </div>
    {:else if !(diffPanelOpen && canShowDiffPanel)}
      <div class="mobile-chat relative">
        {@render chatContent()}
        <!-- The composer is docked outside this column, so the column's bottom
             is the page's — the same anchor the desktop tip uses. -->
        {#if isHomeVisible(sess)}
          <SolusTips
            class="pointer-events-none absolute inset-x-0 bottom-6 mx-auto px-6"
          />
        {/if}
      </div>
    {/if}
    {#if diffPanelOpen && canShowDiffPanel}
      <div class="ws-diff flex-1 w-full min-w-0 overflow-hidden">
        {@render diffContent()}
      </div>
    {/if}
  </div>

  <div
    class="mobile-input-dock"
    class:mode-hidden={overlayOpen ||
      !!mobileGoalSessionId ||
      session.router.at("settings") ||
      session.router.at("folio") ||
      (diffPanelOpen && canShowDiffPanel)}
    style={kbHeight > 0 ? `padding-bottom:${Math.max(10, kbHeight)}px` : ""}
  >
    {#if !sessionStarted}
      <div class="mobile-destination-strip">
        <InputBarHeader />
      </div>
    {/if}
    <div
      class="mobile-pill"
      class:mobile-pill--focused={inputFocused}
      onfocusin={() => (inputFocused = true)}
      onfocusout={() => (inputFocused = false)}
    >
      <InputBar
        mode="pill"
        sessionId={session.activeSession?.id ?? null}
        tabId={session.activeTabId}
        isPrimary
        run={session.activeSession?.run}
        prompt={session.inputFor(session.activeTabId)}
      >
        {#snippet leadingActions()}
          <button
            class="mobile-pill-plus"
            class:mobile-pill-plus--has-changes={changedFilesCount > 0}
            onclick={() => (plusMenuOpen = true)}
            aria-label="More options"
          >
            <PlusIcon size={18} />
            {#if changedFilesCount > 0}
              <span class="mobile-pill-plus-dot" aria-hidden="true"></span>
            {/if}
          </button>
          <MobileModelPicker />
        {/snippet}
      </InputBar>
    </div>
  </div>
</div>

<MobilePlusMenu
  open={plusMenuOpen}
  onClose={() => (plusMenuOpen = false)}
  {onAttachFile}
  {onToggleWorkspace}
  {onToggleDiff}
  {canShowDiffPanel}
  {diffPanelOpen}
  {changedFilesCount}
  onOpenServers={() => (serverSheetOpen = true)}
/>

<WebSidebarDrawer
  open={sidebarDrawerOpen}
  onClose={() => (sidebarDrawerOpen = false)}
  onOpenServers={() => (serverSheetOpen = true)}
/>

<MobileServerSheet
  open={serverSheetOpen}
  onClose={() => (serverSheetOpen = false)}
/>

{#if branch && tab && sess}
  <GitDropdown
    bind:open={gitOpen}
    triggerEl={gitTriggerEl}
    displayBranch={branch}
    selectedBranch={sess.run.worktree?.baseBranch ?? branch}
    workingDirectory={sess.run.gitContext?.worktreePath ?? sess.run.workingDirectory}
    onSelectBranch={selectBranch}
    onSelectWorktree={selectWorktree}
  />
{/if}

<style>
  .mode-hidden { display: none !important; }

  .mobile-shell {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    z-index: 1;
    background: var(--solus-container-bg);
    overflow: hidden;
    touch-action: manipulation;
    overscroll-behavior: none;
    contain: layout style;
  }

  .mh-navbar {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding-top: max(0.25rem, env(safe-area-inset-top, 0));
    padding-left: max(0.5rem, env(safe-area-inset-left, 0));
    padding-right: max(0.5rem, env(safe-area-inset-right, 0));
    z-index: 4;
    /* App chrome is not copy — long-press must never start a text selection. */
    user-select: none;
    -webkit-user-select: none;
  }

  .mh-navbar-top {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    height: 2.75rem;
  }

  .mh-navbar-strip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0 0.5rem 0.5rem;
  }

  .mh-navbar-chip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  /* The visible chip is ~24px tall; stretch the touch target to ~40px. */
  .mh-navbar-chip::before {
    content: "";
    position: absolute;
    inset: -0.5rem -0.25rem;
  }

  .mh-navbar-chip:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
  }

  .mh-navbar-chip--inert {
    cursor: default;
  }

  .mh-navbar-chip--inert:active {
    background: transparent;
    color: var(--solus-text-tertiary);
  }

  /* The destination strip carries its own horizontal padding (px-3.5), which
     would stack with the dock's — pull it back so chips align with the pill. */
  .mobile-destination-strip {
    margin: 0 -0.375rem 0.125rem;
  }

  .mh-navbar-side-btn {
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.625rem;
    border: none;
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color 0.12s ease,
      color 0.12s ease,
      transform 0.12s ease;
  }

  .mh-navbar-side-btn:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
    transform: scale(0.96);
  }

  .mh-navbar-side-btn--accent {
    color: var(--solus-accent);
  }

  .mh-navbar-side-btn--accent:active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }

  .mh-navbar-center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.0625rem;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 0.625rem;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 0.12s ease;
  }

  .mh-navbar-center:active {
    background: var(--solus-surface-hover);
  }

  .mh-navbar-title-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
  }

  .mh-navbar-status {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .mh-navbar-title {
    font-size: 0.875rem;
    font-weight: 550;
    color: var(--solus-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }

  :global(.mh-navbar-caret) {
    color: var(--solus-text-tertiary);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .mobile-content {
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    contain: layout paint;
  }

  .mobile-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .mobile-shell :global(.conversation-selectable) {
    padding-left: max(0.875rem, env(safe-area-inset-left, 0));
    padding-right: max(0.875rem, env(safe-area-inset-right, 0));
  }

  .mobile-input-dock {
    flex-shrink: 0;
    padding: 0.5rem 0.75rem;
    padding-bottom: max(0.625rem, env(safe-area-inset-bottom, 0));
    padding-left: max(0.75rem, env(safe-area-inset-left, 0));
    padding-right: max(0.75rem, env(safe-area-inset-right, 0));
    z-index: 5;
    contain: layout paint;
    /* visualViewport reports the keyboard in coarse steps; a short ease turns
       those steps into one motion that tracks the iOS keyboard slide. */
    transition: padding-bottom 0.15s ease-out;
  }

  .mobile-pill {
    border-radius: 1.25rem;
    border: 0.0625rem solid var(--solus-container-border);
    background: var(--solus-container-bg);
    box-shadow:
      0 0.25rem 1.5rem rgba(0, 0, 0, 0.12),
      0 0.0625rem 0.25rem rgba(0, 0, 0, 0.08);
    padding: 0.125rem 0.375rem 0.125rem 0.5rem;
    transition:
      box-shadow 0.18s ease,
      border-color 0.18s ease;
  }

  .mobile-pill--focused {
    border-color: var(--solus-input-focus-border);
    box-shadow:
      0 0 0 0.1875rem var(--solus-input-focus-ring),
      0 0.25rem 1.5rem rgba(0, 0, 0, 0.12);
  }

  .mobile-pill-plus {
    position: relative;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color 0.15s ease,
      background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-pill-plus:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .mobile-pill-plus--has-changes {
    color: var(--solus-accent);
  }

  .mobile-pill-plus-dot {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 624.9375rem;
    background: var(--solus-accent);
    box-shadow: 0 0 0.25rem rgba(217, 119, 87, 0.5);
    pointer-events: none;
  }

  /* The composer is CodeMirror now; 16px keeps iOS Safari from zooming the
     viewport when the input gains focus. */
  .mobile-shell :global(.cm-editor) {
    font-size: 1rem;
    line-height: 1.5;
  }

  .ws-diff {
    flex-shrink: 0;
    /* Full-screen surfaces arrive like an iOS sheet, not a cut. */
    animation: mobile-surface-in 0.28s cubic-bezier(0.32, 0.72, 0, 1);
  }

  @keyframes mobile-surface-in {
    from {
      opacity: 0;
      transform: translateY(1.5rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ws-diff {
      animation: none;
    }
  }
</style>
