<script lang="ts">
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import FilesRouteSkeleton from "./FilesRouteSkeleton.svelte";

  let { params, paneId }: RouteSurfaceProps<"files"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const api = $derived(serverConnections.apiFor(params.serverId));
  const ctx = $derived(session.ctxForEnvironment(params.cwd, null));
</script>

{#await import("./FilesPane.svelte")}
  <FilesRouteSkeleton variant="tree" />
{:then filesModule}
  {@const FilesPane = filesModule.default}
  <FilesPane
    {api}
    {ctx}
    cwd={params.cwd}
    isDark={session.settings.isDark}
    bordered={!pane.isLeading}
    onClose={pane.closeOverlay}
  />
{/await}
<!-- After the content: the header above is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.closeOverlay}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close files"
/>
