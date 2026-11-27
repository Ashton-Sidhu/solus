<script lang="ts">
  import { untrack } from "svelte";
  import type { AppRunDetail, AppWebhookView } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import CallRows from "./CallRows.svelte";
  import RunFlowCanvas from "./RunFlowCanvas.svelte";
  import RunTimeline from "./RunTimeline.svelte";
  import StepInspector from "./StepInspector.svelte";
  import { appTime, callerText } from "../lib/app-view";
  import { prettyJson } from "./lib/activity";
  import { runDurationText } from "./lib/runs";
  import { focusStep, runGraph, runTimeline, triggerDetailText } from "./lib/run-graph";

  /**
   * One run of a workflow (docs/plans/apps.md §8.3, §9.2): its graph in the
   * one card of the section, the selected step beside it, the run on a time
   * axis under it, then the run's facts, its result, and its log.
   */
  interface Props {
    serverId: string;
    appId: string;
    run: AppRunDetail;
    /** The newest run of the workflow that succeeded, for the steps this run did not reach. */
    lastGood: AppRunDetail | null;
    webhooks: AppWebhookView[];
    now: number;
  }
  let { serverId, appId, run, lastGood, webhooks, now }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const runId = run.id;
    return untrack(() => appsStore.runCalls.watch(hostId, id, runId));
  });
  const calls = $derived(appsStore.runCalls.queryFor(serverId, appId) === run.id ? appsStore.runCalls.get(serverId, appId) : undefined);

  const graph = $derived(runGraph(run, lastGood));
  const timeline = $derived(runTimeline(run, now));
  let chosenStep = $state<string | null>(null);
  // A step the person chose stays chosen while the run has it; else the graph picks the failed or open one.
  const selectedStep = $derived(chosenStep !== null && graph.steps.some((entry) => entry.name === chosenStep) ? chosenStep : focusStep(graph));
  const selectedIndex = $derived(graph.steps.findIndex((entry) => entry.name === selectedStep));
  let openCallId = $state<string | null>(null);
  let logSection = $state<HTMLElement | null>(null);

  function showLog() {
    logSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    logSection?.focus({ preventScroll: true });
  }
</script>

<div class="flex min-w-0 flex-col gap-3.5" data-testid="app-run-detail">
  <div class="flex min-w-0 gap-3.5 @max-[48rem]/pane:flex-col">
    <RunFlowCanvas
      runId={run.id}
      {graph}
      caller={run.startedBy}
      triggerName={callerText(run.startedBy, webhooks)}
      triggerDetail={triggerDetailText(run)}
      {selectedStep}
      onSelectStep={(name) => (chosenStep = name)}
      {now}
    />
    {#if selectedIndex !== -1}
      {@const entry = graph.steps[selectedIndex]}
      <StepInspector
        {serverId}
        {appId}
        workflow={run.workflow}
        version={run.version}
        {entry}
        position={selectedIndex + 1}
        count={graph.steps.length}
        input={run.input}
        lastGood={lastGood?.steps.find((step) => step.name === entry.name) ?? null}
        {now}
        onShowLog={showLog}
      />
    {:else}
      <aside class="flex w-65 shrink-0 flex-col gap-1 pt-1.5 @max-[48rem]/pane:w-full">
        <span class="text-xs text-(--solus-text-tertiary)">No step yet</span>
        <p class="m-0 text-[13px] text-(--solus-text-secondary)">The run has not started a step.</p>
      </aside>
    {/if}
  </div>

  {#if timeline.lanes.length > 0}
    <RunTimeline {timeline} {selectedStep} onSelectStep={(name) => (chosenStep = name)} />
  {/if}

  <dl class="m-0 grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-6 gap-y-3 px-1 text-[13px]">
    <div class="flex min-w-0 flex-col gap-0.5">
      <dt class="text-xs text-(--solus-text-tertiary)">Started</dt>
      <dd class="m-0 truncate tabular-nums" title={new Date(run.startedAt).toLocaleString()}>{appTime(run.startedAt, now)}</dd>
    </div>
    <div class="flex min-w-0 flex-col gap-0.5">
      <dt class="text-xs text-(--solus-text-tertiary)">Time</dt>
      <dd class="m-0 truncate tabular-nums">{runDurationText(run, now)}</dd>
    </div>
    {#if run.wakeAt !== null && run.state === "sleeping"}
      <div class="flex min-w-0 flex-col gap-0.5">
        <dt class="text-xs text-(--solus-text-tertiary)">Wakes</dt>
        <dd class="m-0 truncate tabular-nums" title={new Date(run.wakeAt).toLocaleString()}>{appTime(run.wakeAt, now)}</dd>
      </div>
    {/if}
    {#if run.version !== null}
      <div class="flex min-w-0 flex-col gap-0.5">
        <dt class="text-xs text-(--solus-text-tertiary)">Version</dt>
        <dd class="m-0 truncate tabular-nums">{run.version}</dd>
      </div>
    {/if}
    {#if run.key}
      <div class="flex min-w-0 flex-col gap-0.5">
        <dt class="text-xs text-(--solus-text-tertiary)">Key</dt>
        <dd class="m-0 truncate font-mono text-xs leading-5" title={run.key}>{run.key}</dd>
      </div>
    {/if}
  </dl>

  {#if run.error}
    <MarkdownAlert alertType="error">
      {#snippet content()}
        <p class="m-0 text-sm text-pretty text-foreground select-text" role="alert">{run.error}</p>
      {/snippet}
    </MarkdownAlert>
  {/if}

  {#if run.result !== null}
    <section class="flex min-w-0 flex-col gap-2 px-1" aria-label="Result">
      <h3 class="m-0 text-[15px] font-semibold text-foreground">Result</h3>
      <pre class="m-0 max-h-48 overflow-auto rounded-[10px] bg-[var(--wash-2)] px-3 py-2.5 font-mono text-xs whitespace-pre">{prettyJson(run.result)}</pre>
    </section>
  {/if}

  <section class="flex min-w-0 scroll-mt-4 flex-col gap-2 px-1 outline-none" aria-label="Log of the run" tabindex="-1" bind:this={logSection}>
    <h3 class="m-0 text-[15px] font-semibold text-foreground">Log of the run</h3>
    {#if calls === undefined}
      {@const callsError = appsStore.runCalls.errorFor(serverId, appId)}
      {#if callsError}
        <MarkdownAlert alertType="error">
          {#snippet content()}
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
              <p class="m-0 min-w-0 flex-1 text-pretty text-foreground" role="alert">{callsError}</p>
              <Button size="xs" variant="link" class="h-auto px-0 text-[13px]" onclick={() => void appsStore.runCalls.load(serverId, appId, run.id)}>Try again</Button>
            </div>
          {/snippet}
        </MarkdownAlert>
      {:else}
        <p class="m-0 text-[13px] text-muted-foreground" role="status" aria-busy="true">Loading the log…</p>
      {/if}
    {:else if calls.length === 0}
      <p class="m-0 text-[13px] text-muted-foreground">The call log holds no row of this run.</p>
    {:else}
      <!-- Each execution of the run's function, with its log lines and the spans of its steps, and each call a step made. -->
      <CallRows {serverId} {appId} {calls} {webhooks} bind:openCallId />
    {/if}
  </section>
</div>
