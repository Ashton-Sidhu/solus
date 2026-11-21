<script lang="ts">
  import type { ResourceWatch } from "@solus/contracts/integrations/resource-watch";
  import { resourceWatchItem, RESOURCE_WATCH_STOP } from "@solus/client-core/resource-watch-row";
  import { mcpStore } from "../../contexts/mcp";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import BackgroundItemRow from "./BackgroundItemRow.svelte";

  /**
   * The session's resource watches (docs/plans/mcp-first-class.md §11.5),
   * where its background work shows, beside the MCP task rows: one row each,
   * with Stop while it is live.
   */
  interface Props {
    tabId: string;
    watches: readonly ResourceWatch[];
  }
  let { tabId, watches }: Props = $props();

  async function act(watch: ResourceWatch, actionId: string): Promise<void> {
    if (actionId !== RESOURCE_WATCH_STOP.id) return;
    try {
      await mcpStore.watches.stop(watch);
    } catch {
      toasts.error(`The watch of ${watch.name} could not be stopped`);
    }
    requestInputFocus({ tabId });
  }
</script>

{#each watches as watch (watch.id)}
  <BackgroundItemRow item={resourceWatchItem(watch)} onAction={(actionId) => act(watch, actionId)} />
{/each}
