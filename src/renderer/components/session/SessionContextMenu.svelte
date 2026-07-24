<script lang="ts">
  import {
    GitForkIcon,
    TreeStructureIcon,
    ColumnsIcon,
    CopyIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, toasts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";

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
    onClose: () => void;
  }

  let {
    x,
    y,
    tabId = null,
    sessionId = null,
    showSplit = false,
    onOpenInSplit,
    onClose,
  }: Props = $props();

  const session = getWorkspaceContext();

  const sess = $derived(tabId ? session.sessionFor(tabId) : null);
  const copyableSessionId = $derived(sess?.agentSessionId ?? sessionId ?? null);
  const splitTabId = $derived(
    session.panes.chatTabIn("secondary", session.activeTabId),
  );
  const isSplit = $derived(!!tabId && tabId === splitTabId);
  const canSplit = $derived(showSplit && (!!tabId || !!onOpenInSplit));
  const isContinuingWorktree = $derived(
    !!tabId && session.isContinuingInWorktree(tabId),
  );

  async function fork() {
    onClose();
    if (tabId) await session.forkTab(tabId);
  }

  async function continueWorktree() {
    onClose();
    if (tabId) await session.continueInWorktree(tabId);
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

  function openInSplit() {
    onClose();
    if (onOpenInSplit) onOpenInSplit();
    else if (tabId) session.openTabInSplit(tabId);
  }

  function closeSplit() {
    onClose();
    session.closeSplitChat();
    requestInputFocus();
  }

  function closeTab() {
    onClose();
    if (tabId) session.closeTab(tabId);
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    {#if sess?.agentSessionId}
      <ContextMenu.Item onSelect={fork}>
        <GitForkIcon />
        Fork Session
        <ContextMenu.Shortcut>⌥F</ContextMenu.Shortcut>
      </ContextMenu.Item>
      {#if !sess?.gitContext?.worktreePath}
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
    {#if copyableSessionId}
      <ContextMenu.Item onSelect={copySessionId}>
        <CopyIcon />
        Copy Session ID
      </ContextMenu.Item>
    {/if}
    {#if canSplit}
      {#if isSplit}
        <ContextMenu.Item onSelect={closeSplit}>
          <ColumnsIcon />
          Close Split
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onSelect={openInSplit}>
          <ColumnsIcon />
          Open in Split
        </ContextMenu.Item>
      {/if}
    {/if}
    {#if tabId}
      <ContextMenu.Item variant="destructive" onSelect={closeTab}>
        <XIcon />
        Close Tab
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
