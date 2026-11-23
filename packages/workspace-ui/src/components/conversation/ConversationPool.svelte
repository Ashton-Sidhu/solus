<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext } from "../../contexts";
  import LazyConversationView from "./LazyConversationView.svelte";
  import { conversationViewStates } from "./lib/conversation-view-state.svelte";
  import { mountedConversationTabIds } from "./lib/conversation-pool";

  /**
   * The conversations of the open tabs, one on screen and the few most recent
   * mounted but hidden, so moving between them is instant. An older one
   * unmounts and releases its older history; its view state brings back what
   * the reader left open and where.
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
  let presentedTabId = $state<string | null>(null);
  const retainedTabId = $derived.by(() => {
    if (!surfaceVisible || !presentedTabId || presentedTabId === session.activeTabId) return null;
    const presented = session.sessionFor(presentedTabId);
    const incoming = session.sessionFor(session.activeTabId);
    return presented && incoming && presented.organizationId === incoming.organizationId
      ? presentedTabId
      : null;
  });

  function present(tabId: string) {
    if (surfaceVisible && tabId === session.activeTabId) presentedTabId = tabId;
  }

  $effect(() => {
    if (!surfaceVisible || (presentedTabId && !session.tabs[presentedTabId])) presentedTabId = null;
  });

  $effect(() => {
    if (!retainedTabId) return;
    // Let the incoming view show its loading state if the host takes longer
    // than a normal switch.
    const timeout = setTimeout(() => { presentedTabId = null; }, 800);
    return () => clearTimeout(timeout);
  });

  $effect(() => {
    const openTabIds = session.tabOrder.filter((tabId) => !!session.tabs[tabId]);
    const activeTabId = session.activeTabId && session.tabs[session.activeTabId] ? session.activeTabId : null;
    const previous = untrack(() => mountedTabIds);
    const retained = retainedTabId;
    const recent = retained ? [retained, ...previous] : previous;
    const next = mountedConversationTabIds(recent, activeTabId, openTabIds, active, surfaceVisible);
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

<div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
  {#each session.tabOrder as tabId (tabId)}
    {#if mountedTabIds.includes(tabId)}
      {@const isActiveTab = tabId === session.activeTabId}
      {@const isPreparing = isActiveTab && retainedTabId !== null}
      <!-- The incoming transcript needs the full pane size to restore its
           scroll position. Keep the outgoing one in that same grid cell until
           the incoming one can paint. Only the active view can take input. -->
      <div
        class="tab-slot col-start-1 row-start-1 flex h-full min-h-0 flex-col [contain-intrinsic-size:auto_62.5rem] [content-visibility:auto]"
        class:tab-hidden={!isActiveTab && tabId !== retainedTabId}
        class:opacity-0={isPreparing}
        inert={!isActiveTab || isPreparing}
      >
        <LazyConversationView
          {tabId}
          surfaceVisible={surfaceVisible && isActiveTab}
          {showActions}
          {bandAbove}
          keepTranscriptVisible={tabId === presentedTabId}
          onReady={() => present(tabId)}
          viewState={viewStates.forTab(tabId)}
        />
      </div>
    {/if}
  {/each}
</div>

<style>
  .tab-hidden {
    display: none !important;
  }
</style>
