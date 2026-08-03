<script lang="ts">
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

  let { params, paneId }: RouteSurfaceProps<"files"> = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pane = paneActions(paneId);

  const environment = $derived(environmentStore.environmentFor(params.sourceTabId));
</script>

<PaneChrome onClose={pane.closeOverlay} isLeading={pane.isLeading} closeLabel="Close files" />
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
    ctx={session.ctxForEnvironment(environment.cwd, environment.checkout, params.sourceTabId)}
    cwd={environment.cwd}
    isDark={session.settings.isDark}
    onClose={pane.closeOverlay}
  />
{/await}
