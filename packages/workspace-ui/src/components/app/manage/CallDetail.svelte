<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { AppCallTerm, AppWebhookView } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import TraceWaterfall from "../../insights/TraceWaterfall.svelte";
  import { Button } from "../../ui/button";
  import CodeBlock from "../../ui/CodeBlock.svelte";
  import CallFieldGroups from "./CallFieldGroups.svelte";
  import CallSheetSummary from "./CallSheetSummary.svelte";
  import CallSheetTabs from "./CallSheetTabs.svelte";
  import type { CallFieldName } from "./lib/activity";
  import { callFieldGroups, callJsonText, callSheetFacts, fieldGroupsMatching, type CallSheetTab } from "./lib/call-sheet";
  import { callTraceView, logLineOffset } from "./lib/trace";

  /**
   * One call of an operation with what the host kept of it (docs/plans/apps.md
   * decision 21), as a log document: its key facts, its error, then its
   * fields in groups with its log lines, its JSON, its trace, and the calls
   * around it. Never a result. The call sheet shows it; a schedule's run
   * strip shows it in place.
   */
  interface Props {
    serverId: string;
    appId: string;
    callId: string;
    /** The webhooks of the app: a webhook caller goes by its declared name. */
    webhooks?: AppWebhookView[];
    /** The p95 of the calls in the query, beside the call's duration. */
    p95Ms?: number | null;
    /** The version that runs now. */
    liveVersion?: number | null;
    /** The calls next to this one in the log; absent where there is no log around it. */
    around?: Snippet;
    columns?: readonly CallFieldName[];
    onFilter?: (term: AppCallTerm) => void;
    onToggleColumn?: (field: CallFieldName) => void;
  }
  let { serverId, appId, callId, webhooks = [], p95Ms = null, liveVersion = null, around, columns = [], onFilter, onToggleColumn }: Props = $props();

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

  let tab = $state<CallSheetTab>("fields");
  let findText = $state("");
  const tabs = $derived<CallSheetTab[]>(around ? ["fields", "json", "trace", "around"] : ["fields", "json", "trace"]);
  const trace = $derived(detail && tab === "trace" ? callTraceView(detail) : null);
  const groups = $derived(detail ? fieldGroupsMatching(callFieldGroups(detail, webhooks), findText) : []);
</script>

<div class="flex min-w-0 flex-col pt-5" data-testid="app-call-detail">
  {#if detail}
    <CallSheetSummary facts={callSheetFacts(detail, p95Ms, liveVersion, webhooks)} error={detail.error} stack={detail.errorStack} />
    <CallSheetTabs {tabs} {tab} {findText} onTab={(next) => (tab = next)} onFind={(text) => (findText = text)} />

    <div class="min-w-0" role="tabpanel" aria-labelledby="call-sheet-tab-{tab}">
      {#if tab === "fields"}
        <CallFieldGroups {groups} {columns} {onFilter} {onToggleColumn} />
        {#if !findText.trim()}
          <section class="flex min-w-0 flex-col px-4" aria-label="Log lines">
            <h4 class="m-0 px-2 pt-3.5 pb-1 text-xs font-normal text-(--solus-text-tertiary)">Log lines <span class="font-mono text-[11px]">{detail.logs.length}</span></h4>
            {#if detail.logs.length === 0}
              <p class="m-0 px-2 py-1.5 text-[13px] text-(--solus-text-tertiary)">The call wrote no log line.</p>
            {:else}
              <ol class="m-0 flex list-none flex-col p-0 px-2 text-xs" aria-label="Log lines">
                {#each detail.logs as line, index (index)}
                  <li class="grid grid-cols-[4rem_3rem_minmax(0,1fr)] items-baseline gap-x-3 py-0.5 leading-5">
                    <span class="text-right font-mono tabular-nums text-(--solus-text-tertiary)">{logLineOffset(line.atMs)}</span>
                    <span class="font-mono {line.level === 'error' ? 'text-(--failure)' : line.level === 'warn' ? 'text-(--warning)' : 'text-(--solus-text-tertiary)'}">{line.level}</span>
                    <!-- The line is the app's own text: it keeps the code face, so a column of output lines up. -->
                    <span class="min-w-0 font-mono break-words whitespace-pre-wrap text-foreground select-text">{line.text}</span>
                  </li>
                {/each}
              </ol>
            {/if}
            {#if detail.logsTruncated}
              <p class="m-0 px-2 pt-1.5 text-xs text-(--solus-text-tertiary)">The call wrote more lines than the host keeps. These are the first ones.</p>
            {/if}
          </section>
        {/if}
      {:else if tab === "json"}
        <div class="min-w-0 px-6 pt-1">
          <CodeBlock text={callJsonText(detail)} lang="json" />
          {#if detail.inputTruncated}
            <p class="m-0 pt-1.5 text-xs text-(--solus-text-tertiary)">The input was longer than the host keeps. This is its start.</p>
          {/if}
        </div>
      {:else if tab === "trace"}
        <div class="min-w-0 px-6 pt-1">
          {#if trace}
            <TraceWaterfall {trace} />
          {:else}
            <p class="m-0 py-2 text-[13px] text-(--solus-text-tertiary)">The call has no span: it waited for nothing outside its own code.</p>
          {/if}
        </div>
      {:else if around}
        {@render around()}
      {/if}
    </div>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2 px-6" role="alert">
      <span class="text-sm text-destructive">{error}</span>
      <Button size="xs" variant="outline" onclick={() => void appsStore.callDetail.load(serverId, appId, callId)}>Try again</Button>
    </div>
  {:else if isMissing}
    <p class="m-0 px-6 text-sm text-(--solus-text-tertiary)">The host no longer keeps this call.</p>
  {:else}
    <p class="m-0 px-6 text-sm text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the call…</p>
  {/if}
</div>
