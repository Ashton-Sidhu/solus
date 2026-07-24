<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    SidebarSimpleIcon,
    PlusIcon,
    CaretDownIcon,
    GitBranchIcon,
  } from "phosphor-svelte";
  import InputBar from "@renderer/components/input/InputBar.svelte";
  import GitDropdown from "@renderer/components/GitDropdown.svelte";
  import { getWorkspaceContext, getPlanStore, runtime } from "@renderer/contexts";
  import { sessionTitle, getStatusIcon } from "@renderer/lib/sessionUtils";
  import WebSidebarDrawer from "./WebSidebarDrawer.svelte";
  import MobilePlusMenu from "./MobilePlusMenu.svelte";
  import MobileModelPicker from "./MobileModelPicker.svelte";
  import { virtualKeyboard } from "../lib/virtual-keyboard.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";

  interface Props {
    chatContent: Snippet;
    diffContent: Snippet;
    onAttachFile: () => void;
    overlayOpen: boolean;
    diffPanelOpen: boolean;
    canShowDiffPanel: boolean;
    changedFilesCount: number;
    onTogglePlans: () => void;
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
    onTogglePlans,
    onToggleDiff,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));

  const title = $derived((tab && sess) ? sessionTitle(sess, tab) : "New session");
  const statusIcon = $derived(
    (tab && sess) ? getStatusIcon(sess.status) : null,
  );
  const branch = $derived(sess?.gitContext?.branch);

  let plusMenuOpen = $state(false);
  let sidebarDrawerOpen = $state(false);
  let gitOpen = $state(false);
  let gitTriggerEl: HTMLButtonElement | null = $state(null);
  let inputFocused = $state(false);

  // Browser/OS back closes the topmost open mobile overlay (last registered wins).
  registerBackOverlay("mobile-git", () => gitOpen, () => (gitOpen = false));
  registerBackOverlay("mobile-session-picker", () => runtime.isMobileViewport && session.sessionPickerOpen, () => (session.sessionPickerOpen = false));
  registerBackOverlay("mobile-drawer", () => sidebarDrawerOpen, () => (sidebarDrawerOpen = false));
  registerBackOverlay("mobile-plus-menu", () => plusMenuOpen, () => (plusMenuOpen = false));

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

  function toggleGitMenu() {
    if (!branch) return;
    gitOpen = !gitOpen;
  }
</script>

<div data-solus-ui class="mobile-shell">
  <header
    class="mh-navbar"
    class:mode-hidden={(diffPanelOpen && canShowDiffPanel) ||
      overlayOpen ||
      session.plansGalleryOpen ||
      session.folioGalleryOpen}
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
        onclick={() => session.createTab()}
        aria-label="New session"
      >
        <PlusIcon size={18} weight="bold" />
      </button>
    </div>

    {#if branch}
      <div class="mh-navbar-strip">
        <button
          bind:this={gitTriggerEl}
          class="mh-navbar-chip"
          onclick={toggleGitMenu}
        >
          <GitBranchIcon size={12} />
          <span>{branch}</span>
        </button>
      </div>
    {/if}
  </header>

  <div class="mobile-content">
    {#if !(diffPanelOpen && canShowDiffPanel)}
      <div class="mobile-chat">
        {@render chatContent()}
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
      session.settingsOpen ||
      session.plansGalleryOpen ||
      session.folioGalleryOpen ||
      (diffPanelOpen && canShowDiffPanel)}
    style={kbHeight > 0 ? `padding-bottom:${Math.max(10, kbHeight)}px` : ""}
  >
    <div
      class="mobile-pill"
      class:mobile-pill--focused={inputFocused}
      onfocusin={() => (inputFocused = true)}
      onfocusout={() => (inputFocused = false)}
    >
      <InputBar mode="pill">
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
  {onTogglePlans}
  {onToggleDiff}
  {canShowDiffPanel}
  {diffPanelOpen}
  {changedFilesCount}
/>

<WebSidebarDrawer
  open={sidebarDrawerOpen}
  onClose={() => (sidebarDrawerOpen = false)}
/>

{#if branch && tab && sess}
  <GitDropdown
    bind:open={gitOpen}
    initialView="menu"
    triggerEl={gitTriggerEl}
    displayBranch={branch}
    worktreePath={sess.gitContext?.worktreePath ?? null}
    worktreeBaseBranch={sess.worktreeBaseBranch ?? null}
    tabId={tab.id}
    dropDown
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
  }

  .mh-navbar-chip:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
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
  }

  .mh-navbar-side-btn:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
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

  .mobile-shell :global(.ProseMirror) {
    font-size: 1rem;
    line-height: 1.5;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }

  .mobile-shell :global(.solus-md-placeholder) {
    top: 0.5rem;
  }

  .ws-diff { flex-shrink: 0; }
</style>
