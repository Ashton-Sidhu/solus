<script lang="ts">
  import { tick } from "svelte";
  import {
    SparkleIcon,
    FilesIcon,
    TerminalWindowIcon,
    ArrowsOutSimpleIcon,
    ArrowsClockwiseIcon,
    GitForkIcon,
    TreeStructureIcon,
    SquareIcon,
    StarIcon,
    BinocularsIcon,
  } from "phosphor-svelte";
  import { REVIEW_PROGRESS_STEPS, type ReviewProgressStep } from "../../../shared/review";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSessionSidebarStore } from "../../contexts/session-sidebar.store.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { KEYBINDINGS, type BindingId } from "../../lib/keybindings/manifest";
  import { formatCombo } from "../../lib/keybindings/match";
  import { openInConfiguredEditor } from "../../lib/openExternalEditor";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import Kbd from "../ui/Kbd.svelte";
  import ActionOrbProgress from "./ActionOrbProgress.svelte";
  import "./ActionOrb.css";

  let {
    tabId,
    onDiffToggle,
  }: {
    tabId: string;
    onDiffToggle?: () => void;
  } = $props();

  type ActionId =
    | "stop"
    | "files"
    | "terminal"
    | "fork"
    | "continueWorktree"
    | "pin"
    | "review"
    | "diff";
  type PrimaryAction = "stop" | null;
  type OrbBadge = {
    kind: "running" | "success" | "count" | "branch";
    label: string;
    title: string;
  };

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const windowCtx = getWindowContext();
  const isPillMode = $derived(
    windowCtx.viewMode === "pill" && !windowCtx.isWeb,
  );
  const isUltrawide = $derived(windowCtx.workAreaWidth >= 2560);
  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));

  const changedFiles = $derived(sess?.changedFiles ?? []);
  const showDesktopActions = $derived(!runtime.isMobileViewport);
  const showNativeDesktopActions = $derived(
    showDesktopActions && !windowCtx.isWeb,
  );

  const isBranchDiff = $derived(
    !!sess?.gitContext &&
      sess.gitContext.branch !== sess.gitContext.targetBranch,
  );
  const showViewDiff = $derived(!!onDiffToggle && changedFiles.length > 0);
  const hasChangedFiles = $derived(changedFiles.length > 0);
  const showReview = $derived(hasChangedFiles);
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isCreatingWorktree = $derived(session.isContinuingInWorktree(tabId));
  const showOpenFiles = $derived(
    showNativeDesktopActions && hasChangedFiles && !!theme.defaultEditor,
  );
  const showOpenTerminal = $derived(showNativeDesktopActions && isPillMode);
  const showFork = $derived(!!sess?.agentSessionId && !isRunning);
  const showContinueWorktree = $derived(
    !!sess?.agentSessionId && !isRunning && !sess?.gitContext?.worktreePath,
  );
  const showPin = $derived(!!sess?.agentSessionId);
  const isPinned = $derived(sidebarStore.isPinned(sess?.agentSessionId));
  const showInterrupt = $derived(
    isRunning && (sess?.messages.some((m) => m.role === "user") ?? false),
  );
  const changedFilesLabel = $derived(
    changedFiles.length > 99 ? "99+" : String(changedFiles.length),
  );

  // ── Review changes (background generation) ──
  let reviewStatus = $state<"idle" | "generating" | "done">("idle");
  let reviewProgressStep = $state<ReviewProgressStep>("preparing");
  let reviewGuideKey = $state<string | null>(null);
  let reviewPopoverOpen = $state(false);
  let reviewCloseTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (!hasChangedFiles || tabId !== session.activeTabId) return;
    if (reviewStatus !== "idle") return;
    const ctx = session.ctxFor(tabId);
    const sid = sess?.agentSessionId;
    window.solus.getReviewContext(ctx).then(async (rc) => {
      if (!rc) return;
      const key = sid ? `${rc.key}__session-${sid}` : rc.key;
      const cached = await window.solus.readGuide(ctx, key);
      if (cached && reviewStatus === "idle") {
        reviewGuideKey = key;
        reviewStatus = "done";
      }
    });
  });

  const reviewStepIndex = (step: ReviewProgressStep) =>
    REVIEW_PROGRESS_STEPS.findIndex((s) => s.id === step);
  const currentReviewStepIdx = $derived(reviewStepIndex(reviewProgressStep));

  const reviewLabel = $derived(
    reviewStatus === "done"
      ? "View Review"
      : reviewStatus === "generating"
        ? "Reviewing…"
        : "Review",
  );

  function openReviewPopover() {
    if (reviewCloseTimer) {
      clearTimeout(reviewCloseTimer);
      reviewCloseTimer = null;
    }
    reviewPopoverOpen = true;
  }
  function closeReviewPopover() {
    if (reviewCloseTimer) clearTimeout(reviewCloseTimer);
    reviewCloseTimer = setTimeout(() => {
      reviewPopoverOpen = false;
      reviewCloseTimer = null;
    }, 120);
  }

  // ── Progress integrated into the action row ──
  // Circle when the row is cramped (compact), pill when there's room. Clicking
  // it swaps the action icons for a narrow inline progress bar.
  const progress = $derived(sess?.progress ?? null);
  const hasProgress = $derived(!!progress && progress.totalSteps > 0);
  const progressAllDone = $derived(
    !!progress && progress.todos.every((t) => t.status === "completed"),
  );
  const progressFraction = $derived.by(() => {
    if (!progress || progress.totalSteps === 0) return 0;
    const done = progress.todos.filter((t) => t.status === "completed").length;
    const active = progress.todos.some((t) => t.status === "in_progress")
      ? 0.5
      : 0;
    return Math.min(1, (done + active) / progress.totalSteps);
  });
  const progressHeader = $derived.by<string | null>(() => {
    if (!progress || progress.totalSteps === 0) return null;
    const active = progress.todos.find((t) => t.status === "in_progress");
    if (active) return active.content;
    if (progressAllDone) return "All steps complete";
    const next = progress.todos.find((t) => t.status === "pending");
    return next?.content ?? null;
  });
  // Steps detail reveals on hover/focus of the progress pill. A short close
  // delay lets the pointer cross the gap into the popover without it dismissing.
  let stepsOpen = $state(false);
  let stepsCloseTimer: ReturnType<typeof setTimeout> | null = null;
  function openSteps() {
    if (stepsCloseTimer) {
      clearTimeout(stepsCloseTimer);
      stepsCloseTimer = null;
    }
    stepsOpen = true;
  }
  function closeSteps() {
    if (stepsCloseTimer) clearTimeout(stepsCloseTimer);
    stepsCloseTimer = setTimeout(() => {
      stepsOpen = false;
      stepsCloseTimer = null;
    }, 120);
  }
  const itemIndices = $derived.by(() => {
    let idx = 0;
    return {
      pin: showPin ? idx++ : -1,
      stop: showInterrupt ? idx++ : -1,
      files: showOpenFiles ? idx++ : -1,
      terminal: showOpenTerminal ? idx++ : -1,
      fork: showFork ? idx++ : -1,
      continueWorktree: showContinueWorktree ? idx++ : -1,
      review: showReview ? idx++ : -1,
      diff: showViewDiff ? idx++ : -1,
    };
  });

  let expanded = $state(true);
  let allowOverflow = $state(true);

  let focusedAction: ActionId | null = $state(null);

  const hasActionInFlight = $derived(isRunning);
  const visibleActionIds = $derived.by((): ActionId[] => {
    const ids: ActionId[] = [];
    if (showPin) ids.push("pin");
    if (showInterrupt) ids.push("stop");
    if (showOpenFiles) ids.push("files");
    if (showOpenTerminal) ids.push("terminal");
    if (showFork) ids.push("fork");
    if (showContinueWorktree) ids.push("continueWorktree");
    if (showReview) ids.push("review");
    if (showViewDiff) ids.push("diff");
    return ids;
  });
  const primaryAction = $derived.by((): PrimaryAction => {
    if (showInterrupt) return "stop";
    return null;
  });
  const preferredAction = $derived(
    primaryAction ?? visibleActionIds[0] ?? null,
  );
  const activeAction = $derived(
    focusedAction && visibleActionIds.includes(focusedAction)
      ? focusedAction
      : preferredAction,
  );
  const orbBadge = $derived.by((): OrbBadge | null => {
    if (hasActionInFlight)
      return { kind: "running", label: "", title: "Action running" };
    if (hasChangedFiles) {
      return {
        kind: "count",
        label: changedFilesLabel,
        title: `${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""} changed`,
      };
    }
    if (isBranchDiff)
      return {
        kind: "branch",
        label: "BR",
        title: "Branch differs from target",
      };
    return null;
  });
  const orbTooltip = $derived.by(() => {
    if (orbBadge) return `Quick actions · ${orbBadge.title}`;
    if (hasChangedFiles) {
      return `Quick actions · ${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""} changed`;
    }
    return "Quick actions";
  });

  const av = session.artifactViewer;

  let rootEl: HTMLDivElement | null = $state(null);
  let panelEl: HTMLDivElement | null = $state(null);
  let compactByWidth = $state(false);
  const compact = $derived(compactByWidth || av.secondaryOpen);
  let medium = $state(false);

  function shortcutLabel(bindingId: BindingId): string {
    return formatCombo(KEYBINDINGS[bindingId].combo).join("");
  }

  function tabIndexFor(actionId: ActionId): 0 | -1 {
    return expanded && activeAction === actionId ? 0 : -1;
  }

  function focusAction(actionId: ActionId | null) {
    if (!actionId) return;
    focusedAction = actionId;
    void tick().then(() => {
      panelEl
        ?.querySelector<HTMLElement>(`[data-orb-action="${actionId}"]`)
        ?.focus();
    });
  }

  function focusPreferredAction() {
    focusAction(preferredAction);
  }

  let lastOrbScale = "";
  $effect(() => {
    // Only observe the active tab's orb — hidden tabs don't need width-tier
    // tracking and an observer on display:none subtrees still fires callbacks
    // on layout passes, creating unnecessary churn across all mounted tabs.
    if (!rootEl || tabId !== session.activeTabId) return;
    const ro = new ResizeObserver(([entry]) => {
      // The root tracks the conversation reading column (capped at
      // --solus-reading-max, ≤~1152px), so width is our proxy for "how big is
      // the conversation view": wide in editor mode, narrow in the pill window.
      const w = entry.contentRect.width;
      // Width tiers: narrow panes collapse to icon-only (compact), laptop-width
      // panes tighten (medium), full-width columns fall through to base.
      compactByWidth = w < 520;
      medium = w >= 520 && w < 820;
      // Continuous size bump tied to the column width — so the orb is larger in
      // editor mode than in the pill window on the same screen. Ramps from 1.0
      // at the editor min column (~640px) to 1.12 at the max (~1152px).
      const t = Math.max(0, Math.min(1, (w - 640) / 512));
      const scale = (1 - t * 0.05).toFixed(3);
      // Skip the style write (and the restyle it triggers) when the rounded
      // scale hasn't changed — most resize frames land on the same value.
      if (scale !== lastOrbScale) {
        lastOrbScale = scale;
        rootEl.style.setProperty("--orb-screen-scale", scale);
      }
    });
    ro.observe(rootEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!rootEl) return;
    rootEl.style.setProperty("--orb-window-scale", isUltrawide ? "1" : "1");
  });

  function handleOpenFiles() {
    const opened = openInConfiguredEditor(session.ctxFor(tabId), {
      filePaths: changedFiles,
      editorId: theme.defaultEditor,
      terminalId: theme.defaultTerminal,
      cwd: sess?.workingDirectory,
    });
    if (opened) requestInputFocus();
  }

  function handleOpenTerminal() {
    if (!tab) return;
    window.solus.openInTerminal(session.ctxFor(tabId));
    requestInputFocus();
  }

  function handleTogglePin() {
    if (!showPin) return;
    void sidebarStore.togglePinnedSession(tabId);
    requestInputFocus();
  }

  async function handleReview() {
    if (reviewStatus === "done" && reviewGuideKey) {
      av.enterReview(reviewGuideKey, "session");
      closeExpanded();
      return;
    }
    if (reviewStatus === "generating") return;

    reviewStatus = "generating";
    reviewProgressStep = "preparing";

    const unsubscribe = window.solus.onReviewProgress((event) => {
      reviewProgressStep = event.step;
    });

    try {
      const gen = await window.solus.generateGuide(
        session.ctxFor(tabId),
        { ...resolveReviewAgent(theme, agentContext), scope: "session" },
      );
      reviewGuideKey =
        gen?.key ??
        (await window.solus.getReviewContext(session.ctxFor(tabId)))?.key ??
        null;
      reviewStatus = "done";
    } catch {
      reviewStatus = "idle";
    } finally {
      unsubscribe();
      requestInputFocus();
    }
  }

  function handleRegenerate() {
    reviewStatus = "idle";
    reviewGuideKey = null;
    void handleReview();
  }

  function closeExpanded(focusInput = true) {
    allowOverflow = false;
    expanded = false;
    focusedAction = null;
    stepsOpen = false;
    if (focusInput) requestInputFocus();
  }

  function openExpanded() {
    expanded = true;
    setTimeout(() => {
      if (expanded) allowOverflow = true;
    }, 420);
    focusPreferredAction();
  }

  function expandWithoutFocus() {
    expanded = true;
    setTimeout(() => {
      if (expanded) allowOverflow = true;
    }, 420);
  }

  $effect(() => {
    if (session.activeTabId !== tabId || !sess?.agentSessionId) return;
    expandWithoutFocus();
  });

  function toggleExpanded() {
    if (expanded) closeExpanded();
    else openExpanded();
  }

  function isVisibleOrb() {
    return !!rootEl && !rootEl.closest(".mode-hidden");
  }

  function handlePanelKeydown(e: KeyboardEvent) {
    if (!expanded) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // Escape dismisses the steps popover first, then closes the orb.
      if (stepsOpen) {
        stepsOpen = false;
        return;
      }
      closeExpanded();
      return;
    }

    const ids = visibleActionIds;
    if (ids.length === 0) return;

    const activeEl = document.activeElement as HTMLElement | null;
    const activeId = activeEl?.dataset.orbAction as ActionId | undefined;
    const current =
      activeId && ids.includes(activeId) ? activeId : activeAction;
    const currentIndex = current ? ids.indexOf(current) : -1;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusAction(ids[(currentIndex + 1 + ids.length) % ids.length]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusAction(ids[(currentIndex - 1 + ids.length) % ids.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAction(ids[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAction(ids[ids.length - 1]);
    } else if ((e.key === "Enter" || e.key === " ") && activeEl === panelEl) {
      e.preventDefault();
      panelEl
        ?.querySelector<HTMLElement>(`[data-orb-action="${activeAction}"]`)
        ?.click();
    }
  }

  useKeybinding(
    "global.fork-tab",
    () => {
      if (showFork) {
        session.forkTab(tabId);
        requestInputFocus();
      }
    },
    {
      enabled: () => tabId === session.activeTabId && isVisibleOrb(),
    },
  );
  useKeybinding(
    "global.continue-worktree",
    () => {
      if (showContinueWorktree && !isCreatingWorktree) {
        session.continueInWorktree(tabId);
        requestInputFocus();
      }
    },
    {
      enabled: () => tabId === session.activeTabId && isVisibleOrb(),
    },
  );
  useKeybinding("orb.toggle", () => toggleExpanded(), {
    enabled: () => tabId === session.activeTabId && isVisibleOrb(),
  });
  useKeybinding("orb.open-terminal", () => handleOpenTerminal(), {
    enabled: () =>
      tabId === session.activeTabId && !windowCtx.isWeb && isVisibleOrb(),
  });
  useKeybinding("orb.pin", () => handleTogglePin(), {
    enabled: () => tabId === session.activeTabId && showPin && isVisibleOrb(),
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={rootEl}
  class="action-orb-root"
  class:pill-mode={isPillMode}
  class:compact
  class:medium
>
  <!-- Trigger: always bottom-right, compact status button -->
  <button
    class="orb-trigger"
    class:orb-trigger-active={hasChangedFiles && !expanded}
    class:orb-trigger-open={expanded}
    onclick={toggleExpanded}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    }}
    title={orbTooltip}
    aria-expanded={expanded}
    aria-controls="action-orb-panel-{tabId}"
    aria-haspopup="true"
    aria-label={orbTooltip}
    use:tooltip={orbTooltip}
  >
    <SparkleIcon size={13} weight="regular" />
    {#if orbBadge}
      <span class="orb-badge orb-badge-{orbBadge.kind}" aria-hidden="true">
        {orbBadge.label}
      </span>
    {/if}
  </button>

  <!-- Panel: streams up to center-bottom on expand -->
  <div
    id="action-orb-panel-{tabId}"
    bind:this={panelEl}
    class="orb-panel"
    class:orb-panel-visible={expanded}
    class:orb-panel-overflow={allowOverflow}
    onkeydown={handlePanelKeydown}
    tabindex="-1"
    role="toolbar"
    aria-label="Quick actions"
  >
    <div class="dock-actions">
      {#if showPin}
        <button
          class="dock-btn dock-btn-icon stagger-item"
          class:dock-btn-pinned={isPinned}
          data-orb-action="pin"
          tabindex={tabIndexFor("pin")}
          style="--item-index:{itemIndices.pin}"
          onclick={handleTogglePin}
          title={isPinned ? "Unpin session" : "Pin session to sidebar"}
          aria-label={isPinned ? "Unpin session" : "Pin session to sidebar"}
          aria-pressed={isPinned}
          use:tooltip={isPinned ? "Unpin session" : "Pin session to sidebar"}
        >
          <StarIcon size={13} weight={isPinned ? "fill" : "regular"} />
        </button>
      {/if}

      {#if hasProgress}
        <ActionOrbProgress
          progress={progress!}
          {isRunning}
          {progressAllDone}
          {progressFraction}
          {progressHeader}
          {stepsOpen}
          {expanded}
          {openSteps}
          {closeSteps}
        />
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if showInterrupt}
        <button
          class="dock-btn dock-btn-stop stagger-item"
          class:dock-btn-primary={primaryAction === "stop"}
          data-orb-action="stop"
          tabindex={tabIndexFor("stop")}
          style="--item-index:{itemIndices.stop}"
          onclick={() => {
            session.interruptTab(tab.id);
            window.solus.stopTab(session.ctxFor(tab.id));
            requestInputFocus();
          }}
          title="Stop current task"
          aria-label="Stop current task"
          use:tooltip={"Stop current task"}
        >
          <SquareIcon size={9} weight="fill" />
          <span>Stop</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("conversation.interrupt")}</Kbd
          >
        </button>
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if showOpenFiles}
        <button
          class="dock-btn stagger-item"
          data-orb-action="files"
          tabindex={tabIndexFor("files")}
          style="--item-index:{itemIndices.files}"
          onclick={handleOpenFiles}
          title={`Open ${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""} in editor`}
          aria-label={`Open ${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""} in editor`}
          use:tooltip={`Open ${changedFiles.length} file${changedFiles.length !== 1 ? "s" : ""} in editor`}
        >
          <FilesIcon size={13} weight="regular" />
          <span>Open Files ({changedFiles.length})</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("conversation.open-files")}</Kbd
          >
        </button>
      {/if}

      {#if showNativeDesktopActions}
        <button
          class="dock-btn stagger-item"
          data-orb-action="terminal"
          tabindex={tabIndexFor("terminal")}
          style="--item-index:{itemIndices.terminal}"
          onclick={handleOpenTerminal}
          title="Open session in terminal"
          aria-label="Open session in terminal"
          use:tooltip={"Open session in terminal"}
        >
          <TerminalWindowIcon size={13} weight="regular" />
          <span>Terminal</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("orb.open-terminal")}</Kbd
          >
        </button>
      {/if}

      {#if showFork}
        <button
          class="dock-btn stagger-item"
          data-orb-action="fork"
          tabindex={tabIndexFor("fork")}
          style="--item-index:{itemIndices.fork}"
          onclick={() => {
            session.forkTab(tabId);
            closeExpanded();
          }}
          title="Fork session into a new tab"
          aria-label="Fork session into a new tab"
          use:tooltip={"Fork session into a new tab"}
        >
          <GitForkIcon size={13} weight="regular" />
          <span>Fork</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("global.fork-tab")}</Kbd
          >
        </button>
      {/if}

      {#if showContinueWorktree}
        <button
          class="dock-btn stagger-item"
          class:dock-btn-worktree-pending={isCreatingWorktree}
          data-orb-action="continueWorktree"
          tabindex={tabIndexFor("continueWorktree")}
          style="--item-index:{itemIndices.continueWorktree}"
          onclick={() => {
            if (isCreatingWorktree) return;
            session.continueInWorktree(tabId);
            closeExpanded();
            requestInputFocus();
          }}
          disabled={isCreatingWorktree}
          title={isCreatingWorktree ? "Creating worktree…" : "Continue this session in a new worktree"}
          aria-label={isCreatingWorktree ? "Creating worktree" : "Continue this session in a new worktree"}
          aria-busy={isCreatingWorktree}
          use:tooltip={isCreatingWorktree ? "Creating worktree…" : "Continue this session in a new worktree"}
        >
          {#if isCreatingWorktree}
            <TreeStructureIcon size={13} weight="regular" />
            <span>Creating worktree</span>
          {:else}
            <TreeStructureIcon size={13} weight="regular" />
            <span>Worktree</span>
            <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
              >{shortcutLabel("global.continue-worktree")}</Kbd
            >
          {/if}
        </button>
      {/if}

      {#if showNativeDesktopActions || showFork || showContinueWorktree || showPin}
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if showReview}
        <span class="review-btn-wrap">
          {#if reviewPopoverOpen && reviewStatus === "generating"}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="review-pop"
              role="status"
              aria-label="Review progress"
              onmouseenter={openReviewPopover}
              onmouseleave={closeReviewPopover}
            >
              <div class="review-pop-head">
                <span class="review-pop-title">Reviewing changes</span>
              </div>
              <div class="review-pop-steps">
                {#each REVIEW_PROGRESS_STEPS as step, i (step.id)}
                  {@const isDone = i < currentReviewStepIdx}
                  {@const isActive = step.id === reviewProgressStep}
                  <div class="review-pop-step">
                    <span
                      class="review-pop-dot"
                      class:review-pop-dot-done={isDone}
                      class:review-pop-dot-active={isActive}
                      class:review-pop-dot-pending={!isDone && !isActive}
                    ></span>
                    <span
                      class="review-pop-label"
                      class:review-pop-label-done={isDone}
                      class:review-pop-label-active={isActive}
                    >{step.label}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
          <button
            class="dock-btn stagger-item"
            class:dock-btn-reviewing={reviewStatus === "generating"}
            class:dock-btn-review-done={reviewStatus === "done"}
            data-orb-action="review"
            tabindex={tabIndexFor("review")}
            style="--item-index:{itemIndices.review}"
            onclick={handleReview}
            onmouseenter={reviewStatus === "generating" ? openReviewPopover : undefined}
            onmouseleave={reviewStatus === "generating" ? closeReviewPopover : undefined}
            onfocus={reviewStatus === "generating" ? openReviewPopover : undefined}
            onblur={reviewStatus === "generating" ? closeReviewPopover : undefined}
            title={reviewLabel}
            aria-label={reviewLabel}
            use:tooltip={reviewLabel}
          >
            <BinocularsIcon size={13} weight="regular" />
            <span>{reviewLabel}</span>
          </button>
          {#if reviewStatus === "done"}
            <button
              class="dock-btn dock-btn-icon stagger-item"
              style="--item-index:{itemIndices.review}"
              tabindex={expanded ? 0 : -1}
              onclick={handleRegenerate}
              title="Regenerate review"
              aria-label="Regenerate review"
              use:tooltip={"Regenerate review"}
            >
              <ArrowsClockwiseIcon size={13} weight="regular" />
            </button>
          {/if}
        </span>
      {/if}

      {#if showViewDiff}
        <button
          class="dock-btn stagger-item"
          data-orb-action="diff"
          tabindex={tabIndexFor("diff")}
          style="--item-index:{itemIndices.diff}"
          onclick={() => {
            onDiffToggle?.();
            closeExpanded();
          }}
          title="View diff"
          aria-label="View diff"
          use:tooltip={"View diff"}
        >
          <ArrowsOutSimpleIcon size={13} weight="regular" />
          <span>Diff</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("global.toggle-diff-panel")}</Kbd
          >
        </button>
      {/if}

    </div>
  </div>
</div>
