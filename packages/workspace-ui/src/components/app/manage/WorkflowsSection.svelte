<script lang="ts">
  import { untrack } from "svelte";
  import { CircleStop as TerminateIcon, RotateCw as RetryIcon } from "@lucide/svelte";
  import type { AppRunState, AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import PickerPill from "./PickerPill.svelte";
  import RunDetail from "./RunDetail.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { appTime, versionLabel } from "../lib/app-view";
  import { RUN_STATE_CHOICES, canRetryRun, canTerminateRun, failedStepName, runStateLabel, shortRunId, workflowNames } from "./lib/runs";
  import { runState } from "./lib/states";

  /**
   * The Workflows section (docs/plans/apps.md §8.3, §9.2). A bar picks the
   * workflow and the run, and holds Terminate and Retry. The run shows as a
   * graph in the section's one card, with its selected step beside it and
   * its timeline under it. The runs of every workflow are a plain list under
   * that, with a filter on the state.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
    /** The run that shows. Another section can open one; null shows the newest run of the workflow. */
    openRunId: string | null;
  }
  let { serverId, app, state: appState, openRunId = $bindable() }: Props = $props();

  let stateFilter = $state<AppRunState | "">(untrack(() => appsStore.runs.queryFor(serverId, app.id).state ?? ""));
  let chosenWorkflow = $state<string | null>(null);

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const query = stateFilter ? { state: stateFilter } : {};
    return untrack(() => {
      const releaseRuns = appsStore.runs.watch(hostId, appId, query);
      if (!appsStore.webhooks.get(hostId, appId)) void appsStore.webhooks.load(hostId, appId);
      return releaseRuns;
    });
  });
  const runs = $derived(appsStore.runs.get(serverId, app.id));
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id) ?? []);
  const declared = $derived(appState?.descriptor?.workflows ?? []);
  const workflows = $derived(workflowNames(declared, runs ?? []));

  // The run that shows: the one opened, else the newest run of the chosen workflow.
  // An opened run can be outside the list the filter gives: its detail names its workflow then.
  const read = $derived(appsStore.runDetail.get(serverId, app.id));
  const openWorkflow = $derived(openRunId === null ? null : ((runs ?? []).find((entry) => entry.id === openRunId)?.workflow ?? (read?.id === openRunId ? read.workflow : null)));
  const workflow = $derived(openWorkflow ?? chosenWorkflow ?? runs?.[0]?.workflow ?? workflows[0] ?? null);
  const workflowRuns = $derived((runs ?? []).filter((run) => run.workflow === workflow));
  const shownRunId = $derived(openRunId ?? workflowRuns[0]?.id ?? null);

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const runId = shownRunId;
    if (!runId) return;
    return untrack(() => appsStore.runDetail.watch(hostId, appId, runId));
  });
  // The store holds one run of an app at a time: the answer for another run is not this one's.
  const run = $derived(read && read.id === shownRunId ? read : null);
  const isMissing = $derived(read === null && shownRunId !== null && appsStore.runDetail.queryFor(serverId, app.id) === shownRunId);
  const runError = $derived(appsStore.runDetail.errorFor(serverId, app.id));

  // A run that did not succeed shows, dashed, the steps the newest good run of its workflow did after it.
  const needsLastGood = $derived(run !== null && run.state !== "succeeded");
  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const name = needsLastGood ? run?.workflow ?? null : null;
    if (!name) return;
    return untrack(() => appsStore.lastGoodRun.watch(hostId, appId, name));
  });
  const lastGood = $derived(needsLastGood && run && appsStore.lastGoodRun.queryFor(serverId, app.id) === run.workflow ? appsStore.lastGoodRun.get(serverId, app.id) ?? null : null);

  // The ages and the time of a run in progress move with the clock, once a minute.
  let now = $state(Date.now());
  $effect(() => messageTimestampClock.subscribe((value) => (now = value)));

  const retryStep = $derived(run ? failedStepName(run) : null);
  let isBusy = $state(false);

  async function act(action: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await action();
    } catch (cause) {
      toasts.error(failure, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isBusy = false;
      requestInputFocus();
    }
  }

  function terminate(runId: string) {
    if (!confirm("Terminate this run? Its finished steps stay done, and it does not continue.")) return;
    void act(() => appsStore.terminateRun(serverId, app.id, runId), "The run did not stop");
  }

  function chooseWorkflow(name: string) {
    chosenWorkflow = name;
    openRunId = null;
  }

  function openRunRow(runId: string, runWorkflow: string) {
    chosenWorkflow = runWorkflow;
    openRunId = runId;
  }
</script>

