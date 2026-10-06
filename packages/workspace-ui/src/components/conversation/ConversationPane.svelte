<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import AsidePaneShell from "../layout/AsidePaneShell.svelte";
  import ConversationView from "./ConversationView.svelte";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";

  let {
    params,
    paneId,
    surfaceVisible = true,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"chat"> = $props();

  const session = getWorkspaceContext();

  // A chat surface names the session it shows; the tab rendering that session
  // is the workspace's answer, not the route's. Read off this surface's own
  // params, not the pane's active surface: a chat surface stays mounted while
  // another surface of the strip is showing.
  const tabId = $derived(params.sessionId ? (session.tabIdForSession(params.sessionId) ?? null) : null);
  // A surface whose conversation has no tab has nothing to show, and its close
  // button nothing to let go of, so it closes. The router has already dropped
  // it when it is only mid-exit, hence the guard.
  $effect(() => {
    if (tabId || !session.router.pane(paneId)) return;
    const sessionId = params.sessionId;
    session.router.closeSurfacesWhere((ref) => ref.name === "chat" && ref.params.sessionId === sessionId);
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

  // The X closes this surface only. The conversation keeps its tab, so it
  // stays in the sidebar; a never-used split tab is discarded with it.
  function closeConversationPane() {
    session.closeChatSurface();
    requestInputFocus();
  }
</script>

{#if tabId}
  {@const conversationTabId = tabId}
  <AsidePaneShell
    {paneId}
    tabId={conversationTabId}
    {surfaceVisible}
    onOpenAsPage={() => session.moveChatSurfaceToMain()}
    onClose={closeConversationPane}
    closeLabel="Close conversation pane"
  >
    {#snippet body()}
      <!-- Marks the conversation and its bar as one column, so the session
           action row can hide while this bar is collapsed. -->
      <div class="contents" data-composer-column>
      <div class="flex min-h-0 flex-1 flex-col">
        <ConversationView
          tabId={conversationTabId}
          forceVisible
          {surfaceVisible}
        />
      </div>

      <div class="split-input-dock shrink-0 px-4 pt-2.5 pb-2.5" data-composer-dock>
        <EditorInputCard
          active={surfaceVisible}
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
      </div>
    {/snippet}
  </AsidePaneShell>
{/if}
