<script lang="ts">
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import ConversationPaneSkeleton from "./ConversationPaneSkeleton.svelte";

  let { params, paneId }: RouteSurfaceProps<"subagent"> = $props();

  const pane = paneActions(() => paneId);
</script>

{#await import("./SubagentPane.svelte")}
  <ConversationPaneSkeleton />
{:then subagentModule}
  {@const SubagentPane = subagentModule.default}
  {#key params.toolId ?? params.messageId}
    <SubagentPane sessionId={params.sessionId} serverId={params.serverId} messageId={params.messageId} requestedToolId={params.toolId} />
  {/key}
{/await}
<!-- After the content: a window drag rect later in the DOM would re-cover this
     cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.close}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  closeLabel="Close sub-agent panel"
/>