{#snippet runValue()}
  {#if run}
    <span class="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">{shortRunId(run.id)}</span>
    <span class="shrink-0 {run.state === 'failed' ? 'text-(--failure)' : 'text-(--solus-text-secondary)'}">{runStateLabel(run.state)}</span>
    <span class="shrink-0 truncate text-(--solus-text-tertiary) @max-[40rem]/pane:hidden">· {appTime(run.startedAt, now)}</span>
  {:else}
    <span class="min-w-0 truncate text-(--solus-text-secondary)">{shownRunId ? shortRunId(shownRunId) : "No run"}</span>
  {/if}
{/snippet}

<div class="flex min-w-0 flex-col gap-3.5" data-testid="app-workflows">
  <div class="flex min-w-0 flex-wrap items-center gap-2" role="toolbar" aria-label="Run">
    <PickerPill
      name="Workflow"
      options={workflows.map((name) => ({ value: name, label: name }))}
      selected={workflow}
      onSelect={chooseWorkflow}
      disabled={workflows.length === 0}
    />
    <PickerPill
      name="Run"
      options={workflowRuns.map((entry) => ({ value: entry.id, label: shortRunId(entry.id), detail: `${runStateLabel(entry.state)} · ${appTime(entry.startedAt, now)}` }))}
      selected={shownRunId}
      onSelect={(runId) => (openRunId = runId)}
      disabled={workflowRuns.length === 0}
      value={runValue}
    />
    <span class="min-w-0 flex-1"></span>
    {#if run && canTerminateRun(run)}
      <Button variant="ghost" size="sm" disabled={isBusy} onclick={() => terminate(run.id)}><TerminateIcon /> Terminate</Button>
    {/if}
    {#if run && canRetryRun(run)}
      <Button size="sm" class="min-w-0" disabled={isBusy} onclick={() => void act(() => appsStore.retryRun(serverId, app.id, run.id), "The run did not start again")} data-testid="app-run-retry">
        <RetryIcon />
        <span class="truncate">{retryStep ? `Retry from ${retryStep}` : "Run again"}</span>
      </Button>
    {/if}
  </div>

  {#if run}
    <RunDetail {serverId} appId={app.id} {run} {lastGood} {webhooks} {now} />
  {:else if shownRunId}
    {#if runError}
      <div class="flex flex-wrap items-center gap-2" role="alert">
        <span class="text-sm text-destructive">{runError}</span>
        <Button size="xs" variant="outline" onclick={() => void appsStore.runDetail.load(serverId, app.id, shownRunId)}>Try again</Button>
      </div>
    {:else if isMissing}
      <p class="m-0 text-sm text-muted-foreground">The host no longer keeps this run.</p>
    {:else}
      <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading the run…</p>
    {/if}
  {/if}

  <section class="flex min-w-0 flex-col gap-2 pt-4" aria-label="Runs" data-testid="app-runs">
    <div class="flex min-w-0 items-center gap-3 px-1">
      <h3 class="m-0 min-w-0 flex-1 text-[15px] font-semibold text-foreground">Runs</h3>
      <SettingsSelect compact ariaLabel="Run state" options={RUN_STATE_CHOICES} value={stateFilter} onSelect={(next) => (stateFilter = next)} />
    </div>
    <ManageSectionState
      count={runs?.length}
      error={appsStore.runs.errorFor(serverId, app.id)}
      empty={stateFilter ? "No run is in this state." : declared.length > 0 || !appState ? "No workflow of this app ran yet." : "This app declares no workflow."}
      onRetry={() => void appsStore.runs.load(serverId, app.id)}
    >
      <ul class="m-0 flex list-none flex-col p-0">
        {#each runs ?? [] as entry (entry.id)}
          {@const isShown = entry.id === shownRunId}
          <li class="border-t border-[var(--hairline)] first:border-t-0">
            <button
              type="button"
              class="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-lg border-0 bg-transparent px-2 py-2 text-left transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none {isShown ? 'bg-[var(--wash-2)]' : ''}"
              aria-current={isShown ? "true" : undefined}
              data-testid="app-run-row"
              onclick={() => openRunRow(entry.id, entry.workflow)}
            >
              <StateIcon state={runState(entry.state)} />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-sm font-medium text-foreground">{entry.workflow}</span>
                  <span class="shrink-0 font-mono text-xs text-(--solus-text-tertiary)">{shortRunId(entry.id)}</span>
                  {#if entry.version !== null}
                    <span class="shrink-0 text-xs text-(--solus-text-tertiary) tabular-nums" title="Ran on version {entry.version}">{versionLabel(entry.version)}</span>
                  {/if}
                </span>
                <span class="truncate text-[13px] text-(--solus-text-secondary)">
                  <span class={entry.state === "failed" ? "text-(--failure)" : ""}>{runStateLabel(entry.state)}</span>{#if entry.dismissedAt !== null} · Dismissed{/if} · {entry.stepCount === 1 ? "1 step" : `${entry.stepCount} steps`}{#if entry.state === "sleeping" && entry.wakeAt !== null} · wakes {appTime(entry.wakeAt, now)}{/if}{#if entry.error}<span class="text-(--failure)" title={entry.error}> · {entry.error}</span>{/if}
                </span>
              </span>
              <span class="shrink-0 text-xs text-(--solus-text-tertiary) tabular-nums" title={new Date(entry.startedAt).toLocaleString()}>{appTime(entry.startedAt, now)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </ManageSectionState>
  </section>
</div>
