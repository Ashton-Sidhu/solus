<script lang="ts">
  import type { ResourceWatch } from "@solus/contracts/integrations/resource-watch";
  import { resourceWatchItem, RESOURCE_WATCH_STOP, shownResourceWatches } from "@solus/client-core/resource-watch-row";
  import { resourceWatchesStore } from "../../contexts/sessions/resource-watches.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import BackgroundItemRow from "./BackgroundItemRow.svelte";

  /**
   * The session's resource watches (docs/plans/mcp-first-class.md §11.5),
   * where its background work shows, beside the MCP task rows: one row each,
   * with Stop while it is live. The last turn mounts it; the live watches show,
   * and those that ended after `since`, the turn's start.
   */
  interface Props {
    tabId: string;
    sessionId: string;
    serverId: string;
    since: number;
  }
  let { tabId, sessionId, serverId, since }: Props = $props();

  $effect(() => {
    resourceWatchesStore.ensure(serverId, sessionId);
  });
  const watches = $derived(shownResourceWatches(resourceWatchesStore.watchesFor(sessionId), since));

  async function act(watch: ResourceWatch, actionId: string): Promise<void> {
    if (actionId !== RESOURCE_WATCH_STOP.id) return;
    try {
      await resourceWatchesStore.stop(watch);
    } catch {
      toasts.error(`The watch of ${watch.name} could not be stopped`);
    }
    requestInputFocus({ tabId });
  }
</script>

{#each watches as watch (watch.id)}
  <BackgroundItemRow item={resourceWatchItem(watch)} onAction={(actionId) => act(watch, actionId)} />
{/each}
