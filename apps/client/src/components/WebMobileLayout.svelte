<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    PanelLeft as SidebarSimpleIcon,
    Plus as PlusIcon,
    ChevronDown as CaretDownIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import InputBar from "@solus/workspace-ui/components/input/InputBar.svelte";
  import InputBarHeader from "@solus/workspace-ui/components/input/InputBarHeader.svelte";
  import GoalSection from "@solus/workspace-ui/components/project-panel/GoalSection.svelte";
  import {
    getWorkspaceContext,
    getPlanStore,
    getPullRequestsContext,
    getSessionSidebarStore,
    runtime,
  } from "@solus/workspace-ui/contexts";
  import { frameChrome } from "@solus/workspace-ui/components/layout/frame-chrome.store.svelte";
  import {
    currentMobileSection,
    hasUnseenSection,
    type MobileSectionSignals,
  } from "../lib/mobile-sections";
  import {
    sessionTitle,
    getStatusIcon,
    getStatusLabel,
    hasSessionStarted,
  } from "@solus/workspace-ui/lib/sessionUtils";
  import { projectDirLabel } from "@solus/workspace-ui/lib/paths";
  import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
  import { isPageRoute } from "@solus/workspace-ui/contexts/workspace/routing/route-registry";
  import { liveActivityClock } from "@solus/workspace-ui/lib/shared-clock";
  import { formatElapsed } from "@solus/workspace-ui/components/session/lib/task-list";
  import { taskRef } from "@solus/workspace-ui/components/tasks/task-page/lib/task-page";
  import WebSidebarDrawer from "./WebSidebarDrawer.svelte";
  import MobilePlusMenu from "./MobilePlusMenu.svelte";
  import MobileComposerActions from "./MobileComposerActions.svelte";
  import MobileServerSheet from "./MobileServerSheet.svelte";
  import MobileTaskSheet from "./MobileTaskSheet.svelte";
  import { virtualKeyboard } from "../lib/virtual-keyboard.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { mobileComposerMenu } from "../lib/mobile-composer-menu.svelte";

  interface Props {
    chatContent: Snippet;
    diffContent: Snippet;
    onAttachFile: (sourceId?: string) => void;
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
  const sidebar = getSessionSidebarStore();
  const pullRequests = getPullRequestsContext();

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const mobileDraft = $derived.by(() => {
    const base = session.router.leadingPane.base;
    return base?.name === "draft"
      ? (session.sessionDrafts.get(base.params.draftId) ?? null)
      : null;
  });
  const mobileGoalSessionId = $derived(
    session.router.params("goal")?.sessionId ?? null,
  );

  // A tab that has not started has no prompt to name it after, so it says what
  // it will become instead.
  const title = $derived(
    mobileDraft
      ? mobileDraft.task.kind === "existing"
        ? "New session"
        : "New task"
      : tab && sess && hasSessionStarted(sess)
      ? sessionTitle(sess)
      : sess?.task.kind === "existing"
        ? "New session"
        : "New task",
  );
  const activeRun = $derived(mobileDraft?.run ?? sess?.run);
  // The destination strip (project · start-in · branch) is editable exactly
  // until the session starts — the same lifetime it has on desktop.
  const sessionStarted = $derived(!mobileDraft && hasSessionStarted(sess));

  // ── The header's second line: `project / T-590 · running 00:42`.
  // One mono band replaces the two chip rows the navbar used to stack, and the
  // whole 56px band opens the task sheet where project, host, branch and the
  // runs inside the task are editable.
  const projectLabel = $derived(
    projectDirLabel(
      activeRun?.gitContext?.projectRoot ?? activeRun?.workingDirectory ?? "~",
      session.staticInfo?.workspacePath,
    ),
  );
  const headerTask = $derived(
    sess ? session.tasksStore.taskForSession(sess.id) : null,
  );
  const headerPath = $derived(
    [projectLabel === "~" ? "" : projectLabel, headerTask ? taskRef(headerTask) : ""]
      .filter(Boolean)
      .join(" / "),
  );
  // The same status mark every other surface draws, from the same table, so a
  // phone and a 1440px window never disagree about what a session is doing.
  // `getStatusIcon` answers null for idle, which is exactly when the band has
  // nothing to report.
  const stateIcon = $derived(
    sess && hasSessionStarted(sess) ? getStatusIcon(sess.status) : null,
  );
  const stateLabel = $derived(
    sess && hasSessionStarted(sess) ? (getStatusLabel(sess.status) ?? "") : "",
  );
  const isRunning = $derived(sess?.status === "running");
  // The elapsed readout beside the running word, on the shared second tick so
  // every surface counting the same turn agrees to the digit.
  const runStartedAt = $derived(
    isRunning ? sidebar.childForTab(session.activeTabId).runStartedAt : 0,
  );
  let now = $state(Date.now());
  $effect(() => {
    if (!runStartedAt) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(runStartedAt ? formatElapsed(now - runStartedAt) : "");

  // A page route brings its own header — a title, a scope chip and the control
  // that opens this drawer — so the session navbar and the composer both stand
  // down while one is on screen. Asking the registry rather than naming routes
  // keeps this from going stale the moment a sixth destination is added: the
  // alternative is a page rendering under a navbar that names a session it has
  // nothing to do with.
  const onPageRoute = $derived(isPageRoute(visibleRef(session.router.leadingPane)));

  // ── The section signals ──
  // The same two numbers the home cards state ("1 running", "3 need you") and
  // the drawer's section row carries. Read once here so the cards, the rows and
  // the dot on the drawer control can never disagree about what is happening.
  const sectionSignals: MobileSectionSignals = $derived({
    runningTasks: sidebar.allTasks.filter((task) => task.status === "running").length,
    prsNeedingReview: pullRequests.needsReview.countFor(
      session.serverIdForContext(session.ctx),
      session.ctx,
    ),
  });
  const currentSection = $derived(
    currentMobileSection(visibleRef(session.router.leadingPane)?.name),
  );

  let goalCollapsed = $state(false);
  let sidebarDrawerOpen = $state(false);
  let serverSheetOpen = $state(false);
  let taskSheetOpen = $state(false);
  let inputFocused = $state(false);

  // Browser/OS back closes the topmost open mobile overlay (last registered wins).
  registerBackOverlay("mobile-task-sheet", () => taskSheetOpen, () => (taskSheetOpen = false));
  registerBackOverlay("mobile-picker", () => runtime.isMobileViewport && session.unifiedPickerOpen, () => (session.unifiedPickerOpen = false));
  registerBackOverlay("mobile-drawer", () => sidebarDrawerOpen, () => (sidebarDrawerOpen = false));
  registerBackOverlay("mobile-plus-menu", () => mobileComposerMenu.open, () => (mobileComposerMenu.open = false));
  registerBackOverlay("mobile-server-sheet", () => serverSheetOpen, () => (serverSheetOpen = false));

  // A page route hides the navbar that normally holds the drawer control, so
  // the page's own header draws it instead. Published rather than imported by
  // the header: the desktop frame has a session sidebar where this drawer would
  // be, and a control it cannot open must not appear there at all.
  $effect(() => {
    frameChrome.openNavigationDrawer = () => (sidebarDrawerOpen = true);
    return () => {
      frameChrome.openNavigationDrawer = null;
    };
  });

  $effect(() => {
    frameChrome.navigationHasUnseen = hasUnseenSection(sectionSignals, currentSection);
  });

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
      onPageRoute}
  >
    <div class="mh-navbar-top">
      <button
        class="mh-navbar-side-btn"
        onclick={() => { sidebarDrawerOpen = true; }}
        aria-label="Tasks"
      >
        <SidebarSimpleIcon size={19} />
      </button>

      <button
        class="mh-navbar-center"
        onclick={() => (taskSheetOpen = true)}
        aria-haspopup="dialog"
        aria-expanded={taskSheetOpen}
      >
        <div class="mh-navbar-title-group">
          <span class="mh-navbar-title">{title}</span>
          <CaretDownIcon size={13} class="mh-navbar-caret" />
        </div>
        <!-- Path and state on one mono line: where this session lives, and what
             it is doing right now. The running duration ticks in place. -->
        <div class="mh-navbar-path">
          {#if headerPath}<span>{headerPath}</span>{/if}
          {#if headerPath && stateIcon}<span class="mh-navbar-path-dot"> · </span>{/if}
          {#if stateIcon}
            {@const StateIcon = stateIcon.component}
            <span
              class="mh-navbar-state"
              style="color:{stateIcon.color}"
              role="img"
              aria-label={stateLabel}
            >
              <StateIcon
                size={13}
                class={stateIcon.spin ? "animate-spin motion-reduce:animate-none" : ""}
              />
            </span>
          {/if}
          {#if elapsed}<span class="mh-navbar-elapsed"> {elapsed}</span>{/if}
        </div>
      </button>

      <button
        class="mh-navbar-side-btn mh-navbar-side-btn--accent"
        onclick={() => session.openSessionDraft({ via: "click" })}
        aria-label="New session"
      >
        <PlusIcon size={19} />
      </button>
    </div>

    <!-- The run rides the header hairline as a 2px seam rather than a spinner
         over the thread: it says "still working" without occupying the reading
         surface, and it is the same seam the review panel uses while loading. -->
    {#if isRunning}
      <div class="mh-navbar-seam" role="presentation">
        <span></span>
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
            <XIcon size={14} />
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
      !!mobileDraft ||
      !!mobileGoalSessionId ||
      onPageRoute ||
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
          <MobileComposerActions
            sourceId={session.activeTabId}
            {changedFilesCount}
          />
        {/snippet}
      </InputBar>
    </div>
  </div>
</div>

<MobilePlusMenu
  open={mobileComposerMenu.open}
  onClose={() => (mobileComposerMenu.open = false)}
  {onAttachFile}
  {onToggleWorkspace}
  {onToggleDiff}
  {diffPanelOpen}
  onOpenServers={() => (serverSheetOpen = true)}
  sourceId={mobileDraft?.id ?? session.activeTabId}
  canShowDiffPanel={canShowDiffPanel && !mobileDraft}
  changedFilesCount={mobileDraft ? 0 : changedFilesCount}
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

<MobileTaskSheet
  open={taskSheetOpen}
  onClose={() => (taskSheetOpen = false)}
  onOpenServers={() => {
    taskSheetOpen = false;
    serverSheetOpen = true;
  }}
/>

<style>
  .mode-hidden { display: none !important; }

  .mobile-shell {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    /* dvh, not vh: in a mobile browser the URL bar hides on scroll and comes
       back, and 100vh is the *largest* of those two states — so the composer
       spends half its life under the browser's own toolbar. */
    height: 100dvh;
    z-index: 1;
    background: var(--solus-container-bg);
    overflow: hidden;
    touch-action: manipulation;
    overscroll-behavior: none;
    contain: layout style;
  }

  /* Opaque, never translucent: the thread scrolls under the header, and a
     frosted band would leave half-legible words behind the title. Background
     plus a hairline, with a short fade below so the first line does not appear
     to be cut off by the rule. */
  .mh-navbar {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--background);
    border-bottom: 0.0625rem solid var(--hairline);
    padding-top: env(safe-area-inset-top, 0);
    padding-left: max(0.625rem, env(safe-area-inset-left, 0));
    padding-right: max(0.75rem, env(safe-area-inset-right, 0));
    z-index: 4;
    /* App chrome is not copy — long-press must never start a text selection,
       and in a browser tab it must not raise the OS callout either. Prose keeps
       both: Copy on a message stays the browser's. */
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  .mh-navbar-top {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 3.5rem;
  }

  /* Indeterminate, because a turn has no total to be a fraction of. */
  .mh-navbar-seam {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -0.0625rem;
    height: 0.125rem;
    overflow: hidden;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
  }

  .mh-navbar-seam > span {
    position: absolute;
    top: 0;
    height: 0.125rem;
    background: var(--running);
    animation: mh-seam 1.4s ease-in-out infinite;
  }

  @keyframes mh-seam {
    from {
      left: -40%;
      width: 40%;
    }
    to {
      left: 100%;
      width: 40%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mh-navbar-seam > span {
      animation: none;
      left: 0;
      width: 100%;
      opacity: 0.55;
    }
  }

  /* The destination strip carries its own horizontal padding (px-3.5), which
     would stack with the dock's — pull it back so chips align with the pill. */
  .mobile-destination-strip {
    margin: 0 -0.375rem 0.125rem;
  }

  .mh-navbar-side-btn {
    width: 2.75rem;
    height: 2.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
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
    border-radius: 0.5rem;
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

  .mh-navbar-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--solus-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.012em;
    line-height: 1.2;
  }

  :global(.mh-navbar-caret) {
    color: var(--solus-text-primary);
    flex-shrink: 0;
    opacity: 0.4;
  }

  .mh-navbar-path {
    max-width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.35;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mh-navbar-path-dot {
    opacity: 0.5;
  }

  /* The mark rides the mono line rather than sitting on it: `middle` against
     the line's own x-height keeps a 13px glyph centred on text one third its
     weight, with no hand-tuned offset to drift when the type rung changes. */
  .mh-navbar-state {
    display: inline-flex;
    vertical-align: middle;
  }

  .mh-navbar-elapsed {
    font-variant-numeric: tabular-nums;
  }

  .mobile-content {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    contain: layout paint;
  }

  /* A short fade under the hairline, so a line scrolling up under the header
     dissolves rather than looking sliced by the rule. */
  .mobile-content::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 1.25rem;
    z-index: 2;
    background: linear-gradient(var(--background), transparent);
    pointer-events: none;
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
    /* The inset *plus* a gap, not the larger of the two: in a browser tab the
       bottom 96px belong to Safari's toolbar, and a bar flush against the
       inset puts Send under it. */
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.75rem);
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
    /* The bottom row is 36px controls sitting in a 20px-radius corner, so the
       inset is what keeps them inside the curve: at the old 6px right / 2px
       bottom the send button's corner fell 1.4px outside the border and painted
       across it. 8px on three sides clears the curve by 3px and makes the `+`
       and send read as equally inset. The top stays tight because the text
       well's own padding already supplies the inset above. */
    padding: 0.125rem 0.5rem 0.5rem;
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

  /* 16px exactly, and not a rung: iOS zooms into any field under 16px on
     focus and does not zoom back out, so the page is left magnified with the
     composer half off-screen. `--text-sm` is 14px and did that. */
  .mobile-shell :global(.cm-editor) {
    font-size: var(--text-base);
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
