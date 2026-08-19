<script lang="ts">
  import { tick } from "svelte";
  import {
    SparkleIcon,
    ChartBarIcon,
    FilesIcon,
    ArrowsClockwiseIcon,
    GitForkIcon,
    TreeStructureIcon,
    SquareIcon,
    StarIcon,
    BinocularsIcon,
  } from "phosphor-svelte";
  import {
    REVIEW_PROGRESS_STEPS,
    type ReviewProgressStep,
  } from "@solus/contracts/review";
  import {
    getSettingsContext,
    getAgentContext,
    getWorkspaceContext,
    getSessionSidebarStore,
    getWindowContext,
    getSessionEnvironmentStore,
    runtime,
    serversStore,
    toolsStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { KEYBINDINGS, type BindingId } from "../../lib/keybindings/manifest";
  import { formatCombo } from "../../lib/keybindings/match";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    reviewGuideStore,
    sessionGuideIdentity,
  } from "../review/review-guide.store.svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import Kbd from "../ui/Kbd.svelte";
  import TerminalAppLogo from "../settings/TerminalAppLogo.svelte";
  import * as Popover from "../ui/popover";
  import ActionOrbProgress from "./ActionOrbProgress.svelte";
  import DiffSummaryCard from "../conversation/DiffSummaryCard.svelte";
  import { actionOrbWouldOverflow } from "./lib/action-orb-layout";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import "./ActionOrb.css";

  let {
    tabId,
    observeLayout = false,
    leftReservedWidth = 0,
  }: {
    tabId: string;
    observeLayout?: boolean;
    leftReservedWidth?: number;
  } = $props();

  type ActionId =
    | "stop"
    | "files"
    | "terminal"
    | "fork"
    | "insights"
    | "continueWorktree"
    | "pin"
    | "review";
  type PrimaryAction = "stop" | null;
  type OrbBadge = {
    kind: "running" | "success" | "count" | "branch";
    label: string;
    title: string;
  };

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const sidebarStore = getSessionSidebarStore();
  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const windowCtx = getWindowContext();
  const isPillMode = $derived(
    windowCtx.viewMode === "pill" && !windowCtx.isWeb,
  );
  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  const gitCwd = $derived(
    sess?.run.gitContext?.worktreePath ?? sess?.run.workingDirectory,
  );
  const uncommittedFiles = $derived(
    environmentStore
      .statusFor(gitCwd)
      ?.uncommittedChanges.files.map((file) => file.path) ?? [],
  );
  const showDesktopActions = $derived(!runtime.isMobileViewport);
  const showNativeDesktopActions = $derived(
    showDesktopActions && !windowCtx.isWeb,
  );

  const isBranchDiff = $derived(
    !!sess?.run.gitContext &&
      sess.run.gitContext.branch !== sess.run.gitContext.targetBranch,
  );
  const hasSessionChanges = $derived(sessionChangedFiles.length > 0);
  const hasUncommittedChanges = $derived(uncommittedFiles.length > 0);
  // This action reviews one agent session. Never fall back to the branch key:
  // the environment panel owns branch reports, and those must not make this
  // session pill read as ready.
  const sessionReviewGuideKey = $derived(
    sess?.agentSessionId ? `session-${sess.agentSessionId}` : null,
  );
  const changesFingerprint = $derived(sessionChangedFiles.join("|"));
  const sessionReviewIdentity = $derived.by(() => {
    const identity = sessionGuideIdentity(sess);
    return identity ? { ...identity, revision: changesFingerprint } : null;
  });
  const sharedReviewStatus = $derived(
    reviewGuideStore.statusFor(
      session.apiFor(tabId),
      sessionReviewIdentity,
    ),
  );
  const showReview = $derived(
    hasSessionChanges && sessionReviewGuideKey !== null,
  );
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isCreatingWorktree = $derived(session.isContinuingInWorktree(tabId));
  const showOpenFiles = $derived(
    showNativeDesktopActions && hasUncommittedChanges,
  );
  const showOpenTerminal = $derived(showNativeDesktopActions && isPillMode);
  const remoteHost = $derived.by(() => {
    if (hostPolicy.isClientMachine(sess?.run.serverId)) return null;
    const host = serversStore.hostFor(sess?.run.serverId);
    return host ?? null;
  });
  // Names the terminal that will actually open — the one already attached to
  // the shared tmux session, or the Settings fallback when none is.
  const terminalTooltip = $derived(
    remoteHost
      ? `Runs on ${remoteHost.label} — not available for remote sessions`
      : toolsStore.resolvedTerminal
        ? `Open session in ${toolsStore.resolvedTerminal.name}`
        : "Open session in terminal",
  );
  // Forking mid-turn is allowed: the fork branches from the source's last
  // settled turn rather than the one still being written.
  const showFork = $derived(!!sess?.agentSessionId);
  const showContinueWorktree = $derived(
    !!sess?.agentSessionId && !isRunning && !sess?.run.gitContext?.worktreePath,
  );
  const showPin = $derived(!!sess?.agentSessionId);
  // What this session cost and where its time went. It reads the active host's
  // own telemetry, and a session that never reached the provider has no turns
  // recorded for it yet.
  const showInsights = $derived(showDesktopActions && !!sess?.agentSessionId);
  const isPinned = $derived(sidebarStore.isPinned(sess?.agentSessionId, sess?.run.serverId));
  const showInterrupt = $derived(
    isRunning && (sess?.messages.some((m) => m.role === "user") ?? false),
  );
  const uncommittedFilesLabel = $derived(
    uncommittedFiles.length > 99 ? "99+" : String(uncommittedFiles.length),
  );

  // ── Review changes (background generation) ──
  const reviewStatus = $derived<"idle" | "generating" | "done">(
    sharedReviewStatus?.status === "ready"
      ? "done"
      : sharedReviewStatus?.status === "queued" ||
          sharedReviewStatus?.status === "generating"
        ? "generating"
        : "idle",
  );
  const reviewProgressStep = $derived<ReviewProgressStep>(
    sharedReviewStatus?.step ?? "preparing",
  );
  const reviewGuideKey = $derived(
    sharedReviewStatus?.status === "ready" ? sharedReviewStatus.key : null,
  );
  let reviewPopoverOpen = $state(false);
  let lastReviewFailureAt = 0;

  $effect(() => {
    const identity = sessionReviewIdentity;
    if (!identity) return;
    const api = session.apiFor(tabId);
    void reviewGuideStore.load(
      api,
      session.ctxFor(tabId),
      identity,
      "session",
    );
  });

  $effect(() => {
    const status = sharedReviewStatus;
    if (!status) return;
    if (
      status.status === "failed" &&
      status.updatedAt !== lastReviewFailureAt
    ) {
      lastReviewFailureAt = status.updatedAt;
      toasts.error(
        status.error
          ? `Review stopped: ${status.error}`
          : "Review stopped before a guide was produced. Try again.",
      );
    }
  });

  const reviewStepIndex = (step: ReviewProgressStep) =>
    REVIEW_PROGRESS_STEPS.findIndex((s) => s.id === step);
  const currentReviewStepIdx = $derived(reviewStepIndex(reviewProgressStep));

  const reviewLabel = $derived(
    reviewStatus === "done"
      ? "Review changes"
      : reviewStatus === "generating"
        ? "Reviewing…"
        : "Review changes",
  );

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
  let reviewFilesOpen = $state(false);
  const itemIndices = $derived.by(() => {
    let idx = 0;
    return {
      pin: showPin ? idx++ : -1,
      stop: showInterrupt ? idx++ : -1,
      files: showOpenFiles ? idx++ : -1,
      terminal: showOpenTerminal ? idx++ : -1,
      fork: showFork ? idx++ : -1,
      insights: showInsights ? idx++ : -1,
      continueWorktree: showContinueWorktree ? idx++ : -1,
      review: showReview ? idx++ : -1,
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
    if (showInsights) ids.push("insights");
    if (showContinueWorktree) ids.push("continueWorktree");
    if (showReview) ids.push("review");
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
    if (hasUncommittedChanges) {
      return {
        kind: "count",
        label: uncommittedFilesLabel,
        title: `${uncommittedFiles.length} uncommitted file${uncommittedFiles.length !== 1 ? "s" : ""}`,
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
    if (hasUncommittedChanges) {
      return `Quick actions · ${uncommittedFiles.length} uncommitted file${uncommittedFiles.length !== 1 ? "s" : ""}`;
    }
    return "Quick actions";
  });

  const router = session.router;

  let rootEl: HTMLDivElement | null = $state(null);
  let panelEl: HTMLDivElement | null = $state(null);
  let orbScreenScale = $state("1");
  let compactByWidth = $state(false);
  const compact = $derived(compactByWidth || router.panes.length > 1);
  let expandedPanelWidth: number | null = null;

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

  $effect(() => {
    // Hidden pooled tabs do not need width-tier tracking. A split conversation
    // is not the active tab, but is visibly mounted beside it, so its caller
    // explicitly opts into measurement through observeLayout.
    if (!rootEl || !observeLayout) return;
    const updateDensity = () => {
      // The root tracks the conversation reading column (capped at
      // --solus-reading-max, ≤1088px), so width is our proxy for "how big is
      // the conversation view": wide in editor mode, narrow in the pill window.
      const w = rootEl?.clientWidth ?? 0;
      // Measure the labeled row while it is visible, then retain that width
      // while compact. This avoids a feedback loop where hiding labels makes
      // the row appear to fit and immediately expands it again.
      if (!compact && panelEl) expandedPanelWidth = panelEl.scrollWidth;
      compactByWidth = actionOrbWouldOverflow(
        w,
        expandedPanelWidth,
        leftReservedWidth,
      );
      // Continuous size bump tied to the column width — so the orb is larger in
      // editor mode than in the pill window on the same screen. Ramps from 1.0
      // at the editor min column (~640px) to 1.12 at the max (~1152px).
      const t = Math.max(0, Math.min(1, (w - 640) / 512));
      const scale = (1 - t * 0.05).toFixed(3);
      // Skip the style write (and the restyle it triggers) when the rounded
      // scale hasn't changed — most resize frames land on the same value.
      if (scale !== orbScreenScale) {
        orbScreenScale = scale;
        rootEl.style.setProperty("--orb-screen-scale", scale);
      }
    };
    const ro = new ResizeObserver(updateDensity);
    ro.observe(rootEl);
    if (panelEl) ro.observe(panelEl);
    updateDensity();
    return () => ro.disconnect();
  });

  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (tabId !== session.focusedChatTabId || !showOpenFiles) return;
      openExpanded();
      reviewFilesOpen = true;
    };
    window.addEventListener("solus:review-changed-files", handler);
    return () =>
      window.removeEventListener("solus:review-changed-files", handler);
  });

  function handleOpenDiffSummary(filePath?: string) {
    session.showDiff(tabId, { kind: "session" }, filePath);
    closeExpanded();
  }

  function handleOpenTerminal() {
    if (!tab || remoteHost) return;
    // Opening one attaches a terminal to the shared session, so re-resolve:
    // the next launch reuses it rather than starting the fallback.
    void session
      .apiFor(tabId)
      .openInTerminal(session.ctxFor(tabId))
      .then(() => toolsStore.refreshResolvedTerminal(theme.fallbackTerminal));
    requestInputFocus();
  }

  function openSessionInsights() {
    const sessionId = sess?.id;
    if (!sessionId) return;
    session.openInsightsForSession(sessionId);
    closeExpanded();
  }

  function handleTogglePin() {
    if (!showPin) return;
    void sidebarStore.togglePinnedSession(tabId);
    requestInputFocus();
  }

  async function handleReview(regenerate = false) {
    // One click, always: open the review pane on its diff, and queue the
    // generation behind it when there is nothing to read yet. Generation is
    // durable, so the pane reports its progress rather than the click ending in
    // a panel the reader still has to go and find.
    if (!regenerate) {
      session.enterReview("session", tabId);
      closeExpanded();
      if (reviewStatus === "done" && reviewGuideKey) return;
    }
    if (reviewStatus === "generating") return;
    const identity = sessionReviewIdentity;
    if (!identity) return;
    const api = session.apiFor(tabId);

    try {
      await reviewGuideStore.generate(api, session.ctxFor(tabId), identity, {
        ...resolveReviewAgent(theme, agentContext),
        scope: "session",
      });
    } catch (error) {
      toasts.error("Couldn't start review", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  function handleCancelReview() {
    if (reviewStatus !== "generating") return;
    reviewPopoverOpen = false;
    void reviewGuideStore.cancel(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      "session",
    );
    requestInputFocus();
  }

  function handleRegenerate() {
    void handleReview(true);
  }

  function closeExpanded(focusInput = true) {
    allowOverflow = false;
    expanded = false;
    focusedAction = null;
    stepsOpen = false;
    reviewFilesOpen = false;
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
      // Escape dismisses popovers first, then closes the orb.
      if (stepsOpen) {
        stepsOpen = false;
        return;
      }
      if (reviewFilesOpen) {
        reviewFilesOpen = false;
        return;
      }
      closeExpanded();
      return;
    }

    const ids = visibleActionIds;
    if (ids.length === 0) return;

    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeId = ids.find((id) => id === activeEl?.dataset.orbAction);
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
      enabled: () => tabId === session.focusedChatTabId && isVisibleOrb(),
    },
  );
  useKeybinding(
    "global.continue-worktree",
    () => {
      if (showContinueWorktree && !isCreatingWorktree) {
        session.continueInWorktree(tabId, "keybinding");
        requestInputFocus();
      }
    },
    {
      enabled: () =>
        tabId === session.focusedChatTabId &&
        isVisibleOrb() &&
        showContinueWorktree &&
        !isCreatingWorktree,
    },
  );
  useKeybinding("orb.toggle", () => toggleExpanded(), {
    enabled: () => tabId === session.focusedChatTabId && isVisibleOrb(),
  });
  useKeybinding("orb.open-terminal", () => handleOpenTerminal(), {
    enabled: () =>
      tabId === session.focusedChatTabId && !windowCtx.isWeb && isVisibleOrb(),
  });
  useKeybinding("orb.pin", () => handleTogglePin(), {
    enabled: () =>
      tabId === session.focusedChatTabId && showPin && isVisibleOrb(),
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={rootEl}
  class="action-orb-root pointer-events-none absolute inset-x-0 inset-y-0 z-[6] mx-auto [contain:layout]"
  class:pill-mode={isPillMode}
  class:compact
  class:orb-streaming={isRunning}
>
  <!-- Trigger: always bottom-right, compact status button -->
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    class="orb-trigger pointer-events-auto absolute flex cursor-pointer items-center justify-center rounded-full [isolation:isolate]"
    class:orb-trigger-active={hasUncommittedChanges && !expanded}
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
  >
    <SparkleIcon size={13} weight="regular" />
    {#if orbBadge}
      <span
        class="orb-badge orb-badge-{orbBadge.kind} absolute inline-flex items-center justify-center rounded-full font-medium leading-none tabular-nums"
        aria-hidden="true"
      >
        {orbBadge.label}
      </span>
    {/if}
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={orbTooltip} />
  </TooltipUI.Root>

  <!-- Panel: streams up to center-bottom on expand -->
  <div
    id="action-orb-panel-{tabId}"
    bind:this={panelEl}
    class="orb-panel pointer-events-none absolute left-1/2 inline-flex max-w-[calc(100%_-_2rem)] items-center whitespace-nowrap rounded-full border-0 bg-transparent p-0 opacity-0 shadow-none"
    class:orb-panel-visible={expanded}
    class:overflow-visible={allowOverflow}
    onkeydown={handlePanelKeydown}
    tabindex="-1"
    role="toolbar"
    aria-label="Quick actions"
  >
    <div
      class="dock-actions inline-flex items-center justify-center gap-(--orb-gap)"
    >
      {#if showPin}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          class="dock-btn dock-btn-icon stagger-item"
          class:dock-btn-pinned={isPinned}
          data-orb-action="pin"
          tabindex={tabIndexFor("pin")}
          style="--item-index:{itemIndices.pin}"
          onclick={handleTogglePin}
          title={isPinned ? "Unpin session" : "Pin session to sidebar"}
          aria-label={isPinned ? "Unpin session" : "Pin session to sidebar"}
          aria-pressed={isPinned}
        >
          <StarIcon size={13} weight={isPinned ? "fill" : "regular"} />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={isPinned ? "Unpin session" : "Pin session to sidebar"} />
        </TooltipUI.Root>
      {/if}

      {#if showInterrupt}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          class="dock-btn dock-btn-stop stagger-item"
          class:dock-btn-primary={primaryAction === "stop"}
          data-orb-action="stop"
          tabindex={tabIndexFor("stop")}
          style="--item-index:{itemIndices.stop}"
          onclick={() => {
            session.interruptTabSession(tab.id);
            session.apiFor(tab.id).stopSession(session.ctxFor(tab.id).session.sessionId);
            requestInputFocus();
          }}
          title="Stop current task"
          aria-label="Stop current task"
        >
          <SquareIcon size={9} weight="fill" />
          <span>Stop</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("conversation.interrupt")}</Kbd
          >
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Stop current task"} />
        </TooltipUI.Root>
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if hasProgress}
        <ActionOrbProgress
          progress={progress!}
          {isRunning}
          {progressAllDone}
          {progressFraction}
          {progressHeader}
          bind:stepsOpen
          {expanded}
          {orbScreenScale}
        />
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if showOpenFiles}
        <Popover.Root
          bind:open={reviewFilesOpen}
          onOpenChange={(open) => {
            if (!open) requestInputFocus();
          }}
        >
          <Popover.Content
            class="files-pop progress-popover p-0"
            side="top"
            sideOffset={11}
            style={`--orb-scale: calc(var(--solus-font-scale, 1) * ${orbScreenScale})`}
            role="dialog"
            aria-label="Review changed files"
          >
            <DiffSummaryCard
              {tabId}
              changedFiles={sessionChangedFiles}
              onOpenDiff={handleOpenDiffSummary}
              embedded
            />
          </Popover.Content>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                class="dock-btn stagger-item"
                data-orb-action="files"
                tabindex={tabIndexFor("files")}
                style="--item-index:{itemIndices.files}"
                aria-label={`Review ${sessionChangedFiles.length} session file${sessionChangedFiles.length !== 1 ? "s" : ""}`}
              >
                <FilesIcon size={13} weight="regular" />
                <span>Changed Files ({sessionChangedFiles.length})</span>
                <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
                  >{shortcutLabel("conversation.open-files")}</Kbd
                >
              </button>
            {/snippet}
          </Popover.Trigger>
        </Popover.Root>
      {/if}

      {#if showNativeDesktopActions}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          class="dock-btn stagger-item"
          data-orb-action="terminal"
          tabindex={tabIndexFor("terminal")}
          style="--item-index:{itemIndices.terminal}"
          onclick={handleOpenTerminal}
          disabled={!!remoteHost}
          title={terminalTooltip}
          aria-label="Open session in terminal"
        >
          <TerminalAppLogo size={13} />
          <span>Terminal</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("orb.open-terminal")}</Kbd
          >
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={terminalTooltip} />
        </TooltipUI.Root>
      {/if}

      {#if showFork}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
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
        >
          <GitForkIcon size={13} weight="regular" />
          <span>Fork</span>
          <Kbd variant="inline" class="opacity-35 ml-[0.1875rem]"
            >{shortcutLabel("global.fork-tab")}</Kbd
          >
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Fork session into a new tab"} />
        </TooltipUI.Root>
      {/if}

      {#if showInsights}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          class="dock-btn stagger-item"
          data-orb-action="insights"
          tabindex={tabIndexFor("insights")}
          style="--item-index:{itemIndices.insights}"
          onclick={openSessionInsights}
          title="Open session in insights"
          aria-label="Open session in insights"
        >
          <ChartBarIcon size={13} weight="regular" />
          <span>Insights</span>
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Open session in insights"} />
        </TooltipUI.Root>
      {/if}

      {#if showContinueWorktree}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
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
          title={isCreatingWorktree
            ? "Creating worktree…"
            : "Continue this session in a new worktree"}
          aria-label={isCreatingWorktree
            ? "Creating worktree"
            : "Continue this session in a new worktree"}
          aria-busy={isCreatingWorktree}
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
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={isCreatingWorktree
            ? "Creating worktree…"
            : "Continue this session in a new worktree"} />
        </TooltipUI.Root>
      {/if}

      {#if showNativeDesktopActions || showFork || showContinueWorktree || showPin}
        <span class="dock-divider" aria-hidden="true"></span>
      {/if}

      {#if showReview}
        <span class="relative inline-flex">
          <Popover.Root
            bind:open={reviewPopoverOpen}
            onOpenChange={(open) => {
              reviewPopoverOpen = reviewStatus === "generating" && open;
            }}
          >
            {#if reviewStatus === "generating"}
              <Popover.Content
                class="review-pop"
                side="top"
                sideOffset={8}
                role="status"
                aria-label="Review progress"
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
                        >{step.label}</span
                      >
                    </div>
                  {/each}
                </div>
              </Popover.Content>
            {/if}
            <Popover.Trigger
              onclick={() => void handleReview()}
              openOnHover={reviewStatus === "generating"}
              openDelay={0}
              closeDelay={120}
            >
              {#snippet child({ props })}
                <TooltipUI.Root>
                  <TooltipUI.Trigger>
                    {#snippet child({ props: tooltipProps })}
                      <button {...tooltipProps}
                  {...props}
                  class="dock-btn stagger-item"
                  class:dock-btn-reviewing={reviewStatus === "generating"}
                  class:dock-btn-review-done={reviewStatus === "done"}
                  data-orb-action="review"
                  tabindex={tabIndexFor("review")}
                  style="--item-index:{itemIndices.review}"
                  title={reviewLabel}
                  aria-label={reviewLabel}
                >
                  <BinocularsIcon size={13} weight="regular" />
                  <span>{reviewLabel}</span>
                </button>
                    {/snippet}
                  </TooltipUI.Trigger>
                  <TooltipUI.Content value={reviewLabel} />
                </TooltipUI.Root>
              {/snippet}
            </Popover.Trigger>
          </Popover.Root>
          {#if reviewStatus === "done"}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button {...tooltipProps}
              class="dock-btn dock-btn-icon stagger-item"
              style="--item-index:{itemIndices.review}"
              tabindex={expanded ? 0 : -1}
              onclick={handleRegenerate}
              title="Regenerate review"
              aria-label="Regenerate review"
            >
              <ArrowsClockwiseIcon size={13} weight="regular" />
            </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={"Regenerate review"} />
            </TooltipUI.Root>
          {:else if reviewStatus === "generating"}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button {...tooltipProps}
              class="dock-btn dock-btn-icon dock-btn-stop stagger-item"
              style="--item-index:{itemIndices.review}"
              tabindex={expanded ? 0 : -1}
              onclick={handleCancelReview}
              title="Cancel review"
              aria-label="Cancel review"
            >
              <SquareIcon size={9} weight="fill" />
            </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={"Cancel review"} />
            </TooltipUI.Root>
          {/if}
        </span>
      {/if}

    </div>
  </div>
</div>
