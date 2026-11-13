<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight as OpenIcon } from "@lucide/svelte";
  import type { AppRunState, AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import RunDetail from "./RunDetail.svelte";
  import { appTime } from "../lib/app-view";
  import { RUN_STATE_CHOICES, runStateLabel } from "./lib/runs";

  /**
   * The runs of the app's workflows (docs/plans/apps.md §8.3, §9.2), the newest
   * first, with a filter on the state. A row opens the run's steps.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
    /** The run that shows its steps. Another section can open one. */
    openRunId: string | null;
  }
  let { serverId, app, state: appState, openRunId = $bindable() }: Props = $props();

  let stateFilter = $state<AppRunState | "">(untrack(() => appsStore.runs.queryFor(serverId, app.id).state ?? ""));

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const query = stateFilter ? { state: stateFilter } : {};
    return untrack(() => appsStore.runs.watch(hostId, appId, query));
  });
  const runs = $derived(appsStore.runs.get(serverId, app.id));
  const declaresWorkflow = $derived((appState?.descriptor?.workflows.length ?? 0) > 0);
  // A run that another section opened can be outside the list the filter gives.
  const isOpenRunListed = $derived(openRunId !== null && (runs ?? []).some((run) => run.id === openRunId));
</script>

<ManageHeading title="Workflows" description="The runs of the app's workflows. A run keeps the result of each step, so a run that starts again does not do a finished step again.">
  {#snippet actions()}
    <SettingsSelect compact ariaLabel="Run state" options={RUN_STATE_CHOICES} value={stateFilter} onSelect={(next) => (stateFilter = next)} />
  {/snippet}
</ManageHeading>

{#if openRunId && runs && !isOpenRunListed}
  <div class="mb-3 flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/50" data-testid="app-run-open">
    <div class="flex min-w-0 items-baseline gap-2 px-3 py-2 text-xs">
      <span class="shrink-0 text-muted-foreground">Run</span>
      <code class="min-w-0 flex-1 truncate font-mono">{openRunId}</code>
    </div>
    <RunDetail {serverId} appId={app.id} runId={openRunId} />
  </div>
{/if}

<ManageSectionState
  count={runs?.length}
  error={appsStore.runs.errorFor(serverId, app.id)}
  empty={stateFilter ? "No run is in this state." : declaresWorkflow || !appState ? "No workflow of this app ran yet." : "This app declares no workflow."}
  onRetry={() => void appsStore.runs.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border/50 p-0" data-testid="app-runs">
    {#each runs ?? [] as run (run.id)}
      {@const isOpen = openRunId === run.id}
      <li class="flex min-w-0 flex-col border-b border-border/40 last:border-b-0">
        <button
          type="button"
          class="flex min-h-9 w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 overflow-hidden border-0 bg-transparent px-3 py-2 text-left text-xs transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none pointer-coarse:min-h-11"
          aria-expanded={isOpen}
          data-testid="app-run-row"
          onclick={() => (openRunId = isOpen ? null : run.id)}
        >
          <OpenIcon size={12} class="shrink-0 self-center text-muted-foreground transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
          <code class="min-w-0 shrink truncate font-mono text-(--solus-text-primary)">{run.workflow}</code>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{run.stepCount === 1 ? "1 step" : `${run.stepCount} steps`}</span>
          <span class="shrink-0 {run.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{runStateLabel(run.state)}</span>
          <span class="w-20 shrink-0 truncate text-right tabular-nums text-muted-foreground" title={new Date(run.startedAt).toLocaleString()}>{appTime(run.startedAt)}</span>
        </button>
        {#if run.error && !isOpen}
          <p class="m-0 truncate px-3 pb-2 pl-8 text-xs text-destructive" title={run.error}>{run.error}</p>
        {/if}
        {#if isOpen}
          <RunDetail {serverId} appId={app.id} runId={run.id} />
        {/if}
      </li>
    {/each}
  </ul>
</ManageSectionState>
