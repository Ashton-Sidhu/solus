<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

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

{#if params.automationId === null || automation}
  <PaneChrome
    onClose={pane.close}
    onOpenInSplit={pane.moveAcross}
    isLeading={pane.isLeading}
    closeLabel="Close automation"
  />
  {#key automation?.id ?? "new"}
    {#await import("./AutomationBuilder.svelte")}
      <div
        class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
        role="status"
      >
        Loading automation…
      </div>
    {:then automationModule}
      {@const AutomationBuilder = automationModule.default}
      <AutomationBuilder {automation} inline onClose={pane.close} onDone={pane.close} />
    {/await}
  {/key}
{/if}
