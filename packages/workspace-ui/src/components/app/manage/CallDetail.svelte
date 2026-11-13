<script lang="ts">
  import { untrack } from "svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { formatDuration } from "../../insights/lib/format";
  import { formatFileSize } from "../../files/lib/non-text-file";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";
  import { prettyJson } from "./lib/activity";
  import { logLineOffset } from "./lib/trace";

  /**
   * One call with what the host kept of it (docs/plans/apps.md decision 21):
   * its input, its log lines, its trace, and its error. Never a result.
   */
  interface Props {
    serverId: string;
    appId: string;
    callId: string;
    /** Opens the run a step's call belongs to; absent where the reader is in that run already. */
    onOpenRun?: (runId: string) => void;
  }
  let { serverId, appId, callId, onOpenRun }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const call = callId;
    return untrack(() => appsStore.callDetail.watch(hostId, id, call));
  });
  const read = $derived(appsStore.callDetail.get(serverId, appId));
  // The store holds one call of an app at a time: the answer for another call is not this one's.
  const detail = $derived(read && read.id === callId ? read : null);
  const isMissing = $derived(read === null && appsStore.callDetail.queryFor(serverId, appId) === callId);
  const error = $derived(appsStore.callDetail.errorFor(serverId, appId));
</script>

<div class="flex min-w-0 flex-col gap-3 border-t border-border/40 px-3 py-3" data-testid="app-call-detail">
  {#if detail}
    <dl class="m-0 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <div class="flex gap-1.5"><dt>Started</dt><dd class="m-0 text-foreground">{new Date(detail.startedAt).toLocaleString()}</dd></div>
      <div class="flex gap-1.5"><dt>Time</dt><dd class="m-0 tabular-nums text-foreground">{detail.durationMs === null ? "Runs now" : formatDuration(detail.durationMs)}</dd></div>
      <div class="flex gap-1.5"><dt>Version</dt><dd class="m-0 tabular-nums text-foreground">v{detail.version}</dd></div>
      {#if detail.resultBytes !== null}
        <div class="flex gap-1.5"><dt>Result</dt><dd class="m-0 tabular-nums text-foreground">{formatFileSize(detail.resultBytes)}</dd></div>
      {/if}
      {#if detail.traceId}
        <!-- The OpenTelemetry trace id: the key of this call in Insights and at a collector. -->
        <div class="flex min-w-0 items-center gap-1.5">
          <dt>Trace</dt>
          <dd class="m-0 min-w-0 truncate font-mono text-foreground">{detail.traceId}</dd>
          <CopyButton text={detail.traceId} title="Copy the trace id" />
        </div>
      {/if}
    </dl>

    {#if detail.error}
      <section class="flex min-w-0 flex-col gap-1" aria-label="Error">
        <p class="m-0 text-sm text-destructive text-pretty">{detail.error}</p>
        {#if detail.errorStack}
          <pre class="m-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre text-muted-foreground">{detail.errorStack}</pre>
        {/if}
      </section>
    {/if}

    {#if detail.runId && onOpenRun}
      {@const runId = detail.runId}
      <Button size="xs" variant="outline" class="self-start" onclick={() => onOpenRun(runId)}>Open its run in Workflows</Button>
    {/if}

    <section class="flex min-w-0 flex-col gap-1" aria-label="Input">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Input</h4>
      {#if detail.input === null}
        <p class="m-0 text-xs text-muted-foreground">The host kept no input for this call.</p>
      {:else}
        <pre class="m-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre">{detail.inputTruncated ? detail.input : prettyJson(detail.input)}</pre>
        {#if detail.inputTruncated}
          <p class="m-0 text-xs text-muted-foreground">The input was longer than the host keeps. This is its start.</p>
        {/if}
      {/if}
    </section>

    <section class="flex min-w-0 flex-col gap-1" aria-label="Log lines">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Log lines</h4>
      {#if detail.logs.length === 0}
        <p class="m-0 text-xs text-muted-foreground">The call wrote no log line.</p>
      {:else}
        <ol class="m-0 flex max-h-72 list-none flex-col gap-px overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
          {#each detail.logs as line, index (index)}
            <li class="flex min-w-0 gap-2">
              <span class="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{logLineOffset(line.atMs)}</span>
              <span class="w-10 shrink-0 {line.level === 'error' ? 'text-destructive' : line.level === 'warn' ? 'text-(--warning)' : 'text-muted-foreground'}">{line.level}</span>
              <span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{line.text}</span>
            </li>
          {/each}
        </ol>
      {/if}
      {#if detail.logsTruncated}
        <p class="m-0 text-xs text-muted-foreground">The call wrote more lines than the host keeps. These are the first ones.</p>
      {/if}
    </section>

    <section class="flex min-w-0 flex-col gap-1.5" aria-label="Trace">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Trace</h4>
      {#if detail.spans.length === 0}
        <p class="m-0 text-xs text-muted-foreground">The call has no span: it waited for nothing outside its own code.</p>
      {:else}
        <TraceWaterfall spans={detail.spans} durationMs={detail.durationMs} />
      {/if}
    </section>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{error}</span>
      <Button size="xs" variant="outline" onclick={() => void appsStore.callDetail.load(serverId, appId, callId)}>Try again</Button>
    </div>
  {:else if isMissing}
    <p class="m-0 text-sm text-muted-foreground">The host no longer keeps this call.</p>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading the call…</p>
  {/if}
</div>
