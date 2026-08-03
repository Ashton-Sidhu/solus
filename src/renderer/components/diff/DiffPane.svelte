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
  const environment = $derived(environmentStore.environmentFor(params.sourceTabId));

  // Jumping to a file is a request, not a state: asking for the same file twice
  // has to move the panel again. The router's navigation epoch is that request,
  // in place of the counter that used to be threaded through the pane content.
  const navigationRequestId = $derived(
    params.filePath ? session.router.navigationEpoch : undefined,
  );
</script>

<PaneChrome
  onClose={pane.closeOverlay}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close diff panel"
/>
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
    projectPath={sourceSession?.workingDirectory ?? environment.cwd}
    worktreePath={sourceSession?.gitContext?.worktreePath ?? environment.worktreePath ?? environment.cwd}
    worktreeBranch={sourceSession?.gitContext?.branch ??
      session.globalDefaults.gitContext?.branch ??
      ""}
    targetBranch={sourceSession?.gitContext?.targetBranch ??
      session.globalDefaults.gitContext?.targetBranch ??
      "HEAD"}
    isWorktree={environment.isolated || !!session.globalDefaults.gitContext?.worktreePath}
    onClose={pane.closeOverlay}
    onToggleMaximize={pane.toggleMaximize}
    initialScope={params.scope}
    initialFilePath={params.filePath}
    {navigationRequestId}
  />
{/await}
