<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ChevronDown as CaretDownIcon, Layers2 as GroupIcon, ListFilter as FilterIcon, TextSearch as FieldsIcon } from "@lucide/svelte";
  import type { AppCallDetail, AppCallTerm, AppCallView, AppState, AppSummary } from "@solus/contracts/apps";
  import { getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { openChatDraft } from "../../../contexts/workspace/new-chat";
  import DataTableColumnsMenu from "../../insights/data-table/DataTableColumnsMenu.svelte";
  import DataTableToolbar from "../../insights/data-table/DataTableToolbar.svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import CallFields from "./CallFields.svelte";
  import CallQueryBar from "./CallQueryBar.svelte";
  import CallRows from "./CallRows.svelte";
  import CallStats from "./CallStats.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import {
    CALL_FIRST_PAGE,
    CALL_FULL_PAGE,
    DEFAULT_CALL_COLUMNS,
    OUTCOME_CHOICES,
    activityViewOf,
    callFixPrompt,
    callQuery,
    callRangeTitle,
    callStatsQuery,
    callsInViewMatching,
    callsSummary,
    canShowMoreCalls,
    isActivityFiltered,
    rememberActivityView,
    withChip,
    type CallColumn,
    type CallOrder,
    type QuickQuery,
  } from "./lib/activity";

  /**
   * The call log (docs/plans/apps.md §9.2), as a log explorer: a query bar,
   * the Fields list beside the results, the chart of every call that passes
   * the query — a drag across it zooms the query to that time — and the
   * table of the newest ones. The host applies the query;
   * a row opens the call's error, fields, log lines, input, and trace.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    state: AppState | undefined;
    onOpenRun: (runId: string) => void;
  }
  let { serverId, app, onOpenRun }: Props = $props();

  const workspace = getWorkspaceContext();
  // A view that opens again starts from the query it left, or from the filter another section opened it on.
  const firstView = untrack(() => activityViewOf(serverId, app.id, appsStore.calls.queryFor(serverId, app.id)));
  let view = $state(firstView);
  let draftText = $state(firstView.text);
  let limit = $state(CALL_FIRST_PAGE);
  let order = $state<CallOrder>("newest");
  let columns = $state<CallColumn[]>([...DEFAULT_CALL_COLUMNS]);
  let groupByRun = $state(false);
  let rowFilter = $state("");
  let openCallId = $state<string | null>(null);
  let showsFields = $state(false);
  onDestroy(() => rememberActivityView(serverId, app.id, $state.snapshot(view)));

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    // A plain copy: a read crosses to the host, and a proxy does not.
    const statsQuery = callStatsQuery($state.snapshot(view), Date.now());
    const query = { ...statsQuery, limit };
    return untrack(() => {
      // A webhook caller goes by its declared name.
      if (!appsStore.webhooks.get(hostId, appId)) void appsStore.webhooks.load(hostId, appId);
      const releaseCalls = appsStore.calls.watch(hostId, appId, query);
      const releaseStats = appsStore.callStats.watch(hostId, appId, statsQuery);
      return () => {
        releaseCalls();
        releaseStats();
      };
    });
  });
  const calls = $derived(appsStore.calls.get(serverId, app.id));
  const callsError = $derived(appsStore.calls.errorFor(serverId, app.id));
  const stats = $derived(appsStore.callStats.get(serverId, app.id));
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id) ?? []);

  // A new query keeps the rows it had in view, dimmed, until the host answers: the
  // table does not blink empty on each run. A failed read shows its error, never the old rows.
  let lastCalls: AppCallView[] | undefined;
  const shownCalls = $derived.by(() => {
    if (calls) lastCalls = calls;
    return calls ?? (callsError ? undefined : lastCalls);
  });
  const rows = $derived(shownCalls ? callsInViewMatching(shownCalls, rowFilter, webhooks) : []);
  const isRefreshing = $derived(calls === undefined && shownCalls !== undefined);
  const count = $derived(stats ? `${stats.calls.toLocaleString()} ${stats.calls === 1 ? "call" : "calls"}` : "");
  const empty = $derived(
    rowFilter.trim()
      ? "No call in view holds this text."
      : view.zoom
        ? "No call in the time the chart is zoomed to. Reset the zoom to see the whole range."
        : isActivityFiltered(view)
        ? "No call matches this query."
        : view.range === "all"
          ? "No operation of this app ran yet."
          : "No call in this time range. Choose All calls to see older ones.",
  );

  function setView(change: () => void) {
    change();
    limit = CALL_FIRST_PAGE;
    openCallId = null;
  }

  function run() {
    setView(() => (view.text = draftText));
  }

  function quick(query: QuickQuery) {
    if (query.order) {
      order = query.order;
      return;
    }
    draftText = query.text;
    setView(() => (view.text = query.text));
  }

  function addChip(term: AppCallTerm) {
    setView(() => (view.chips = withChip(view.chips, term)));
  }

  function askAgent(call: AppCallDetail) {
    openChatDraft(workspace, "click", { serverId, prompt: callFixPrompt(app, call) });
  }
</script>

<div class="flex min-w-0 flex-col gap-7" data-testid="app-activity">
  <CallQueryBar
    kind={view.kind}
    text={draftText}
    applied={view.text}
    range={view.range}
    chips={view.chips}
    {count}
    onKind={(kind) => setView(() => (view.kind = kind))}
    onText={(text) => (draftText = text)}
    onRun={run}
    onRange={(range) =>
      setView(() => {
        view.range = range;
        view.zoom = null;
      })}
    onQuick={quick}
    onRemoveChip={(index) => setView(() => view.chips.splice(index, 1))}
  />

  <div class="grid min-w-0 grid-cols-1 gap-x-8 gap-y-6 @min-[52rem]/pane:grid-cols-[12.5rem_minmax(0,1fr)]">
    <!-- Narrow, the Fields list waits behind its button in the table's toolbar. -->
    <div class="min-w-0 {showsFields ? '' : '@max-[52rem]/pane:hidden'}">
      <CallFields calls={shownCalls ?? []} {columns} onFilter={addChip} />
    </div>

    <div class="flex min-w-0 flex-col gap-8">
      <CallStats
        title={callRangeTitle(view.range)}
        {stats}
        error={appsStore.callStats.errorFor(serverId, app.id)}
        calls={rows}
        zoom={view.zoom}
        onZoom={(zoom) => setView(() => (view.zoom = zoom))}
        onRetry={() => void appsStore.callStats.load(serverId, app.id)}
        onOpenCall={(callId) => (openCallId = callId)}
      />

      {#if shownCalls !== undefined}
        <CallRows
          {serverId}
          appId={app.id}
          calls={rows}
          {webhooks}
          bind:openCallId
          bind:order
          bind:columns
          {groupByRun}
          {onOpenRun}
          onAskAgent={askAgent}
          summary={callsSummary(shownCalls, limit)}
          isStale={isRefreshing}
          {empty}
          onLoadMore={calls && canShowMoreCalls(calls, limit) ? () => (limit = CALL_FULL_PAGE) : undefined}
        >
          {#snippet toolbar(table)}
            {@const outcome = OUTCOME_CHOICES.find((choice) => choice.value === view.outcome) ?? OUTCOME_CHOICES[0]}
            <!-- The header band of an Insights data table: the search field and the grain's own controls, the columns at the end. -->
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h3 class="m-0 flex shrink-0 items-baseline gap-2 text-insights-chrome font-medium text-foreground">
                Calls<span class="font-normal tabular-nums text-muted-foreground">{shownCalls.length.toLocaleString()}</span>
              </h3>
              <DataTableToolbar {table} filterPlaceholder="Filter calls…" value={rowFilter} onValueChange={(value) => (rowFilter = value)} />
              <button
                type="button"
                class="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] pointer-coarse:h-10 @min-[52rem]/pane:hidden {showsFields
                  ? 'bg-[var(--wash-3)]'
                  : 'bg-background hover:bg-[var(--wash-1)]'}"
                aria-pressed={showsFields}
                onclick={() => (showsFields = !showsFields)}
              >
                <FieldsIcon class="size-4" strokeWidth={1.5} aria-hidden="true" />Fields
              </button>
              <button
                type="button"
                class="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] pointer-coarse:h-10 {groupByRun
                  ? 'bg-[var(--wash-3)]'
                  : 'bg-background hover:bg-[var(--wash-1)]'}"
                aria-pressed={groupByRun}
                onclick={() => (groupByRun = !groupByRun)}
              >
                <GroupIcon class="size-4" strokeWidth={1.5} aria-hidden="true" /><span class="hidden sm:inline">Group by run</span>
              </button>
              <span class="flex-1"></span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-background pr-2.5 pl-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] hover:bg-[var(--wash-1)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-[var(--wash-1)] pointer-coarse:h-10"
                      aria-label="Filter by outcome: {outcome.label}"
                    >
                      <FilterIcon class="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span class="hidden sm:inline">{outcome.label}</span>
                      <CaretDownIcon class="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-44">
                  <DropdownMenu.RadioGroup
                    value={view.outcome}
                    onValueChange={(value) => {
                      const next = OUTCOME_CHOICES.find((choice) => choice.value === value);
                      if (next) setView(() => (view.outcome = next.value));
                    }}
                  >
                    {#each OUTCOME_CHOICES as choice (choice.value)}
                      <DropdownMenu.RadioItem value={choice.value}>{choice.label}</DropdownMenu.RadioItem>
                    {/each}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
              <DataTableColumnsMenu {table} />
            </div>
          {/snippet}
        </CallRows>
      {:else}
        <ManageSectionState count={undefined} error={callsError} empty="" onRetry={() => void appsStore.calls.load(serverId, app.id)}>
          {#snippet children()}{/snippet}
        </ManageSectionState>
      {/if}
    </div>
  </div>
</div>
