<script lang="ts">
  import { untrack } from "svelte";
  import type { AppCallDetail, AppWebhookView } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import TraceWaterfall from "../../insights/TraceWaterfall.svelte";
  import { Button } from "../../ui/button";
  import CodeBlock from "../../ui/CodeBlock.svelte";
  import * as Tabs from "../../ui/tabs";
  import { CALL_DETAIL_TABS, callAttributes, callDetailTab, callDetailTabs, inputFacts, prettyJson, type CallDetailTab } from "./lib/activity";
  import { callTraceView, logLineOffset } from "./lib/trace";

  /**
   * One call with what the host kept of it (docs/plans/apps.md decision 21),
   * flat inside its row: its error and stack, what to do next, and its fields;
   * under them its log lines, its input, and its trace. Never a result. It
   * opens on the tab `callDetailTab` names.
   */
  interface Props {
    serverId: string;
    appId: string;
    callId: string;
    /** The webhooks of the app: a webhook caller goes by its declared name. */
    webhooks?: AppWebhookView[];
    /** Opens the run a step's call belongs to; absent where the reader is in that run already. */
    onOpenRun?: (runId: string) => void;
    /** Starts a chat about a failed call; absent where no chat can start. */
    onAskAgent?: (call: AppCallDetail) => void;
    /** The detail draws its own wash; false where its row is tinted already. */
    tinted?: boolean;
  }
  let { serverId, appId, callId, webhooks = [], onOpenRun, onAskAgent, tinted = true }: Props = $props();

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

  let chosenTab = $state<CallDetailTab | null>(null);
  const tab = $derived(chosenTab ?? (detail ? callDetailTab(detail) : "logs"));
  const trace = $derived(detail ? callTraceView(detail) : null);
  const facts = $derived(
    detail
      ? [
          ...inputFacts(detail.input, detail.inputTruncated).map((fact) => ({ key: fact.key, label: fact.key, value: fact.value, mono: false })),
          ...callAttributes(detail, webhooks).flatMap((group) => group.attributes.map((attribute) => ({ key: attribute.key, label: attribute.label, value: attribute.value, mono: attribute.mono ?? false }))),
        ]
      : [],
  );
</script>

<div class="flex min-w-0 flex-col gap-4 px-4 pt-1 pb-4 {tinted ? 'border-t border-border/40 bg-[var(--wash-1)] pt-3' : ''}" data-testid="app-call-detail">
  {#if detail}
    <div class="grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 @min-[40rem]/call-log:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div class="flex min-w-0 flex-col gap-3">
        {#if detail.error}
          <p class="m-0 text-sm text-(--failure) text-pretty" role="alert">{detail.error}</p>
          {#if detail.errorStack}
            <pre class="m-0 max-h-40 overflow-auto font-mono text-xs leading-5 whitespace-pre text-muted-foreground" aria-label="Stack">{detail.errorStack}</pre>
          {/if}
        {:else}
          <p class="m-0 text-sm text-(--solus-text-secondary)">{detail.outcome === "running" ? "The call runs now." : "The call ended without an error."}</p>
        {/if}
        <div class="flex flex-wrap items-center gap-2">
          {#if detail.runId && onOpenRun}
            {@const runId = detail.runId}
            <Button size="sm" variant="outline" onclick={() => onOpenRun(runId)}>Open run</Button>
          {/if}
          {#if detail.spans.length > 0}
            <Button size="sm" variant="outline" aria-pressed={tab === "trace"} onclick={() => (chosenTab = "trace")}>Trace</Button>
          {/if}
          {#if detail.outcome === "failed" && onAskAgent}
            {@const call = detail}
            <Button size="sm" onclick={() => onAskAgent(call)}>Ask an agent to fix</Button>
          {/if}
        </div>
      </div>

      <dl class="m-0 flex min-w-0 flex-col text-[13px]" aria-label="Fields" data-testid="app-call-fields-list">
        {#each facts as fact (fact.key)}
          <div class="flex min-w-0 items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-b-0">
            <dt class="shrink-0 text-muted-foreground">{fact.label}</dt>
            <dd class="m-0 min-w-0 truncate text-right text-foreground select-text {fact.mono ? 'font-mono text-xs' : ''}" title={fact.value}>{fact.value}</dd>
          </div>
        {/each}
      </dl>
    </div>

    <Tabs.Root bind:value={() => tab, (next) => (chosenTab = CALL_DETAIL_TABS.find((entry) => entry === next) ?? null)}>
      <Tabs.List variant="line" class="h-auto gap-4 border-b border-border/50 p-0 group-data-horizontal/tabs:h-auto">
        {#each callDetailTabs(detail) as entry (entry.value)}
          <Tabs.Trigger
            value={entry.value}
            class="h-auto flex-none rounded-none px-0 pt-0 pb-2 text-insights-chrome group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-px data-active:text-foreground"
          >
            {entry.label}
            {#if entry.count !== null}
              <span class="tabular-nums text-muted-foreground">{entry.count}</span>
            {/if}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>

      <Tabs.Content value="logs">
        {#if detail.logs.length === 0}
          <p class="m-0 py-2 text-insights-chrome text-muted-foreground">The call wrote no log line.</p>
        {:else}
          <ol class="m-0 flex max-h-80 list-none flex-col overflow-auto py-1 text-insights-chrome" aria-label="Log lines">
            {#each detail.logs as line, index (index)}
              <li class="grid grid-cols-[4rem_3.25rem_minmax(0,1fr)] items-baseline gap-x-3 py-0.5 leading-5">
                <span class="text-right tabular-nums text-muted-foreground/80">{logLineOffset(line.atMs)}</span>
                <span class="font-medium {line.level === 'error' ? 'text-(--failure)' : line.level === 'warn' ? 'text-(--warning)' : line.level === 'debug' ? 'text-muted-foreground/60' : 'text-muted-foreground'}">{line.level}</span>
                <!-- The line is the app's own text: it keeps the code face, so a column of output lines up. -->
                <span class="min-w-0 font-mono break-words whitespace-pre-wrap text-foreground select-text">{line.text}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if detail.logsTruncated}
          <p class="m-0 pt-1.5 text-insights-chrome text-muted-foreground">The call wrote more lines than the host keeps. These are the first ones.</p>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="input">
        {#if detail.input === null}
          <p class="m-0 py-2 text-insights-chrome text-muted-foreground">The host kept no input for this call.</p>
        {:else}
          <!-- Cut input is not whole JSON, so it is not coloured as JSON. -->
          <div class="max-h-80 min-w-0 overflow-auto">
            <CodeBlock text={detail.inputTruncated ? detail.input : prettyJson(detail.input)} lang={detail.inputTruncated ? undefined : "json"} />
          </div>
          {#if detail.inputTruncated}
            <p class="m-0 pt-1.5 text-insights-chrome text-muted-foreground">The input was longer than the host keeps. This is its start.</p>
          {/if}
        {/if}
      </Tabs.Content>

      <Tabs.Content value="trace">
        {#if trace}
          <div class="min-w-0 pt-1">
            <TraceWaterfall {trace} />
          </div>
        {:else}
          <p class="m-0 py-2 text-insights-chrome text-muted-foreground">The call has no span: it waited for nothing outside its own code.</p>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
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
