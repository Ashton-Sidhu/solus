<script lang="ts">
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

  let { params, paneId }: RouteSurfaceProps<"files"> = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pane = paneActions(paneId);

  // The `files-pane` scope belongs to FilesPane below; only the host knows the
  // pane id, so the handler registers here and fires while that scope is up.
  useKeybinding("files-pane.maximize", () => pane.toggleMaximize());

  const environment = $derived(environmentStore.environmentFor(session.runFor(params.sourceId)));
</script>

{#await import("./FilesPane.svelte")}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    Loading files…
  </div>
{:then filesModule}
  {@const FilesPane = filesModule.default}
  <FilesPane
    ctx={session.ctxForEnvironment(environment.cwd, environment.checkout, params.sourceId)}
    cwd={environment.cwd}
    isDark={session.settings.isDark}
    onClose={pane.closeOverlay}
  />
{/await}
<!-- After the content: the header above is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.closeOverlay}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  maximizeBinding="files-pane.maximize"
  isLeading={pane.isLeading}
  closeLabel="Close files"
/>
