<script lang="ts">
  import TaskIcon from "../ui/TaskIcon.svelte";
  import {
    ChartBar as ChartBarIcon,
    Check as CheckIcon,
    GitFork as GitForkIcon,
    GitFork as TreeStructureIcon,
    MessagesSquare as ChatsIcon,
    Copy as CopyIcon,
    GitPullRequest as GitPullRequestIcon,
    Link as LinkIcon,
    Moon as MoonIcon,
    Unlink as UnlinkIcon,
    Pen as PencilSimpleIcon,
    RefreshCw as ArrowsClockwiseIcon,
    CircleStop as StopCircleIcon,
    Share as ShareIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getSessionSidebarStore, getWorkspaceContext, accountStore, sharesStore } from "../../contexts";
  import { sessionTitle } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";
  import { selectSessionRename } from "./lib/session-context-menu";
  import { askInsights } from "../insights/lib/ask-insights";
  import { taskOfTab, unlinkTabFromTask } from "../../contexts/workspace/session-task-link";
  import { canDriveSession } from "../../contexts/sharing/session-drive";

  interface Props {
    x: number;
    y: number;
    /** The open tab this menu targets, if any. Session actions (fork, worktree,
     *  split, close) need a live tab; a pinned session that isn't open has none. */
    tabId?: string | null;
    /** Session id to copy when the target has no resolvable session (e.g. a
     *  pinned session that isn't currently open as a tab). */
    sessionId?: string | null;
    /** The workspace variant surfaces split-pane actions; the sidebar can too. */
    showSplit?: boolean;
    /** Override for "Open in split" — pinned sessions resume before splitting. */
    onOpenInSplit?: () => void;
    /** Override for "Rename" — the sidebar edits its row in place instead of
     *  opening the dialog every other surface uses. */
    onStartRename?: (tabId: string) => void;
    /** Closed pinned sessions regenerate through their owning sidebar store. */
    onRegenerateTitle?: () => Promise<void> | void;
    /** What the sidebar's rows moved off themselves and into this menu. Omitted
     *  everywhere else: a compact tab has no user-set "done". */
    rowActions?: {
      /** Present only while something in the row is still working. */
      onStop?: () => void;
      done?: boolean;
      onToggleDone?: () => void;
      /** Opens the snooze prompt for the row. Absent on a snoozed row. */
      onSnooze?: () => void;
    } | null;
    /** A sidebar can dismiss its row without closing the mounted tab. Other
     *  surfaces keep the ordinary workspace close behavior. */
    onCloseTab?: (tabId: string) => void;
    closeTabLabel?: string;
    closeTabIsDestructive?: boolean;
    /** Where the menu portals to. Overlay callers must keep the menu in their
     *  own layer so it paints above the surface that opened it. */
    portalTarget?: HTMLElement | null;
    onClose: () => void;
  }

  let {
    x,
    y,
    tabId = null,
    sessionId = null,
    showSplit = false,
    onOpenInSplit,
    onStartRename,
    onRegenerateTitle,
    rowActions = null,
    onCloseTab,
    closeTabLabel = "Close Tab",
    closeTabIsDestructive = true,
    portalTarget,
    onClose,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

  const sess = $derived(tabId ? session.sessionFor(tabId) : null);
  // A member who may only read a shared session gets the menu's reading
  // actions; stopping, renaming, linking, settling, and snoozing are an editor's.
  const canDrive = $derived(canDriveSession(tabId ? session.serverIdFor(tabId) : null, sess?.id));
  const copyableSessionId = $derived(sess?.agentSessionId ?? sessionId ?? null);
  /** Telemetry is keyed by Solus's own session id, not the provider thread's,
   *  so an open session answers from its tab and a closed one from the id the
   *  surface listed it under. */
  const insightsSessionId = $derived(sess?.id ?? sessionId ?? null);
  /** A session that never reached the provider has no turns to show. */
  const canOpenInsights = $derived(
    !!insightsSessionId && (!!sess?.agentSessionId || !!sessionId),
  );
  const splitTabId = $derived(session.splitChatTabId);
  const isSplit = $derived(!!tabId && tabId === splitTabId);
  const canSplit = $derived(showSplit && (!!tabId || !!onOpenInSplit));
  const isContinuingWorktree = $derived(
    !!tabId && session.ui.isContinuingInWorktree(tabId),
  );

  async function fork() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) await session.opening.forkTab(targetTabId);
  }

  async function continueWorktree() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) await session.opening.continueInWorktree(targetTabId);
  }

  async function copySessionId() {
    // Read the id before onClose() unmounts this component and tears down the
    // derived it comes from.
    const id = copyableSessionId;
    onClose();
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        // navigator.clipboard is unavailable on non-secure origins (e.g. the web
        // client served over plain http on a LAN). Fall back to execCommand.
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toasts.success("Session ID copied");
    } catch {
      toasts.error("Couldn't copy session ID");
    }
    requestInputFocus();
  }

  function startRename() {
    selectSessionRename({
      tabId,
      onStartRename,
      onDefaultRename: (targetTabId) => {
        session.ui.sessionRename = { tabId: targetTabId };
      },
      onClose,
    });
  }

  async function regenerateTitle() {
    const targetTabId = tabId;
    const regenerateClosedSession = onRegenerateTitle;
    onClose();
    const progress = toasts.progress("Regenerating session title…");
    try {
      if (regenerateClosedSession) await regenerateClosedSession();
      else if (targetTabId) await session.metadata.regenerateTabTitle(targetTabId);
      else {
        progress.dismiss();
        return;
      }
      progress.success("Session title regenerated");
    } catch (error) {
      progress.error(error instanceof Error ? error.message : "Couldn't regenerate session title");
    }
    requestInputFocus();
  }

  function openInSplit() {
    const targetTabId = tabId;
    const openTargetInSplit = onOpenInSplit;
    onClose();
    if (openTargetInSplit) openTargetInSplit();
    else if (targetTabId) session.openTabInSplit(targetTabId);
  }

  function openInInsights() {
    const targetSessionId = insightsSessionId;
    onClose();
    if (targetSessionId) void askInsights({ kind: "session", sessionId: targetSessionId }, () => session.openInsights());
  }

  function closeSplit() {
    onClose();
    session.closeSplitChat();
    requestInputFocus();
  }

  function closeTab() {
    const targetTabId = tabId;
    onClose();
    if (!targetTabId) return;
    if (onCloseTab) onCloseTab(targetTabId);
    else sidebarStore.closeTabs([targetTabId]);
  }

  /** The task this session belongs to, or will join at its first prompt. */
  const linkedTask = $derived(tabId ? taskOfTab(session, tabId) : null);

  function linkToTask() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) session.ui.linkPrompt = { kind: "session-task", tabId: targetTabId };
  }

  function openTask() {
    const task = linkedTask;
    onClose();
    if (!task) return;
    session.goToTask(task.id, "click", session.hasCompanionPanes ? "secondary" : "leading");
  }

  async function unlinkFromTask() {
    const targetTabId = tabId;
    onClose();
    if (!targetTabId) return;
    try {
      await unlinkTabFromTask(session, targetTabId);
    } catch (error) {
      toasts.error("Couldn't unlink the session from the task", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    requestInputFocus();
  }

  function linkPullRequest() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) session.ui.linkPrompt = { kind: "session-pull-request", tabId: targetTabId };
  }

  /** Sharing needs the session's host, which only an open tab names, and that host linked to Solus cloud. */
  const hasSession = $derived(!!tabId && !!sess?.id);
  // Live sharing needs the host linked: the item stays, disabled, and says so (docs/plans/cloud-sharing.md §6).
  const canShare = $derived(hasSession && sharesStore.canShareFrom(session.serverIdFor(tabId!), "session"));

  function share() {
    const targetTabId = tabId;
    const current = sess;
    onClose();
    if (!targetTabId || !current?.id) return;
    sharesStore.open({
      serverId: session.serverIdFor(targetTabId),
      resource: { kind: "session", id: current.id },
      title: sessionTitle(current),
    });
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content
    class="min-w-44"
    portalProps={portalTarget ? { to: portalTarget } : undefined}
  >
    {#if copyableSessionId}
      <ContextMenu.Item onSelect={copySessionId}>
        <CopyIcon />
        Copy Session ID
      </ContextMenu.Item>
      <ContextMenu.Separator />
    {/if}
    <!-- Stopping a run and ticking a task off are the two things the sidebar's
         rows used to spend a button on each. They live here now: one is
         destructive, the other is the user's own verdict, and neither is worth
         four glyphs appearing under the cursor. -->
    {#if canDrive && rowActions?.onStop}
      <ContextMenu.Item
        onSelect={() => {
          onClose();
          rowActions?.onStop?.();
        }}
      >
        <StopCircleIcon />
        Stop Run
      </ContextMenu.Item>
    {/if}
    {#if canDrive && rowActions?.onToggleDone}
      <ContextMenu.Item
        onSelect={() => {
          onClose();
          rowActions?.onToggleDone?.();
        }}
      >
        <CheckIcon />
        {rowActions.done ? "Mark Not Done" : "Mark Done"}
      </ContextMenu.Item>
    {/if}
    {#if canDrive && rowActions?.onSnooze}
      <ContextMenu.Item
        onSelect={() => {
          onClose();
          rowActions?.onSnooze?.();
        }}
      >
        <MoonIcon />
        Snooze…
      </ContextMenu.Item>
    {/if}
    {#if canDrive && (rowActions?.onStop || rowActions?.onToggleDone || rowActions?.onSnooze)}
      <ContextMenu.Separator />
    {/if}
    {#if sess?.agentSessionId}
      <ContextMenu.Item onSelect={fork}>
        <GitForkIcon />
        Fork Session
        <ContextMenu.Shortcut>⌥F</ContextMenu.Shortcut>
      </ContextMenu.Item>
      {#if !sess?.run.gitContext?.worktreePath}
        <ContextMenu.Item disabled={isContinuingWorktree} onSelect={continueWorktree}>
          <TreeStructureIcon class={isContinuingWorktree ? "tab-status-spin" : ""} />
          {isContinuingWorktree ? "Creating Worktree…" : "Continue in Worktree"}
          {#if !isContinuingWorktree}
            <ContextMenu.Shortcut>⌥W</ContextMenu.Shortcut>
          {/if}
        </ContextMenu.Item>
      {/if}
      <ContextMenu.Separator />
    {/if}
    <!-- What the session belongs to. A session joins a task, and owns the pull
         requests it works on (docs/plans/session-pull-requests.md). -->
    {#if tabId && (canDrive || linkedTask)}
      {#if linkedTask}
        <ContextMenu.Item onSelect={openTask}>
          <TaskIcon />
          Open Task
        </ContextMenu.Item>
        {#if canDrive}
          <ContextMenu.Item onSelect={() => void unlinkFromTask()}>
            <UnlinkIcon />
            Unlink from Task
          </ContextMenu.Item>
        {/if}
      {:else}
        <ContextMenu.Item onSelect={linkToTask}>
          <LinkIcon />
          Link to Task…
        </ContextMenu.Item>
      {/if}
      {#if canDrive && sess?.agentSessionId}
        <ContextMenu.Item onSelect={linkPullRequest}>
          <GitPullRequestIcon />
          Link Pull Request…
        </ContextMenu.Item>
      {/if}
      <ContextMenu.Separator />
    {/if}
    {#if tabId && canDrive}
      <ContextMenu.Item onSelect={startRename}>
        <PencilSimpleIcon />
        Rename
      </ContextMenu.Item>
    {/if}
    {#if canDrive && (tabId || onRegenerateTitle)}
      <ContextMenu.Item onSelect={regenerateTitle}>
        <ArrowsClockwiseIcon />
        Regenerate title
      </ContextMenu.Item>
    {/if}
    {#if canOpenInsights}
      <ContextMenu.Item onSelect={openInInsights}>
        <ChartBarIcon />
        Open in Insights
      </ContextMenu.Item>
    {/if}
    {#if hasSession}
      <ContextMenu.Item onSelect={share} disabled={!accountStore.isSignedIn || !canShare} title={!accountStore.isSignedIn ? "Sign in to share" : canShare ? undefined : "Live sharing needs this computer linked"}>
        <ShareIcon />
        Share…
        <ContextMenu.Shortcut>⌥⇧.</ContextMenu.Shortcut>
      </ContextMenu.Item>
    {/if}
    {#if canSplit}
      {#if isSplit}
        <ContextMenu.Item onSelect={closeSplit}>
          <ChatsIcon />
          Close Split
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onSelect={openInSplit}>
          <ChatsIcon />
          Open in Split
        </ContextMenu.Item>
      {/if}
    {/if}
    {#if tabId}
      <ContextMenu.Item
        variant={closeTabIsDestructive ? "destructive" : "default"}
        onSelect={closeTab}
      >
        <XIcon />
        {closeTabLabel}
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
