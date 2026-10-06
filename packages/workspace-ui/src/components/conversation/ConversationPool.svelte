<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext } from "../../contexts";
  import ConversationView from "./ConversationView.svelte";
  import { conversationViewStates } from "./lib/conversation-view-state.svelte";
  import { mountedConversationTabIds } from "./lib/conversation-pool";

  /**
   * The conversations of the open tabs, one on screen and the few most recent
   * mounted but hidden, so moving between them is instant. An older one
   * unmounts and releases its older history; its view state brings back what
   * the reader left open and where. Desktop, web, and phone all use this pool.
   */
  let {
    active,
    surfaceVisible = active,
    showActions = true,
    bandAbove = true,
  }: {
    /** This pool's shell is the one on screen. An inactive pool mounts nothing. */
    active: boolean;
    surfaceVisible?: boolean;
    showActions?: boolean;
    bandAbove?: boolean;
  } = $props();

  const session = getWorkspaceContext();
  const viewStates = conversationViewStates(session);

  let mountedTabIds = $state<string[]>([]);
  $effect(() => {
    const openTabIds = session.tabOrder.filter((tabId) => !!session.tabs[tabId]);
    const activeTabId = session.activeTabId && session.tabs[session.activeTabId] ? session.activeTabId : null;
    const previous = untrack(() => mountedTabIds);
    const next = mountedConversationTabIds(previous, activeTabId, openTabIds, active);
    if (next.length === previous.length && next.every((tabId, index) => tabId === previous[index])) return;
    mountedTabIds = next;
    untrack(() => {
      // A conversation still on screen in the split pane keeps its history.
      const splitSession = session.chatSurfaceTabId ? session.sessionFor(session.chatSurfaceTabId) : undefined;
      for (const tabId of previous) {
        if (next.includes(tabId) || !session.tabs[tabId]) continue;
        if (splitSession && session.sessionFor(tabId) === splitSession) continue;
        session.lifecycle.releaseOlderHistory(tabId);
      }
    });
  });
</script>

{#each session.tabOrder as tabId (tabId)}
  {#if mountedTabIds.includes(tabId)}
    <div
      class="tab-slot flex h-full min-h-0 flex-col [contain-intrinsic-size:auto_62.5rem] [content-visibility:auto]"
      class:tab-hidden={tabId !== session.activeTabId}
    >
      <ConversationView
        {tabId}
        {surfaceVisible}
        {showActions}
        {bandAbove}
        viewState={viewStates.forTab(tabId)}
      />
    </div>
  {/if}
{/each}

<style>
  .tab-hidden {
    display: none !important;
  }
</style>
