<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { AppCallTerm, AppCallView, AppWebhookView } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import CodeBlock from "../../ui/CodeBlock.svelte";
  import CallFieldGroups from "./CallFieldGroups.svelte";
  import CallSheetSummary from "./CallSheetSummary.svelte";
  import CallSheetTabs from "./CallSheetTabs.svelte";
  import ModelCallResult from "./ModelCallResult.svelte";
  import StateIcon from "./StateIcon.svelte";
  import type { CallFieldName } from "./lib/activity";
  import { callSheetFacts, fieldGroupsMatching, modelCallFieldGroups, type CallSheetTab } from "./lib/call-sheet";
  import { isLongPrompt, modelCallEndText, modelStepDuration, modelStepStateLabel } from "./lib/model-calls";

  /**
   * One model call (docs/plans/app-models.md §7) as a log document: its key
   * facts and its error, then its fields, the prompt, what the model wrote,
   * and its result; its JSON; the operations the model called as its trace;
   * and the calls around it. A running call reads again as it writes
   * (`apps.activity`).
   */
  interface Props {
    serverId: string;
    appId: string;
    /** The call's row in the log: its version and how it ended. */
    row: AppCallView;
    webhooks?: AppWebhookView[];
    p95Ms?: number | null;
    liveVersion?: number | null;
    around?: Snippet;
    columns?: readonly CallFieldName[];
    onFilter?: (term: AppCallTerm) => void;
    onToggleColumn?: (field: CallFieldName) => void;
  }
  let { serverId, appId, row, webhooks = [], p95Ms = null, liveVersion = null, around, columns = [], onFilter, onToggleColumn }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const call = row.id;
    return untrack(() => appsStore.modelCallDetail.watch(hostId, id, call));
  });
  const read = $derived(appsStore.modelCallDetail.get(serverId, appId));
  // The store holds one call of an app at a time: the answer for another call is not this one's.
  const call = $derived(read && read.id === row.id ? read : null);
  const isMissing = $derived(read === null && appsStore.modelCallDetail.queryFor(serverId, appId) === row.id);
  const error = $derived(appsStore.modelCallDetail.errorFor(serverId, appId));

  let tab = $state<CallSheetTab>("fields");
  let findText = $state("");
  let isPromptOpen = $state(false);
  const tabs = $derived<CallSheetTab[]>(around ? ["fields", "json", "trace", "around"] : ["fields", "json", "trace"]);
  const groups = $derived(call ? fieldGroupsMatching(modelCallFieldGroups(call, row, webhooks), findText) : []);
</script>

<div class="flex min-w-0 flex-col pt-5" data-testid="app-model-call-detail">
  {#if call}
    <CallSheetSummary facts={callSheetFacts(row, p95Ms, liveVersion, webhooks)} error={call.error} />
    <CallSheetTabs {tabs} {tab} {findText} onTab={(next) => (tab = next)} onFind={(text) => (findText = text)} />

    <div class="min-w-0" role="tabpanel" aria-labelledby="call-sheet-tab-{tab}">
      {#if tab === "fields"}
        <CallFieldGroups {groups} {columns} {onFilter} {onToggleColumn} />
        {#if !findText.trim()}
          <!-- The call reads top to bottom as it happened: what the app asked, what the model wrote, and how it ended. -->
          <section class="flex min-w-0 flex-col gap-1 px-6 pt-3.5" aria-label="Prompt">
            <h4 class="m-0 text-xs font-normal text-(--solus-text-tertiary)">Prompt</h4>
            <p class="m-0 text-[13px]/relaxed whitespace-pre-wrap text-pretty text-foreground select-text {isPromptOpen ? 'max-h-[32rem] overflow-auto' : 'line-clamp-4'}">{call.prompt}</p>
            {#if isLongPrompt(call.prompt)}
              <Button size="xs" variant="ghost" class="-ml-2 self-start text-(--solus-text-tertiary)" aria-expanded={isPromptOpen} onclick={() => (isPromptOpen = !isPromptOpen)}>
                {isPromptOpen ? "Show less" : "Show the whole prompt"}
              </Button>
            {/if}
          </section>
          {#if call.text}
            <section class="flex min-w-0 flex-col gap-1 px-6 pt-3.5" aria-label="What the model wrote">
              <h4 class="m-0 text-xs font-normal text-(--solus-text-tertiary)">Model notes</h4>
              <p class="m-0 max-h-72 overflow-auto text-[13px]/relaxed whitespace-pre-wrap text-pretty text-(--solus-text-secondary) select-text" aria-live="polite">{call.text}</p>
            </section>
          {/if}
          <section class="flex min-w-0 flex-col gap-1 px-6 pt-3.5" aria-label="Result">
            {#if call.result !== null && !call.error}
              <ModelCallResult result={call.result}>
                {#snippet heading()}<h4 class="m-0 text-xs font-normal text-(--solus-text-tertiary)">Result</h4>{/snippet}
              </ModelCallResult>
            {:else if !call.error}
              <h4 class="m-0 text-xs font-normal text-(--solus-text-tertiary)">Result</h4>
              <p class="m-0 text-[13px] text-(--solus-text-tertiary)">{modelCallEndText(call.status)}</p>
            {/if}
          </section>
        {/if}
      {:else if tab === "json"}
        <div class="min-w-0 px-6 pt-1">
          <CodeBlock text={JSON.stringify(call, null, 2)} lang="json" />
        </div>
      {:else if tab === "trace"}
        <!-- A model call has no spans; the operations it called are what it waited for. -->
        <div class="min-w-0 px-6 pt-1">
          {#if call.steps.length === 0}
            <p class="m-0 py-2 text-[13px] text-(--solus-text-tertiary)">The model called no operation of the app.</p>
          {:else}
            <ol class="m-0 flex list-none flex-col p-0" aria-label="Operations the model called" data-testid="app-model-call-steps">
              {#each call.steps as step, index (index)}
                <li class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-[13px]">
                  <span class="flex w-4 shrink-0 justify-center">
                    {#if step.state !== "done"}<StateIcon state={step.state} label={modelStepStateLabel(step.state)} size={14} />{/if}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{step.tool}</span>
                  <span class="shrink-0 font-mono text-xs text-(--solus-text-tertiary)">{modelStepDuration(step)}</span>
                  {#if step.error}
                    <span class="min-w-0 basis-full truncate pl-6 text-xs text-(--solus-text-secondary)" title={step.error}>{step.error}</span>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      {:else if around}
        {@render around()}
      {/if}
    </div>
  {:else if isMissing}
    <p class="m-0 px-6 text-sm text-(--solus-text-tertiary)">The host no longer keeps this model call.</p>
  {:else if error}
    <p class="m-0 px-6 text-sm text-destructive" role="alert">{error}</p>
  {:else}
    <p class="m-0 px-6 text-sm text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the call…</p>
  {/if}
</div>
