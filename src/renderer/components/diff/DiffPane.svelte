<script lang="ts">
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";

  let { params, paneId }: RouteSurfaceProps<"diff"> = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pane = paneActions(paneId);

  const sourceTab = $derived(session.tabs[params.sourceTabId]);
  const sourceSession = $derived(session.sessionFor(params.sourceTabId));
  const environment = $derived(environmentStore.environmentFor(session.sessionFor(params.sourceTabId)?.run));

  // Jumping to a file is a request, not a state: asking for the same file twice
  // has to move the panel again. The router's navigation epoch is that request,
  // in place of the counter that used to be threaded through the pane content.
  const navigationRequestId = $derived(
    params.filePath ? session.router.navigationEpoch : undefined,
  );
</script>

{#await import("./DiffPanel.svelte")}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    Loading changes…
  </div>
{:then diffModule}
  {@const DiffPanel = diffModule.default}
  <DiffPanel
    tabId={sourceTab?.id ?? ""}
    getCtx={() =>
      session.ctxForEnvironment(environment.cwd, environment.checkout, params.sourceTabId)}
    projectPath={sourceSession?.run.workingDirectory ?? environment.cwd}
    worktreePath={sourceSession?.run.gitContext?.worktreePath ?? environment.worktreePath ?? environment.cwd}
    worktreeBranch={sourceSession?.run.gitContext?.branch ??
      session.globalDefaults.gitContext?.branch ??
      ""}
    targetBranch={sourceSession?.run.gitContext?.targetBranch ??
      session.globalDefaults.gitContext?.targetBranch ??
      "HEAD"}
    isWorktree={environment.isolated || !!session.globalDefaults.gitContext?.worktreePath}
    onClose={pane.closeOverlay}
    initialScope={params.scope}
    initialFilePath={params.filePath}
    {navigationRequestId}
  />
{/await}
<!-- After the content: the toolbar above is a window drag region, and a drag
     rect later in the DOM would re-cover this cluster's no-drag holes. -->
<PaneChrome
  onClose={pane.closeOverlay}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close diff panel"
/>
