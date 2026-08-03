<script lang="ts">
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

  let { params, paneId }: RouteSurfaceProps<"subagent"> = $props();

  const pane = paneActions(paneId);
</script>

<PaneChrome
  onClose={pane.closeOverlay}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close sub-agent panel"
/>
{#await import("./SubagentPane.svelte")}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    Loading subagent…
  </div>
{:then subagentModule}
  {@const SubagentPane = subagentModule.default}
  <SubagentPane tabId={params.tabId} messageId={params.messageId} />
{/await}
