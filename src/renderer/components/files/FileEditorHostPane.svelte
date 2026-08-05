<script lang="ts">
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

  let { params, paneId }: RouteSurfaceProps<"fileEditor"> = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pane = paneActions(paneId);

  const environment = $derived(environmentStore.environmentFor(params.sourceTabId));
  const file = $derived({
    path: params.path,
    line: params.line,
    tabId: params.sourceTabId,
  });
  // Every navigation bumps the epoch, including one that lands on the route
  // already showing — which is exactly the "same file, asked for again" case a
  // changed param cannot detect.
  const revealEpoch = $derived(params.line ? session.router.navigationEpoch : 0);
</script>

<div
  class="h-full min-h-0 min-w-0"
  role="group"
  aria-label="File editor"
  onpointerdown={() => session.router.focusPane(paneId)}
  onfocusin={() => session.router.focusPane(paneId)}
>
  <PaneChrome onClose={pane.closeOverlay} isLeading={pane.isLeading} closeLabel="Close file editor" />
  {#await import("./FileEditorPane.svelte")}
    <div
      class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
      role="status"
    >
      Loading file…
    </div>
  {:then fileEditorModule}
    {@const FileEditorPane = fileEditorModule.default}
    <FileEditorPane
      ctx={session.ctxFor(params.sourceTabId)}
      cwd={environment.cwd}
      isDark={session.settings.isDark}
      {file}
      {revealEpoch}
      onClose={pane.closeOverlay}
    />
  {/await}
</div>
