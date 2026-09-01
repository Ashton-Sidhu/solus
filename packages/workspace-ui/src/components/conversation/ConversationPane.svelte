<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import AsidePaneShell from "../layout/AsidePaneShell.svelte";
  import ConversationView from "./ConversationView.svelte";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";

  let {
    paneId,
    surfaceVisible = true,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"chat"> = $props();

  const session = getWorkspaceContext();

  // A pinned chat names the session it shows; the tab rendering that session is
  // the workspace's answer, not the route's — the one place that hop happens.
  // The leading pane's chat goes through the pool instead.
  const tabId = $derived(session.chatTabIn(paneId));
  // Only the leading pane renders the pool, so a companion that names no
  // session has no conversation of its own. Borrowing the active tab put the
  // leading pane's conversation on both sides of the split — and gave the close
  // button someone else's tab to close — so the pane is closed instead. Reached
  // by a location saved before a companion always named its session; the router
  // has since dropped the pane when it is only mid-exit, hence the guard.
  $effect(() => {
    if (tabId || !session.router.pane(paneId)) return;
    session.router.closePane(paneId);
  });

  async function attachFile(conversationTabId: string) {
    if (onAttachFile) {
      await onAttachFile(conversationTabId);
      return;
    }
    const files = await session.apiFor(conversationTabId).attachFiles(
      session.ctxFor(conversationTabId),
    );
    if (!files || files.length === 0) return;
    session.addAttachments(files, conversationTabId);
  }

  // The X takes the whole surface away: the conversation's tab and the pane
  // showing it. `closeTab` drops the pane too when the workspace can match the
  // two up, but this pane is the thing the user clicked — it goes either way.
  function closeConversationTab(conversationTabId: string) {
    session.closeTab(conversationTabId);
    session.router.closePane(paneId);
    requestInputFocus();
  }
</script>

{#if tabId}
  {@const conversationTabId = tabId}
  <AsidePaneShell
    {paneId}
    tabId={conversationTabId}
    {surfaceVisible}
    onOpenAsPage={() => session.promoteSplitToMainTab()}
    onClose={() => closeConversationTab(conversationTabId)}
    closeLabel="Close conversation tab"
  >
    {#snippet body()}
      <div class="flex min-h-0 flex-1 flex-col">
        <ConversationView
          tabId={conversationTabId}
          forceVisible
          {surfaceVisible}
        />
      </div>

      <div class="split-input-dock shrink-0 px-4 pt-2.5 pb-2.5">
        <EditorInputCard
          class="mx-auto max-w-(--solus-reading-max)"
          tabId={conversationTabId}
          {paneId}
          onAttachFile={() => attachFile(conversationTabId)}
          onScreenshot={onScreenshot
            ? () => onScreenshot(conversationTabId)
            : null}
          onDesignMode={onDesignMode
            ? () => onDesignMode(conversationTabId)
            : null}
        />
      </div>
    {/snippet}
  </AsidePaneShell>
{/if}
