<script lang="ts">
  import {
    ChartBar as ChartBarIcon,
    Files as FilesIcon,
    RefreshCw as RefreshIcon,
    GitFork as GitForkIcon,
    GitBranchPlus as WorktreeIcon,
    Square as SquareIcon,
    Star as StarIcon,
    SquareTerminal as TerminalIcon,
    Binoculars as BinocularsIcon,
  } from "@lucide/svelte";
  import {
    getSettingsContext,
    getWorkspaceContext,
    getSessionSidebarStore,
    getClientShellContext,
    getSessionEnvironmentStore,
    serversStore,
    toolsStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    reviewGuideStore,
    sessionGuideIdentity,
  } from "../review/review-guide.store.svelte";
  import { Button } from "../ui/button";
  import Kbd from "../ui/Kbd.svelte";
  import * as Popover from "../ui/popover";
  import SessionProgressButton from "./SessionProgressButton.svelte";
  import SessionActionList from "./SessionActionList.svelte";
  import DiffSummaryCard from "../conversation/DiffSummaryCard.svelte";
  import type { SessionAction } from "./lib/session-actions";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import "./SessionActionRow.css";

  let {
    tabId,
    leftReservedWidth = 0,
  }: {
    tabId: string;
    leftReservedWidth?: number;
  } = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const sidebarStore = getSessionSidebarStore();
  const theme = getSettingsContext();
  const shell = getClientShellContext();
  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  const gitCwd = $derived(
    sess?.run.gitContext?.worktreePath ?? sess?.run.workingDirectory,
  );
  const hasUncommittedChanges = $derived(
    (environmentStore.statusFor(sess?.run.serverId ?? session.fallbackServerId, gitCwd)
      ?.uncommittedChanges.files.length ?? 0) > 0,
  );
  const showNativeDesktopActions = $derived(shell.supportsNativeSettings);
  const hasSessionChanges = $derived(sessionChangedFiles.length > 0);
  // This action reviews one agent session. Never fall back to the branch key:
  // the environment panel owns branch reports, and those must not make this
  // session's suggestion read as ready.
  const sessionReviewIdentity = $derived(sessionGuideIdentity(sess));
  // Read only: `trackSessionReviewGuides` probes the host once per session,
  // so a row never issues a request of its own.
  const sharedReviewStatus = $derived(
    reviewGuideStore.statusFor(session.serverIdFor(tabId), sessionReviewIdentity),
  );
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const showReview = $derived(hasSessionChanges && !!sess?.agentSessionId);
  const isCreatingWorktree = $derived(session.ui.isContinuingInWorktree(tabId));
  // The repository can have unrelated uncommitted files. Do not mount an empty
  // session popover only because that broader repository count is non-zero.
  const showOpenFiles = $derived(
    showNativeDesktopActions && hasUncommittedChanges && hasSessionChanges,
  );
  const remoteHost = $derived.by(() => {
    if (hostPolicy.isClientMachine(sess?.run.serverId)) return null;
    return serversStore.hostFor(sess?.run.serverId) ?? null;
  });
  // Names the terminal that will actually open — the one already attached to
  // the shared tmux session, or the Settings fallback when none is.
  const terminalLabel = $derived(
    remoteHost
      ? `Terminal is not available for sessions on ${remoteHost.label}`
      : toolsStore.resolvedTerminal
        ? `Open session in ${toolsStore.resolvedTerminal.name}`
        : "Open session in terminal",
  );
  const hasAgentSession = $derived(!!sess?.agentSessionId);
  // Forking mid-turn is allowed: the fork branches from the source's last
  // settled turn rather than the one still being written.
  const showContinueWorktree = $derived(
    hasAgentSession && !isRunning && !sess?.run.gitContext?.worktreePath,
  );
  const isPinned = $derived(
    sidebarStore.isPinned(sess?.id, sess?.run.serverId),
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
  const reviewLabel = $derived(
    reviewStatus === "done"
      ? "Open review"
      : reviewStatus === "generating"
        ? "Reviewing…"
        : `Review ${sessionChangedFiles.length} file${sessionChangedFiles.length !== 1 ? "s" : ""}`,
  );
  let lastReviewFailureAt = 0;

  $effect(() => {
    const status = sharedReviewStatus;
    if (!status) return;
    if (status.status === "failed" && status.updatedAt !== lastReviewFailureAt) {
      lastReviewFailureAt = status.updatedAt;
      toasts.error(
        status.error
          ? `Review stopped: ${status.error}`
          : "Review stopped before a guide was produced. Try again.",
      );
    }
  });

  // ── Plan progress ──
  const progress = $derived(sess?.progress ?? null);
  const hasProgress = $derived(!!progress && progress.totalSteps > 0);
  const progressAllDone = $derived(
    !!progress && progress.todos.every((t) => t.status === "completed"),
  );
  const progressFraction = $derived.by(() => {
    if (!progress || progress.totalSteps === 0) return 0;
    const done = progress.todos.filter((t) => t.status === "completed").length;
    const active = progress.todos.some((t) => t.status === "in_progress") ? 0.5 : 0;
    return Math.min(1, (done + active) / progress.totalSteps);
  });
  const progressHeader = $derived.by<string | null>(() => {
    if (!progress || progress.totalSteps === 0) return null;
    const active = progress.todos.find((t) => t.status === "in_progress");
    if (active) return active.content;
    if (progressAllDone) return "All steps complete";
    return progress.todos.find((t) => t.status === "pending")?.content ?? null;
  });
  let stepsOpen = $state(false);
  let reviewFilesOpen = $state(false);
  let isActionListOpen = $state(false);
  // The row's left edge while the pointer or focus is in it; null when the
  // row rests centred.
  let pinnedRowLeft = $state<number | null>(null);
  let actionRowEl: HTMLDivElement | null = $state(null);

  function pinRowLeft() {
    if (pinnedRowLeft !== null || !actionRowEl || !rootEl) return;
    pinnedRowLeft =
      actionRowEl.getBoundingClientRect().left - rootEl.getBoundingClientRect().left;
  }

  function releaseRowLeft(isFocusLeaving: boolean) {
    if (!actionRowEl) return;
    if (!isFocusLeaving && actionRowEl.contains(document.activeElement)) return;
    if (isFocusLeaving && actionRowEl.matches(":hover")) return;
    pinnedRowLeft = null;
  }
  let rootEl: HTMLDivElement | null = $state(null);
  // The changed-files popover anchors to its row icon by id.
  const rowId = $props.id();
  const filesAnchorId = `${rowId}-files`;

  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (tabId !== session.focusedChatTabId || !showOpenFiles) return;
      reviewFilesOpen = true;
    };
    window.addEventListener("solus:review-changed-files", handler);
    return () => window.removeEventListener("solus:review-changed-files", handler);
  });

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
    session.openInsightsSession(sessionId, "click", "companion");
  }

  function handleTogglePin() {
    if (!hasAgentSession) return;
    void sidebarStore.togglePinnedSession(tabId);
    requestInputFocus();
  }

  function handleFork() {
    session.opening.forkTab(tabId);
    requestInputFocus();
  }

  function handleContinueWorktree(source?: "keybinding") {
    if (isCreatingWorktree) return;
    session.opening.continueInWorktree(tabId, source);
    requestInputFocus();
  }

  async function handleReview(regenerate = false) {
    // One click, always: open the review pane on its diff, and queue the
    // generation behind it when there is nothing to read yet. Generation is
    // durable, so the pane reports its progress rather than the click ending in
    // a panel the reader still has to go and find.
    if (!regenerate) {
      session.enterReview("session", tabId);
      if (reviewStatus === "done") return;
    }
    if (reviewStatus === "generating") return;
    const identity = sessionReviewIdentity;
    if (!identity) return;
    try {
      await reviewGuideStore.generate(
        session.apiFor(tabId),
        session.serverIdFor(tabId),
        session.ctxFor(tabId),
        identity,
        { ...resolveReviewAgent(theme), scope: "session" },
      );
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
    void reviewGuideStore.cancel(session.apiFor(tabId), session.ctxFor(tabId), "session");
    requestInputFocus();
  }

  // Row order.
  const rowActions = $derived.by((): SessionAction[] => {
    const actions: SessionAction[] = [];
    if (hasAgentSession) {
      actions.push({
        id: "pin",
        label: isPinned ? "Unpin session" : "Pin session to sidebar",
        icon: StarIcon,
        shortcut: comboHint("orb.pin"),
        run: handleTogglePin,
      });
    }
    if (showOpenFiles) {
      actions.push({
        id: "files",
        label: `Show ${sessionChangedFiles.length} changed file${sessionChangedFiles.length !== 1 ? "s" : ""}`,
        icon: FilesIcon,
        shortcut: comboHint("conversation.open-files"),
        run: () => (reviewFilesOpen = true),
      });
    }
    if (showNativeDesktopActions) {
      actions.push({
        id: "terminal",
        label: terminalLabel,
        icon: TerminalIcon,
        shortcut: comboHint("orb.open-terminal"),
        isDisabled: !!remoteHost,
        run: handleOpenTerminal,
      });
    }
    if (hasAgentSession) {
      actions.push({
        id: "fork",
        label: "Fork session into a new tab",
        icon: GitForkIcon,
        shortcut: comboHint("global.fork-tab"),
        run: handleFork,
      });
    }
    if (showContinueWorktree) {
      actions.push({
        id: "worktree",
        label: isCreatingWorktree ? "Creating worktree…" : "Continue in a new worktree",
        icon: WorktreeIcon,
        shortcut: comboHint("global.continue-worktree"),
        isDisabled: isCreatingWorktree,
        run: () => handleContinueWorktree(),
      });
    }
    if (hasAgentSession) {
      actions.push({
        id: "insights",
        label: "Open session in insights",
        icon: ChartBarIcon,
        shortcut: "",
        run: openSessionInsights,
      });
    }
    if (showReview) {
      actions.push({
        id: "review",
        label: reviewLabel,
        icon: BinocularsIcon,
        shortcut: "",
        run: () => void handleReview(),
      });
    }
    return actions;
  });

  // The action list adds the review's own follow-ups to the row's actions.
  const listActions = $derived.by((): SessionAction[] => {
    if (!showReview) return rowActions;
    if (reviewStatus === "done") {
      return [...rowActions, { id: "review-regenerate", label: "Regenerate review", icon: RefreshIcon, shortcut: "", run: () => void handleReview(true) }];
    }
    if (reviewStatus === "generating") {
      return [...rowActions, { id: "review-cancel", label: "Cancel review", icon: SquareIcon, shortcut: "", run: handleCancelReview }];
    }
    return rowActions;
  });

  function openActionList() {
    stepsOpen = false;
    reviewFilesOpen = false;
    isActionListOpen = true;
  }

  function closeActionList() {
    isActionListOpen = false;
    requestInputFocus();
  }

  function isVisibleRow() {
    return !!rootEl && !rootEl.closest(".mode-hidden");
  }

  useKeybinding(
    "global.fork-tab",
    () => {
      if (hasAgentSession) handleFork();
    },
    { enabled: () => tabId === session.focusedChatTabId && isVisibleRow() },
  );
  useKeybinding("global.continue-worktree", () => handleContinueWorktree("keybinding"), {
    enabled: () =>
      tabId === session.focusedChatTabId &&
      isVisibleRow() &&
      showContinueWorktree &&
      !isCreatingWorktree,
  });
  useKeybinding(
    "orb.toggle",
    () => (isActionListOpen ? closeActionList() : openActionList()),
    { enabled: () => tabId === session.focusedChatTabId && isVisibleRow() },
  );
  useKeybinding("orb.open-terminal", () => handleOpenTerminal(), {
    enabled: () =>
      tabId === session.focusedChatTabId && shell.supportsNativeSettings && isVisibleRow(),
  });
  useKeybinding("orb.pin", () => handleTogglePin(), {
    enabled: () => tabId === session.focusedChatTabId && hasAgentSession && isVisibleRow(),
  });
</script>

<!-- The row belongs to the bar, not to the transcript, so it rides on the
     bar's live top edge and travels with a fold on the fold's own curve
     (ADR-0027). The root spans the reading column; the row starts at its left
     edge, clear of the activity strip. -->
<div
  bind:this={rootEl}
  class="session-action-root pointer-events-none absolute inset-x-0 top-0 bottom-[var(--solus-composer-height,0px)] z-[6] mx-auto [contain:layout]"
>
  {#if isActionListOpen}
    <div class="pointer-events-auto absolute inset-x-0 bottom-1.5">
      <SessionActionList actions={listActions} onClose={closeActionList} />
    </div>
  {:else}
    <!-- Centred at rest. While the pointer or focus is in the row, its left
         edge is pinned where it was, so a label that opens only pushes the
         icons to its right and the icon the pointer is on never moves. -->
    <!-- The handlers only pin the row while it is in use; every control inside
         is its own focusable button. -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      bind:this={actionRowEl}
      class="pointer-events-auto absolute bottom-1.5 flex items-center gap-1 whitespace-nowrap text-workspace-chrome text-(--solus-text-tertiary)"
      style:left={pinnedRowLeft === null ? "50%" : `${pinnedRowLeft}px`}
      style:translate={pinnedRowLeft === null ? "-50% 0" : "none"}
      style:max-width="calc(100% - {leftReservedWidth * 2}px - 1rem)"
      role="toolbar"
      aria-label="Session actions"
      onpointerenter={pinRowLeft}
      onpointerleave={() => releaseRowLeft(false)}
      onfocusin={pinRowLeft}
      onfocusout={(event: FocusEvent) => {
        if (!actionRowEl?.contains(event.relatedTarget as Node | null)) releaseRowLeft(true);
      }}
    >

      {#if hasProgress}
        <SessionProgressButton
          progress={progress!}
          {isRunning}
          {progressAllDone}
          {progressFraction}
          {progressHeader}
          bind:stepsOpen
        />
      {/if}

      {#each rowActions as action (action.id)}
        {@render actionButton(action)}
      {/each}
      {#if showOpenFiles}
        <Popover.Root
          bind:open={reviewFilesOpen}
          onOpenChange={(open) => {
            if (!open) requestInputFocus();
          }}
        >
          <Popover.Content
            class="files-pop progress-popover p-0"
            customAnchor="#{filesAnchorId}"
            side="top"
            sideOffset={11}
            role="dialog"
            aria-label="Changed files"
          >
            <DiffSummaryCard
              {tabId}
              changedFiles={sessionChangedFiles}
              onOpenDiff={(filePath) => {
                session.showDiff(tabId, { kind: "session" }, filePath);
                reviewFilesOpen = false;
              }}
              onOpenFile={(filePath) => {
                session.openFileInFiles({ path: filePath }, tabId);
                reviewFilesOpen = false;
              }}
              embedded
            />
          </Popover.Content>
        </Popover.Root>
      {/if}
    </div>
  {/if}
</div>

{#snippet actionButton(action: SessionAction)}
  <!-- Flat and quiet at rest: an icon in the chrome colour. Pointing at it or
       tabbing to it opens it into a pill with its label and shortcut. The
       invisible ::after box widens the hit area to 44px tall and across the
       gap to each neighbour, without changing how the button looks. -->
  <Button
    id={action.id === "files" ? filesAnchorId : undefined}
    variant="ghost"
    size="sm"
    class="h-7 gap-0 rounded-full px-1.5 relative after:absolute after:-inset-x-0.5 after:-inset-y-2 after:content-[''] text-workspace-chrome font-normal text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) aria-pressed:text-(--solus-accent)"
    onclick={action.run}
    aria-haspopup={action.id === "files" ? "dialog" : undefined}
    aria-expanded={action.id === "files" ? reviewFilesOpen : undefined}
    disabled={action.isDisabled}
    data-session-action={action.id}
    aria-label={action.label}
    aria-pressed={action.id === "pin" ? isPinned : undefined}
  >
    <action.icon size={16} />
    <span
      class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity,margin] duration-200 ease-out group-hover/button:ml-1.5 group-hover/button:max-w-60 group-hover/button:opacity-100 group-focus-visible/button:ml-1.5 group-focus-visible/button:max-w-60 group-focus-visible/button:opacity-100 pointer-coarse:hidden motion-reduce:transition-none"
    >
      {action.label}
      {#if action.shortcut}
        <Kbd variant="inline" class="ml-1 opacity-50">{action.shortcut}</Kbd>
      {/if}
    </span>
  </Button>
{/snippet}
