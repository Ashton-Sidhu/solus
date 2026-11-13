<script lang="ts">
  import { untrack } from "svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import CallRows from "./CallRows.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import {
    CALLER_KIND_CHOICES,
    CALL_FIRST_PAGE,
    CALL_FULL_PAGE,
    NO_CALL_FILTER,
    OUTCOME_CHOICES,
    callFilterOf,
    callQuery,
    canShowMoreCalls,
    isCallFilterSet,
    operationChoices,
  } from "./lib/activity";

  /**
   * The call log (docs/plans/apps.md §9.2): each call of an operation and each
   * execution of a workflow's function, the newest first. The host applies the
   * filters. A row opens the call's input, log lines, and trace.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state; the operation filter reads its descriptor. */
    state: AppState | undefined;
    onOpenRun: (runId: string) => void;
  }
  let { serverId, app, state: appState, onOpenRun }: Props = $props();

  // A view that opens again starts from the list it left.
  const lastQuery = untrack(() => appsStore.calls.queryFor(serverId, app.id));
  let filter = $state(callFilterOf(lastQuery));
  let limit = $state(lastQuery.limit ?? CALL_FIRST_PAGE);
  let openCallId = $state<string | null>(null);

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const query = callQuery(filter, limit);
    return untrack(() => {
      // A webhook caller goes by its declared name.
      if (!appsStore.webhooks.get(hostId, appId)) void appsStore.webhooks.load(hostId, appId);
      return appsStore.calls.watch(hostId, appId, query);
    });
  });
  const calls = $derived(appsStore.calls.get(serverId, app.id));
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id) ?? []);

  // A row of a workflow's own execution goes by the workflow's name, so the filter offers those names too.
  const declared = $derived([...(appState?.descriptor?.operations ?? []), ...(appState?.descriptor?.workflows ?? [])].map((entry) => entry.name));
  const seen = $derived([...(appsStore.metrics.get(serverId, app.id)?.operations.map((entry) => entry.operation) ?? []), ...(calls ?? []).map((call) => call.operation)]);
  const operations = $derived(operationChoices(declared, seen, filter.operation));

  function clearFilters() {
    filter = { ...NO_CALL_FILTER };
    requestInputFocus();
  }
</script>

<ManageHeading title="Activity" description="The call log: each call of an operation, with its input, its log lines, and its trace. The host keeps the newest 2,000.">
  {#snippet actions()}
    <SettingsSelect compact ariaLabel="Operation" options={operations} value={filter.operation} onSelect={(operation) => (filter.operation = operation)} />
    <SettingsSelect compact ariaLabel="Caller" options={CALLER_KIND_CHOICES} value={filter.callerKind} onSelect={(callerKind) => (filter.callerKind = callerKind)} />
    <SettingsSelect compact ariaLabel="Outcome" options={OUTCOME_CHOICES} value={filter.outcome} onSelect={(outcome) => (filter.outcome = outcome)} />
    {#if isCallFilterSet(filter)}
      <Button size="xs" variant="ghost" onclick={clearFilters}>Clear filters</Button>
    {/if}
  {/snippet}
</ManageHeading>

<ManageSectionState
  count={calls?.length}
  error={appsStore.calls.errorFor(serverId, app.id)}
  empty={isCallFilterSet(filter) ? "No call passes these filters." : "No operation of this app ran yet."}
  onRetry={() => void appsStore.calls.load(serverId, app.id)}
>
  <CallRows {serverId} appId={app.id} calls={calls ?? []} {webhooks} bind:openCallId {onOpenRun} />
  {#if calls && canShowMoreCalls(calls, limit)}
    <Button size="xs" variant="outline" class="mt-3" onclick={() => (limit = CALL_FULL_PAGE)}>Show more calls</Button>
  {/if}
</ManageSectionState>
