<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import AutomationBuilderSkeleton from "./AutomationBuilderSkeleton.svelte";

  let { params, paneId }: RouteSurfaceProps<"automation"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);

  // The builder seeds its drafts from this prop at mount, so for a saved
  // automation we wait until the store has it (it loads on open) before
  // rendering, and key the block on the id so it remounts once resolved.
  const automation = $derived(
    params.automationId === null ? null : (session.automationsStore.get(params.automationId) ?? null),
  );
</script>

<!-- Two waits, one silhouette: the store fetching the named automation, and the
     builder's own lazy module. Neither may leave the pane blank — a pane the
     user just moved across with no content and no chrome reads as a crash. -->
{#if params.automationId !== null && !automation}
  <AutomationBuilderSkeleton />
{:else}
  {#key automation?.id ?? "new"}
    {#await import("./AutomationBuilder.svelte")}
      <AutomationBuilderSkeleton />
    {:then automationModule}
      {@const AutomationBuilder = automationModule.default}
      <AutomationBuilder
        {automation}
        originServerId={params.serverId}
        inline
        onClose={pane.close}
        onDone={pane.close}
      />
    {/await}
  {/key}
{/if}
<!-- After the content: the builder header is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.close}
  onOpenInSplit={pane.moveAcross}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close automation"
/>
