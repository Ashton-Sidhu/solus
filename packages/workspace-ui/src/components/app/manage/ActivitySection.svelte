<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Layers2 as GroupIcon, ListFilter as FieldsIcon, Search as SearchIcon } from "@lucide/svelte";
  import type { AppCallTerm, AppCallView, AppState, AppSummary } from "@solus/contracts/apps";
  import { getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { openChatDraft } from "../../../contexts/workspace/new-chat";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { FILTER_CHIP, FILTER_CHIP_OFF, FILTER_CHIP_ON, FILTER_SEARCH_FIELD, FILTER_SEARCH_ICON, FILTER_SEARCH_INPUT, FILTER_SEARCH_KEYCAP } from "../../ui/list-page/filter-styles";
  import ListFilterMenu from "../../ui/list-page/ListFilterMenu.svelte";
  import CallFields from "./CallFields.svelte";
  import CallQueryBar from "./CallQueryBar.svelte";
  import CallRows from "./CallRows.svelte";
  import CallStats from "./CallStats.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { ACTIVITY_EMPTY, activityEmptyTitle } from "./lib/section-empty";
  import { PAGE_SECONDARY_BTN } from "../../../lib/page-chrome";
  import PageEmpty from "../../ui/PageEmpty.svelte";
  import {
    CALL_FIRST_PAGE,
    CALL_FULL_PAGE,
    CALL_KIND_CHOICES,
    DEFAULT_CALL_COLUMNS,
    OUTCOME_CHOICES,
    activityFilterCount,
    activityViewOf,
    callFixPrompt,
    callRangeTitle,
    callStatsQuery,
    callsInViewMatching,
    callsSummary,
    canShowMoreCalls,
    isActivityFiltered,
    rememberActivityView,
    withChip,
    type CallFieldName,
    type CallFixFacts,
    type CallOrder,
    type QuickQuery,
  } from "./lib/activity";

  /**
   * The call log (docs/plans/apps.md §9.2), as a log explorer: a query bar,
   * the chart of every call that passes the query — a drag across it zooms
   * the query to that time — and one list of events, the calls of
   * operations and the model calls together, the newest first. The Fields
   * list beside the events opens from the toolbar. The host applies the
   * query; a row opens its call in a sheet over the page.
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
  let columns = $state<CallFieldName[]>([...DEFAULT_CALL_COLUMNS]);
  let groupByRun = $state(false);
  let rowFilter = $state("");
  let openCallId = $state<string | null>(null);
  let showsFields = $state(false);
  let searchField = $state<HTMLInputElement | null>(null);
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
  // log does not blink empty on each run. A failed read shows its error, never the old rows.
  let lastCalls: AppCallView[] | undefined;
  const shownCalls = $derived.by(() => {
    if (calls) lastCalls = calls;
    return calls ?? (callsError ? undefined : lastCalls);
  });
  const rows = $derived(shownCalls ? callsInViewMatching(shownCalls, rowFilter, webhooks) : []);
  const isRefreshing = $derived(calls === undefined && shownCalls !== undefined);
  const count = $derived(stats ? `${stats.calls.toLocaleString()} ${stats.calls === 1 ? "call" : "calls"}` : "");
  const filterCount = $derived(activityFilterCount(view));
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

  /** Puts back every narrowing of the log: the query, its chips, the filters, the zoom, and the find text. */
  function clearFilters() {
    rowFilter = "";
    draftText = "";
    setView(() => {
      view.text = "";
      view.chips = [];
      view.kind = "";
      view.outcome = "";
      view.zoom = null;
    });
  }

  function run() {
    setView(() => (view.text = draftText));
  }

  function quick(query: QuickQuery) {
    if ("order" in query) {
      order = query.order;
      return;
    }
    if ("kind" in query) {
      setView(() => (view.kind = query.kind));
      return;
    }
    draftText = query.text;
    setView(() => (view.text = query.text));
  }

  // A filter from the sheet or the Fields list keeps the open call open: the reader goes on from it.
  function addChip(term: AppCallTerm) {
    view.chips = withChip(view.chips, term);
    limit = CALL_FIRST_PAGE;
  }

  function toggleColumn(field: CallFieldName) {
    const index = columns.indexOf(field);
    if (index === -1) columns.push(field);
    else columns.splice(index, 1);
  }

  function askAgent(call: CallFixFacts) {
    openChatDraft(workspace, "click", { serverId, prompt: callFixPrompt(app, call) });
  }

  // `/` finds in the calls in view while the keyboard is in the section, as the list pages do.
  function onSectionKey(event: KeyboardEvent) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select"))) return;
    event.preventDefault();
    searchField?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex min-w-0 flex-col gap-7" data-testid="app-activity" onkeydown={onSectionKey}>
  <CallQueryBar
    kind={view.kind}
    text={draftText}
    applied={view.text}
    range={view.range}
    chips={view.chips}
    {count}
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
      {columns}
      {groupByRun}
      p95Ms={stats?.p95Ms ?? null}
      liveVersion={app.activeVersion}
      {onOpenRun}
      onAskAgent={askAgent}
      onFilter={addChip}
      onToggleColumn={toggleColumn}
      summary={callsSummary(shownCalls, limit)}
      isStale={isRefreshing}
      {empty}
      onLoadMore={calls && canShowMoreCalls(calls, limit) ? () => (limit = CALL_FULL_PAGE) : undefined}
      aside={showsFields ? fieldsList : undefined}
      {noRows}
    >
      {#snippet toolbar()}
        <!-- The narrowing band of the list pages: the count, the search field, the toggle chips, and Filters. -->
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <h3 class="m-0 flex shrink-0 items-baseline gap-2 pr-1.5 text-sm font-normal">
            <span class="font-medium tabular-nums text-foreground">{shownCalls.length.toLocaleString()}</span>
            <span class="text-(--solus-text-tertiary)">{shownCalls.length === 1 ? "call" : "calls"}</span>
          </h3>
          <label class="{FILTER_SEARCH_FIELD} min-w-40">
            <SearchIcon size={14} class={FILTER_SEARCH_ICON} aria-hidden="true" />
            <input bind:this={searchField} class={FILTER_SEARCH_INPUT} placeholder="Find in these calls…" aria-label="Find in these calls" bind:value={rowFilter} />
            <kbd class="{FILTER_SEARCH_KEYCAP} font-mono text-[11px] pointer-coarse:hidden">/</kbd>
          </label>
          <button type="button" class="{FILTER_CHIP} {showsFields ? FILTER_CHIP_ON : FILTER_CHIP_OFF}" aria-pressed={showsFields} onclick={() => (showsFields = !showsFields)}>
            <FieldsIcon size={14} aria-hidden="true" />Fields
          </button>
          <button type="button" class="{FILTER_CHIP} {groupByRun ? FILTER_CHIP_ON : FILTER_CHIP_OFF}" aria-pressed={groupByRun} onclick={() => (groupByRun = !groupByRun)}>
            <GroupIcon size={14} aria-hidden="true" /><span class="@max-[40rem]/pane:hidden">Group by run</span>
          </button>
          <ListFilterMenu
            activeCount={filterCount}
            onClear={() =>
              setView(() => {
                view.kind = "";
                view.outcome = "";
              })}
          >
            {@render choiceGroup("Kind", CALL_KIND_CHOICES, view.kind, (value) => setView(() => (view.kind = CALL_KIND_CHOICES.find((choice) => choice.value === value)?.value ?? "")))}
            {@render choiceGroup("Outcome", OUTCOME_CHOICES, view.outcome, (value) => setView(() => (view.outcome = OUTCOME_CHOICES.find((choice) => choice.value === value)?.value ?? "")))}
          </ListFilterMenu>
        </div>
      {/snippet}
    </CallRows>
  {:else}
    <ManageSectionState {serverId} {app} count={undefined} error={callsError} empty={ACTIVITY_EMPTY} onRetry={() => void appsStore.calls.load(serverId, app.id)}>
      {#snippet children()}{/snippet}
    </ManageSectionState>
  {/if}
</div>

<!-- No call in view: a blank slate for an empty range, no medallion when filters hide every call. -->
{#snippet noRows()}
  {@const isNarrowed = rowFilter.trim() !== "" || view.zoom !== null || isActivityFiltered(view)}
  <PageEmpty icon={isNarrowed ? undefined : ACTIVITY_EMPTY.icon} compact title={isNarrowed ? "No calls match" : activityEmptyTitle(view.range)}>
    {isNarrowed ? empty : ACTIVITY_EMPTY.description}
    {#snippet actions()}
      {#if isNarrowed}<button type="button" class={PAGE_SECONDARY_BTN} onclick={clearFilters}>Clear filters</button>{/if}
      {#if view.range === "hour" || view.range === "day"}
        <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => setView(() => { view.range = "week"; view.zoom = null; })}>Last 7 days</button>
      {/if}
    {/snippet}
  </PageEmpty>
{/snippet}

<!-- The Kibana field list: the columns of the rows, then the fields available. -->
{#snippet fieldsList()}
  <CallFields calls={shownCalls ?? []} {columns} onFilter={addChip} onToggleColumn={toggleColumn} />
{/snippet}

{#snippet choiceGroup(label: string, choices: { value: string; label: string }[], value: string, onChoose: (value: string) => void)}
  <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      <span class="max-w-28 truncate text-muted-foreground">{choices.find((choice) => choice.value === value)?.label ?? ""}</span>
    </DropdownMenu.SubTrigger>
    <DropdownMenu.SubContent class="w-48">
      <DropdownMenu.RadioGroup {value} onValueChange={onChoose}>
        {#each choices as choice (choice.value)}
          <DropdownMenu.RadioItem value={choice.value}>{choice.label}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.SubContent>
  </DropdownMenu.Sub>
{/snippet}
