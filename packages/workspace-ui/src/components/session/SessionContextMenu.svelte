<script lang="ts">
  import {
    ChartBar as ChartBarIcon,
    Check as CheckIcon,
    GitFork as GitForkIcon,
    GitFork as TreeStructureIcon,
    MessagesSquare as ChatsIcon,
    Copy as CopyIcon,
    Pen as PencilSimpleIcon,
    CircleStop as StopCircleIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";
  import { selectSessionRename } from "./lib/session-context-menu";

  interface Props {
    x: number;
    y: number;
    /** The open tab this menu targets, if any. Session actions (fork, worktree,
     *  split, close) need a live tab; a pinned session that isn't open has none. */
    tabId?: string | null;
    /** Session id to copy when the target has no resolvable session (e.g. a
     *  pinned session that isn't currently open as a tab). */
    sessionId?: string | null;
    /** Editor variant surfaces split-pane actions; pill/sidebar can too. */
    showSplit?: boolean;
    /** Override for "Open in split" — pinned sessions resume before splitting. */
    onOpenInSplit?: () => void;
    /** Override for "Rename" — the sidebar edits its row in place instead of
     *  opening the dialog every other surface uses. */
    onStartRename?: (tabId: string) => void;
    /** What the sidebar's rows moved off themselves and into this menu. Omitted
     *  everywhere else: a pill-mode tab has no user-set "done". */
    rowActions?: {
      /** Present only while something in the row is still working. */
      onStop?: () => void;
      done?: boolean;
      onToggleDone?: () => void;
    } | null;
    /** A sidebar can dismiss its row without closing the mounted tab. Other
     *  surfaces keep the ordinary workspace close behavior. */
    onCloseTab?: (tabId: string) => void;
    closeTabLabel?: string;
    closeTabIsDestructive?: boolean;
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
    rowActions = null,
    onCloseTab,
    closeTabLabel = "Close Tab",
    closeTabIsDestructive = true,
    onClose,
  }: Props = $props();

  const session = getWorkspaceContext();

  const sess = $derived(tabId ? session.sessionFor(tabId) : null);
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
    !!tabId && session.isContinuingInWorktree(tabId),
  );

  async function fork() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) await session.forkTab(targetTabId);
  }

  async function continueWorktree() {
    const targetTabId = tabId;
    onClose();
    if (targetTabId) await session.continueInWorktree(targetTabId);
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
    if (targetSessionId) session.openInsightsForSession(targetSessionId);
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
    else session.closeTab(targetTabId);
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    <!-- Stopping a run and ticking a task off are the two things the sidebar's
         rows used to spend a button on each. They live here now: one is
         destructive, the other is the user's own verdict, and neither is worth
         four glyphs appearing under the cursor. -->
    {#if rowActions?.onStop}
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
    {#if rowActions?.onToggleDone}
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
    {#if rowActions?.onStop || rowActions?.onToggleDone}
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
    {#if tabId}
      <ContextMenu.Item onSelect={startRename}>
        <PencilSimpleIcon />
        Rename
      </ContextMenu.Item>
    {/if}
    {#if copyableSessionId}
      <ContextMenu.Item onSelect={copySessionId}>
        <CopyIcon />
        Copy Session ID
      </ContextMenu.Item>
    {/if}
    {#if canOpenInsights}
      <ContextMenu.Item onSelect={openInInsights}>
        <ChartBarIcon />
        Open in Insights
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
