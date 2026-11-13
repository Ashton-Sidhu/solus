<script lang="ts">
  import { untrack } from "svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import CallRows from "./CallRows.svelte";
  import { appTime, callerText } from "../lib/app-view";
  import { prettyJson } from "./lib/activity";
  import { attemptsText, canRetryRun, canTerminateRun, runDurationText, stepDurationText, stepKindLabel, stepStateLabel } from "./lib/runs";

  /**
   * One run of a workflow (docs/plans/apps.md §8.3): its input, its steps with
   * their receipts, its result or its error, and its log. The owner terminates
   * a run that has not ended, and starts a failed run again.
   */
  interface Props {
    serverId: string;
    appId: string;
    runId: string;
  }
  let { serverId, appId, runId }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const run = runId;
    return untrack(() => {
      const releaseRun = appsStore.runDetail.watch(hostId, id, run);
      const releaseCalls = appsStore.runCalls.watch(hostId, id, run);
      if (!appsStore.webhooks.get(hostId, id)) void appsStore.webhooks.load(hostId, id);
      return () => {
        releaseRun();
        releaseCalls();
      };
    });
  });
  const read = $derived(appsStore.runDetail.get(serverId, appId));
  // The store holds one run of an app at a time: the answer for another run is not this one's.
  const run = $derived(read && read.id === runId ? read : null);
  const isMissing = $derived(read === null && appsStore.runDetail.queryFor(serverId, appId) === runId);
  const error = $derived(appsStore.runDetail.errorFor(serverId, appId));
  const calls = $derived(appsStore.runCalls.queryFor(serverId, appId) === runId ? appsStore.runCalls.get(serverId, appId) : undefined);
  const webhooks = $derived(appsStore.webhooks.get(serverId, appId) ?? []);

  let isBusy = $state(false);
  let openCallId = $state<string | null>(null);

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

  function terminate() {
    if (!confirm("Terminate this run? Its finished steps stay done, and it does not continue.")) return;
    void act(() => appsStore.terminateRun(serverId, appId, runId), "The run did not stop");
  }
</script>

<div class="flex min-w-0 flex-col gap-3 border-t border-border/40 px-3 py-3" data-testid="app-run-detail">
  {#if run}
    <dl class="m-0 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <div class="flex gap-1.5"><dt>Started</dt><dd class="m-0 text-foreground">{new Date(run.startedAt).toLocaleString()}</dd></div>
      <div class="flex gap-1.5"><dt>By</dt><dd class="m-0 text-foreground">{callerText(run.startedBy, webhooks)}</dd></div>
      <div class="flex gap-1.5"><dt>Time</dt><dd class="m-0 tabular-nums text-foreground">{runDurationText(run)}</dd></div>
      {#if run.wakeAt !== null && run.state === "sleeping"}
        <div class="flex gap-1.5"><dt>Wakes</dt><dd class="m-0 text-foreground" title={new Date(run.wakeAt).toLocaleString()}>{appTime(run.wakeAt)}</dd></div>
      {/if}
      {#if run.key}
        <div class="flex min-w-0 gap-1.5"><dt>Key</dt><dd class="m-0 min-w-0 truncate font-mono text-foreground">{run.key}</dd></div>
      {/if}
    </dl>

    {#if canTerminateRun(run) || canRetryRun(run)}
      <div class="flex flex-wrap items-center gap-2">
        {#if canTerminateRun(run)}
          <Button size="xs" variant="outline" disabled={isBusy} onclick={terminate}>Terminate</Button>
        {/if}
        {#if canRetryRun(run)}
          <Button size="xs" variant="outline" disabled={isBusy} onclick={() => void act(() => appsStore.retryRun(serverId, appId, runId), "The run did not start again")}>Run again</Button>
          <span class="text-xs text-muted-foreground">The failed step runs again. The finished steps do not.</span>
        {/if}
      </div>
    {/if}

    {#if run.error}
      <p class="m-0 text-sm text-destructive text-pretty" role="alert">{run.error}</p>
    {/if}

    <section class="flex min-w-0 flex-col gap-1" aria-label="Input">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Input</h4>
      <pre class="m-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre">{prettyJson(run.input)}</pre>
    </section>

    {#if run.result !== null}
      <section class="flex min-w-0 flex-col gap-1" aria-label="Result">
        <h4 class="m-0 text-xs font-medium text-muted-foreground">Result</h4>
        <pre class="m-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre">{prettyJson(run.result)}</pre>
      </section>
    {/if}

    <section class="flex min-w-0 flex-col gap-1.5" aria-label="Steps">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Steps</h4>
      {#if run.steps.length === 0}
        <p class="m-0 text-xs text-muted-foreground">The run has no step yet.</p>
      {:else}
        <ol class="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="app-run-steps">
          {#each run.steps as step (step.name)}
            {@const duration = stepDurationText(step)}
            <li class="flex min-w-0 flex-col gap-1 rounded-lg border border-border/50 px-3 py-2 text-xs">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code class="min-w-0 truncate font-mono text-(--solus-text-primary)">{step.name}</code>
                <span class="shrink-0 text-muted-foreground">{stepKindLabel(step.kind)}</span>
                <span class="shrink-0 {step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{stepStateLabel(step.state)}</span>
                <span class="min-w-0 flex-1"></span>
                <span class="shrink-0 text-muted-foreground">{attemptsText(step.attempts)}</span>
                {#if duration}
                  <span class="shrink-0 tabular-nums text-muted-foreground">{duration}</span>
                {/if}
                {#if step.wakeAt !== null && step.state === "sleeping"}
                  <span class="shrink-0 text-muted-foreground" title={new Date(step.wakeAt).toLocaleString()}>Wakes {appTime(step.wakeAt)}</span>
                {/if}
              </div>
              {#if step.error}
                <p class="m-0 text-destructive text-pretty">{step.error}</p>
              {/if}
              {#if step.result !== null}
                <details class="min-w-0">
                  <summary class="cursor-pointer text-muted-foreground">Result{step.resultTruncated ? " (its start)" : ""}</summary>
                  <pre class="mt-1 mb-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono whitespace-pre">{step.resultTruncated ? step.result : prettyJson(step.result)}</pre>
                </details>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="flex min-w-0 flex-col gap-1.5" aria-label="Log of the run">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Log of the run</h4>
      {#if calls === undefined}
        {@const callsError = appsStore.runCalls.errorFor(serverId, appId)}
        {#if callsError}
          <div class="flex flex-wrap items-center gap-2" role="alert">
            <span class="text-xs text-destructive">{callsError}</span>
            <Button size="xs" variant="outline" onclick={() => void appsStore.runCalls.load(serverId, appId, runId)}>Try again</Button>
          </div>
        {:else}
          <p class="m-0 text-xs text-muted-foreground" role="status" aria-busy="true">Loading the log…</p>
        {/if}
      {:else if calls.length === 0}
        <p class="m-0 text-xs text-muted-foreground">The call log holds no row of this run.</p>
      {:else}
        <!-- Each execution of the run's function, with its log lines and the spans of its steps, and each call a step made. -->
        <CallRows {serverId} {appId} {calls} {webhooks} bind:openCallId />
      {/if}
    </section>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{error}</span>
      <Button size="xs" variant="outline" onclick={() => void appsStore.runDetail.load(serverId, appId, runId)}>Try again</Button>
    </div>
  {:else if isMissing}
    <p class="m-0 text-sm text-muted-foreground">The host no longer keeps this run.</p>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading the run…</p>
  {/if}
</div>
