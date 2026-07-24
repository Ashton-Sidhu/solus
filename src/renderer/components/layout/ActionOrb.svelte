<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    SparkleIcon,
    FilesIcon,
    TerminalWindowIcon,
    ArrowsOutSimpleIcon,
    ArrowsClockwiseIcon,
    ArrowSquareOutIcon,
    GitForkIcon,
    TreeStructureIcon,
    SquareIcon,
    StarIcon,
    BinocularsIcon,
  } from "phosphor-svelte";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import {
    REVIEW_PROGRESS_STEPS,
    type ReviewProgressStep,
  } from "../../../shared/review";
  import {
    getSettingsContext,
    getAgentContext,
    getWorkspaceContext,
    getSessionSidebarStore,
    getWindowContext,
    getSessionEnvironmentStore,
    runtime,
  } from "../../contexts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { KEYBINDINGS, type BindingId } from "../../lib/keybindings/manifest";
  import { formatCombo } from "../../lib/keybindings/match";
  import { openInConfiguredEditor } from "../../lib/openExternalEditor";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import Kbd from "../ui/Kbd.svelte";
  import * as Popover from "../ui/popover";
  import ActionOrbProgress from "./ActionOrbProgress.svelte";
  import { actionOrbWouldOverflow } from "./lib/action-orb-layout";
  import "./ActionOrb.css";

  let {
    tabId,
    onDiffToggle,
    observeLayout = false,
    leftReservedWidth = 0,
  }: {
    tabId: string;
    onDiffToggle?: () => void;
    observeLayout?: boolean;
    leftReservedWidth?: number;
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
  type FileStat = { additions: number; deletions: number };

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
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

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  const gitCwd = $derived(
    sess?.gitContext?.worktreePath ?? sess?.workingDirectory,
  );
  const uncommittedFiles = $derived(
    environmentStore
      .statusFor(gitCwd)
      ?.uncommittedChanges.files.map((file) => file.path) ?? [],
  );
  const projectRoot = $derived.by(() => {
    const ctxProjectPath = session.ctxFor(tabId).session.projectPath;
    return (
      ctxProjectPath ||
      sess?.gitContext?.repoRoot ||
      sess?.workingDirectory ||
      ""
    );
  });
  const displayRoot = $derived(
    sess?.gitContext?.worktreePath || sess?.gitContext?.repoRoot || projectRoot,
  );
  const showDesktopActions = $derived(!runtime.isMobileViewport);
  const showNativeDesktopActions = $derived(
    showDesktopActions && !windowCtx.isWeb,
  );

  const isBranchDiff = $derived(
    !!sess?.gitContext &&
      sess.gitContext.branch !== sess.gitContext.targetBranch,
  );
  const showViewDiff = $derived(
    !!onDiffToggle && sessionChangedFiles.length > 0,
  );
  const hasSessionChanges = $derived(sessionChangedFiles.length > 0);
  const hasUncommittedChanges = $derived(uncommittedFiles.length > 0);
  const showReview = $derived(hasSessionChanges);
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isCreatingWorktree = $derived(session.isContinuingInWorktree(tabId));
  const showOpenFiles = $derived(
    showNativeDesktopActions && hasUncommittedChanges,
  );
  const showOpenTerminal = $derived(showNativeDesktopActions && isPillMode);
  const remoteHost = $derived(
    sess?.serverId && sess.serverId !== LOCAL_SERVER_ID
      ? (serversStore.servers.find((server) => server.id === sess.serverId) ?? { label: "remote host" })
      : null,
  );
  const terminalTooltip = $derived(
    remoteHost
      ? `Runs on ${remoteHost.label} — not available for remote sessions`
      : "Open session in terminal",
  );
  const showFork = $derived(!!sess?.agentSessionId && !isRunning);
  const showContinueWorktree = $derived(
    !!sess?.agentSessionId && !isRunning && !sess?.gitContext?.worktreePath,
  );
  const showPin = $derived(!!sess?.agentSessionId);
  const isPinned = $derived(sidebarStore.isPinned(sess?.agentSessionId));
  const showInterrupt = $derived(
    isRunning && (sess?.messages.some((m) => m.role === "user") ?? false),
  );
  const uncommittedFilesLabel = $derived(
    uncommittedFiles.length > 99 ? "99+" : String(uncommittedFiles.length),
  );

  // ── Review changes (background generation) ──
  let reviewStatus = $state<"idle" | "generating" | "done">("idle");
  let reviewProgressStep = $state<ReviewProgressStep>("preparing");
  let reviewGuideKey = $state<string | null>(null);
  let reviewPopoverOpen = $state(false);
  let reviewRunId = 0;
  // Fingerprint of the change set the current "done" guide covered. When the
  // session keeps editing past it, drop back to "Review" instead of latching
  // "View Review" on a walkthrough of an older change.
  let reviewSnapshot = $state<string | null>(null);
  const changesFingerprint = $derived(sessionChangedFiles.join("|"));

  // Latch keyed by tabId → the change-set fingerprint we last probed for a cached
  // guide. Without it, every re-activation of a dirty tab whose probe found no
  // guide (status stays "idle") repeats getReviewContext + readGuide — a git
  // round-trip in main per tab switch. Plain (non-reactive) Map: it's a memo, not
  // rendered state, so it must not itself invalidate the effect. Fingerprint read
  // via untrack for the same reason — the probe is scoped to activation, not to
  // every mid-turn file change.
  const reviewCheckedFingerprint = new Map<string, string>();
  $effect(() => {
    if (!hasSessionChanges || tabId !== session.activeTabId) return;
    if (reviewStatus !== "idle") return;
    const fp = untrack(() => changesFingerprint);
    if (reviewCheckedFingerprint.get(tabId) === fp) return;
    reviewCheckedFingerprint.set(tabId, fp);
    const ctx = session.ctxFor(tabId);
    const sid = sess?.agentSessionId;
    window.solus.getReviewContext(ctx).then(async (rc) => {
      if (!rc) return;
      const key = sid ? `session-${sid}` : rc.branch.replace(/\//g, "__");
      const cached = await window.solus.readGuide(ctx, key);
      // A cached guide from an older HEAD is stale — leave the orb on "Review"
      // so clicking generates a fresh walkthrough.
      if (cached && cached.headSha && cached.headSha !== rc.headSha) return;
      if (cached && reviewStatus === "idle") {
        reviewGuideKey = key;
        reviewSnapshot = changesFingerprint;
        reviewStatus = "done";
      }
    });
  });

  $effect(() => {
    if (reviewStatus !== "done" || reviewSnapshot === null) return;
    if (changesFingerprint !== reviewSnapshot) {
      reviewStatus = "idle";
      reviewGuideKey = null;
      reviewSnapshot = null;
    }
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
  let fileStats = $state<Record<string, FileStat>>({});
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
  const totalFileStats = $derived.by(() => {
    let additions = 0;
    let deletions = 0;
    for (const path of sessionChangedFiles) {
      const stats = statsFor(path);
      additions += stats?.additions ?? 0;
      deletions += stats?.deletions ?? 0;
    }
    return { additions, deletions };
  });
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

  const panes = session.panes;

  let rootEl: HTMLDivElement | null = $state(null);
  let panelEl: HTMLDivElement | null = $state(null);
  let orbScreenScale = $state("1");
  let compactByWidth = $state(false);
  const compact = $derived(
    compactByWidth || panes.secondaryVisible.kind !== "empty",
  );
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
      // --solus-reading-max, ≤~1152px), so width is our proxy for "how big is
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
    if (!rootEl) return;
    rootEl.style.setProperty("--orb-window-scale", isUltrawide ? "1" : "1");
  });

  $effect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (tabId !== session.focusedChatTabId || !showOpenFiles) return;
      openExpanded();
      reviewFilesOpen = true;
    };
    window.addEventListener("solus:review-changed-files", handler);
    return () =>
      window.removeEventListener("solus:review-changed-files", handler);
  });

  $effect(() => {
    if (
      !reviewFilesOpen ||
      !hasSessionChanges ||
      tabId !== session.focusedChatTabId
    ) {
      fileStats = {};
      return;
    }
    const fingerprint = changesFingerprint;
    const livePaths = [...sessionChangedFiles];
    const ctx = session.ctxFor(tabId);
    let cancelled = false;
    session.apiFor(tabId).diffStats(ctx, { scope: { kind: "session" }, livePaths }).then((files) => {
      if (cancelled || fingerprint !== changesFingerprint) return;
      const nextStats: Record<string, FileStat> = {};
      for (const file of files) {
        nextStats[file.path] = {
          additions: file.additions,
          deletions: file.deletions,
        };
      }
      fileStats = nextStats;
    }).catch(() => {
      if (!cancelled) fileStats = {};
    });
    return () => {
      cancelled = true;
    };
  });

  function handleOpenFiles() {
    const opened = openInConfiguredEditor(session.ctxFor(tabId), {
      filePaths: uncommittedFiles,
      editorId: theme.defaultEditor,
      terminalId: theme.defaultTerminal,
      cwd: sess?.workingDirectory,
    });
    if (opened) closeExpanded();
  }

  function handleOpenFileDiff(path: string) {
    panes.enterDiff(tabId, { kind: "session" }, displayPath(path));
    closeExpanded();
  }

  function stripPathBase(path: string, base?: string | null): string {
    if (!base || !path.startsWith("/")) return path;
    const normalizedBase = base.replace(/\/$/, "");
    if (!normalizedBase) return path;
    if (path === normalizedBase) return "";
    return path.startsWith(`${normalizedBase}/`)
      ? path.slice(normalizedBase.length + 1)
      : path;
  }

  function displayPath(path: string): string {
    const trimmed = path.replace(/^\.\//, "");
    if (!trimmed.startsWith("/")) {
      const cwd = sess?.workingDirectory?.replace(/\/$/, "") ?? "";
      const root = displayRoot.replace(/\/$/, "");
      if (cwd && root && cwd !== root && cwd.startsWith(`${root}/`)) {
        const cwdRelative = cwd.slice(root.length + 1);
        if (trimmed === cwdRelative || trimmed.startsWith(`${cwdRelative}/`))
          return trimmed;
        return `${cwdRelative}/${trimmed}`.replace(/^\.\//, "");
      }
      return trimmed;
    }
    const withoutWorktree = stripPathBase(
      trimmed,
      sess?.gitContext?.worktreePath,
    );
    if (withoutWorktree !== trimmed) return withoutWorktree;
    const withoutProject = stripPathBase(trimmed, projectRoot);
    if (withoutProject !== trimmed) return withoutProject;
    const withoutRepo = stripPathBase(trimmed, sess?.gitContext?.repoRoot);
    if (withoutRepo !== trimmed) return withoutRepo;
    return stripPathBase(trimmed, sess?.workingDirectory).replace(/^\.\//, "");
  }

  function fileName(path: string): string {
    const relativePath = displayPath(path);
    const parts = relativePath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? relativePath;
  }

  function fileDir(path: string): string {
    const relativePath = displayPath(path);
    const idx = relativePath.lastIndexOf("/");
    return idx > 0 ? relativePath.slice(0, idx + 1) : "";
  }

  function statsFor(path: string): FileStat {
    const relativePath = displayPath(path);
    return (
      fileStats[path] ??
      fileStats[relativePath] ?? { additions: 0, deletions: 0 }
    );
  }

  function handleOpenTerminal() {
    if (!tab || remoteHost) return;
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
      panes.enterReview(reviewGuideKey, "session");
      closeExpanded();
      return;
    }
    if (reviewStatus === "generating") return;

    const runId = ++reviewRunId;
    reviewStatus = "generating";
    reviewProgressStep = "preparing";

    // Progress events broadcast to every subscriber; only track this session's
    // generation so a concurrent branch/other-tab run can't drive our steps.
    const sid = sess?.agentSessionId;
    const unsubscribe = window.solus.onReviewProgress((event) => {
      if (sid && event.key !== `session-${sid}`) return;
      reviewProgressStep = event.step;
    });

    try {
      const gen = await window.solus.generateGuide(session.ctxFor(tabId), {
        ...resolveReviewAgent(theme, agentContext),
        scope: "session",
      });
      if (runId !== reviewRunId) return;
      reviewGuideKey = gen?.persisted ? gen.key : null;
      reviewSnapshot = changesFingerprint;
      reviewStatus = reviewGuideKey ? "done" : "idle";
    } catch {
      if (runId === reviewRunId) reviewStatus = "idle";
    } finally {
      unsubscribe();
      if (runId !== reviewRunId) return;
      requestInputFocus();
    }
  }

  function handleCancelReview() {
    if (reviewStatus !== "generating") return;
    reviewRunId += 1;
    reviewStatus = "idle";
    reviewPopoverOpen = false;
    void window.solus.cancelGenerateGuide(session.ctxFor(tabId), {
      scope: "session",
    });
    requestInputFocus();
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
      enabled: () => tabId === session.focusedChatTabId && isVisibleOrb(),
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
      enabled: () => tabId === session.focusedChatTabId && isVisibleOrb(),
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
  <button
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
    use:tooltip={orbTooltip}
  >
    <SparkleIcon size={13} weight="regular" />
    {#if orbBadge}
      <span
        class="orb-badge orb-badge-{orbBadge.kind} absolute inline-flex items-center justify-center rounded-full font-bold leading-none tabular-nums"
        aria-hidden="true"
      >
        {orbBadge.label}
      </span>
    {/if}
  </button>

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

      {#if showInterrupt}
        <button
          class="dock-btn dock-btn-stop stagger-item"
          class:dock-btn-primary={primaryAction === "stop"}
          data-orb-action="stop"
          tabindex={tabIndexFor("stop")}
          style="--item-index:{itemIndices.stop}"
          onclick={() => {
            session.interruptTab(tab.id);
            session.apiFor(tab.id).stopTab(session.ctxFor(tab.id));
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
            class="files-pop progress-popover gap-0 p-0"
            side="top"
            sideOffset={11}
            style={`--orb-scale: calc(var(--solus-font-scale, 1) * ${orbScreenScale})`}
            role="dialog"
            aria-label="Review changed files"
          >
            <div
              class="files-pop-head grid grid-cols-[auto_minmax(0,1fr)_auto] items-center"
            >
              <span
                class="files-pop-icon inline-flex items-center justify-center"
                aria-hidden="true"
              >
                <FilesIcon size={18} weight="regular" />
              </span>
              <div
                class="files-pop-title-block flex min-w-0 items-baseline gap-[calc(0.5rem_*_var(--orb-scale))]"
              >
                <span
                  class="files-pop-title truncate text-(--solus-text-primary) [font-size:var(--pop-title-size)] leading-[1.25] font-semibold tracking-normal"
                  >{sessionChangedFiles.length} file{sessionChangedFiles.length !==
                  1
                    ? "s"
                    : ""}</span
                >
                <span
                  class="files-pop-subtitle inline-flex shrink-0 items-center gap-[calc(0.25rem_*_var(--orb-scale))] text-(--solus-text-tertiary) [font-size:var(--pop-meta-size)] leading-[1.25] font-medium tabular-nums"
                >
                  <span class="files-pop-add text-(--solus-art-positive)"
                    >+{totalFileStats.additions}</span
                  >
                  <span class="files-pop-del text-(--solus-art-negative)"
                    >-{totalFileStats.deletions}</span
                  >
                </span>
              </div>
              <button
                class="files-pop-primary inline-flex cursor-pointer items-center justify-center whitespace-nowrap bg-[color-mix(in_srgb,var(--solus-container-bg)_54%,transparent)] text-(--solus-text-secondary)"
                onclick={handleOpenFiles}
                disabled={!theme.defaultEditor}
                title={theme.defaultEditor
                  ? "Open files in editor"
                  : "Choose a default editor in settings"}
                aria-label="Open files in editor"
                use:tooltip={theme.defaultEditor
                  ? "Open files in editor"
                  : "Choose a default editor in settings"}
              >
                <ArrowSquareOutIcon size={15} weight="regular" />
                <span>Open files in editor</span>
              </button>
            </div>
            <div class="files-pop-list overflow-auto">
              {#each sessionChangedFiles as path (path)}
                {@const stats = statsFor(path)}
                <button
                  class="files-pop-row grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_calc(4.25rem_*_var(--orb-scale))] items-center border-0 bg-transparent text-left"
                  type="button"
                  onclick={() => handleOpenFileDiff(path)}
                  aria-label={`Open diff for ${displayPath(path)}`}
                >
                  <span
                    class="files-pop-path min-w-0 truncate text-(--solus-text-primary) [font-size:var(--pop-body-size)] leading-[1.35] font-medium"
                  >
                    <span
                      class="files-pop-dir font-normal text-(--solus-text-tertiary)"
                      >{fileDir(path)}</span
                    >{fileName(path)}
                  </span>
                  <span
                    class="files-pop-stats inline-flex justify-end gap-[calc(0.25rem_*_var(--orb-scale))] [font-size:var(--pop-meta-size)] [font-weight:550] tabular-nums"
                    aria-label={`${stats.additions} additions, ${stats.deletions} deletions`}
                  >
                    <span class="files-pop-add text-(--solus-art-positive)"
                      >+{stats.additions}</span
                    >
                    <span class="files-pop-del text-(--solus-art-negative)"
                      >-{stats.deletions}</span
                    >
                  </span>
                </button>
              {/each}
            </div>
          </Popover.Content>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                class="dock-btn stagger-item"
                data-orb-action="files"
                tabindex={tabIndexFor("files")}
                style="--item-index:{itemIndices.files}"
                title={`Review ${sessionChangedFiles.length} session file${sessionChangedFiles.length !== 1 ? "s" : ""}`}
                aria-label={`Review ${sessionChangedFiles.length} session file${sessionChangedFiles.length !== 1 ? "s" : ""}`}
                use:tooltip={`Review ${sessionChangedFiles.length} session file${sessionChangedFiles.length !== 1 ? "s" : ""}`}
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
        <button
          class="dock-btn stagger-item"
          data-orb-action="terminal"
          tabindex={tabIndexFor("terminal")}
          style="--item-index:{itemIndices.terminal}"
          onclick={handleOpenTerminal}
          disabled={!!remoteHost}
          title={terminalTooltip}
          aria-label="Open session in terminal"
          use:tooltip={terminalTooltip}
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
          title={isCreatingWorktree
            ? "Creating worktree…"
            : "Continue this session in a new worktree"}
          aria-label={isCreatingWorktree
            ? "Creating worktree"
            : "Continue this session in a new worktree"}
          aria-busy={isCreatingWorktree}
          use:tooltip={isCreatingWorktree
            ? "Creating worktree…"
            : "Continue this session in a new worktree"}
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
              onclick={handleReview}
              openOnHover={reviewStatus === "generating"}
              openDelay={0}
              closeDelay={120}
            >
              {#snippet child({ props })}
                <button
                  {...props}
                  class="dock-btn stagger-item"
                  class:dock-btn-reviewing={reviewStatus === "generating"}
                  class:dock-btn-review-done={reviewStatus === "done"}
                  data-orb-action="review"
                  tabindex={tabIndexFor("review")}
                  style="--item-index:{itemIndices.review}"
                  title={reviewLabel}
                  aria-label={reviewLabel}
                  use:tooltip={reviewLabel}
                >
                  <BinocularsIcon size={13} weight="regular" />
                  <span>{reviewLabel}</span>
                </button>
              {/snippet}
            </Popover.Trigger>
          </Popover.Root>
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
          {:else if reviewStatus === "generating"}
            <button
              class="dock-btn dock-btn-icon dock-btn-stop stagger-item"
              style="--item-index:{itemIndices.review}"
              tabindex={expanded ? 0 : -1}
              onclick={handleCancelReview}
              title="Cancel review"
              aria-label="Cancel review"
              use:tooltip={"Cancel review"}
            >
              <SquareIcon size={9} weight="fill" />
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
