<script lang="ts">
  import type { Snippet } from "svelte";
  import { createColumnHelper, createTable, functionalUpdate, type ColumnVisibilityState, type SvelteTable } from "@tanstack/svelte-table";
  import { Sparkles as ModelIcon } from "@lucide/svelte";
  import type { AppCallDetail, AppCallView, AppWebhookView } from "@solus/contracts/apps";
  import DataTableEmptyState from "../../insights/data-table/DataTableEmptyState.svelte";
  import DataTableSortIcon from "../../insights/data-table/DataTableSortIcon.svelte";
  import { insightsTableFeatures, type InsightsTableFeatures } from "../../insights/data-table/data-table-features";
  import { hasTextSelection } from "../../insights/data-table/table-pointer";
  import { spansMultipleDays } from "../../insights/lib/format";
  import { Button } from "../../ui/button";
  import * as Table from "../../ui/table";
  import CallDetail from "./CallDetail.svelte";
  import ModelCallDetail from "./ModelCallDetail.svelte";
  import { appTime, callOutcomeLabel, callerText, versionLabel } from "../lib/app-view";
  import {
    CALL_COLUMN_CHOICES,
    CALL_LIST_STEP,
    DEFAULT_CALL_COLUMNS,
    callClockText,
    callColumnFits,
    callDurationText,
    callMillisText,
    callOrderOf,
    callRunGroups,
    callRunText,
    callSortOf,
    orderedCalls,
    type CallColumn,
    type CallOrder,
    type CallRunGroup,
  } from "./lib/activity";

  /**
   * The call log as the Insights data table, plain on the page (docs/plans/apps.md
   * §9.2): one row for each call, with when it started and the columns chosen.
   * The Time and Duration heads set the order. A row opens the call under it,
   * in the same tinted block; one call is open at a time. The arrow keys move
   * between rows. The Activity section gives it a toolbar, which gets the
   * table for its Columns menu; a run's log has none.
   */
  interface Props {
    serverId: string;
    appId: string;
    /** The newest first. */
    calls: readonly AppCallView[];
    /** The webhooks of the app: a webhook caller goes by its declared name. */
    webhooks: AppWebhookView[];
    openCallId: string | null;
    onOpenRun?: (runId: string) => void;
    onAskAgent?: (call: AppCallDetail) => void;
    columns?: CallColumn[];
    order?: CallOrder;
    /** The rows stand under the run they belong to. */
    groupByRun?: boolean;
    /** The controls above the head. */
    toolbar?: Snippet<[SvelteTable<InsightsTableFeatures, AppCallView>]>;
    /** What the table says of its rows: how many, how many failed. */
    summary?: string;
    /** The rows are an older answer, dimmed until the host answers the new query. */
    isStale?: boolean;
    /** What the table says when it has no row. */
    empty?: string;
    /** Asks the host for a larger read. Absent when the host holds no more calls than the table has. */
    onLoadMore?: () => void;
  }
  let {
    serverId,
    appId,
    calls,
    webhooks,
    openCallId = $bindable(),
    onOpenRun,
    onAskAgent,
    columns = $bindable([...DEFAULT_CALL_COLUMNS]),
    order = $bindable("newest"),
    groupByRun = false,
    toolbar,
    summary,
    isStale = false,
    empty = "No call is in view.",
    onLoadMore,
  }: Props = $props();

  let shownCount = $state(CALL_LIST_STEP);
  let logWidth = $state(0);

  const columnHelper = createColumnHelper<InsightsTableFeatures, AppCallView>();
  const tableColumns = columnHelper.columns([
    columnHelper.accessor("startedAt", { id: "time", header: "Time", sortDescFirst: true, enableHiding: false }),
    ...CALL_COLUMN_CHOICES.map((choice) =>
      choice.value === "duration"
        ? columnHelper.accessor((call) => call.durationMs ?? undefined, { id: "duration", header: choice.label, sortDescFirst: true })
        : columnHelper.accessor((call) => call.id, { id: choice.value, header: choice.label, enableSorting: false }),
    ),
  ]);

  const data = $derived([...calls]);
  const visibility = $derived<ColumnVisibilityState>(Object.fromEntries(CALL_COLUMN_CHOICES.map((choice) => [choice.value, columns.includes(choice.value)])));

  // The table holds no state of its own: the order and the columns are the section's, and the rows are drawn from `calls`.
  const dataTable = createTable({
    features: insightsTableFeatures,
    get data() {
      return data;
    },
    columns: tableColumns,
    manualSorting: true,
    enableSortingRemoval: false,
    state: {
      get sorting() {
        return [callSortOf(order)];
      },
      get columnVisibility() {
        return visibility;
      },
    },
    onSortingChange: (updater) => {
      order = callOrderOf(functionalUpdate(updater, [callSortOf(order)])[0]);
    },
    onColumnVisibilityChange: (updater) => {
      const next = functionalUpdate(updater, visibility);
      columns = CALL_COLUMN_CHOICES.map((choice) => choice.value).filter((column) => next[column] !== false);
    },
  });

  // The columns chosen, less the ones a narrow log drops. Hidden in script rather than by a
  // container query, so the open call's cell spans exactly the columns drawn.
  const shownColumns = $derived(dataTable.getVisibleLeafColumns().filter((column) => callColumnFits(column.id, logWidth)));
  const withDay = $derived(spansMultipleDays(calls.map((call) => call.startedAt)));
  const ordered = $derived(orderedCalls(calls, order));
  // An open call stays in view: a point of the chart can open a call past the rows drawn.
  const openIndex = $derived(openCallId === null ? -1 : ordered.findIndex((call) => call.id === openCallId));
  const shown = $derived(ordered.slice(0, Math.max(shownCount, openIndex + 1)));
  const hasHiddenRows = $derived(ordered.length > shown.length);
  const groups = $derived<CallRunGroup[]>(shown.length === 0 ? [] : groupByRun ? callRunGroups(shown) : [{ runId: null, workflow: null, calls: [...shown] }]);

  function toggle(callId: string) {
    openCallId = openCallId === callId ? null : callId;
  }

  function onRowKey(event: KeyboardEvent & { currentTarget: HTMLElement }, callId: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle(callId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(event.currentTarget.closest("[data-call-list]")?.querySelectorAll<HTMLElement>("[data-call-row]") ?? [])];
    const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function showMore() {
    if (hasHiddenRows) shownCount += CALL_LIST_STEP;
    else onLoadMore?.();
  }
</script>

<section class="flex min-w-0 flex-col gap-3" aria-label="Calls" data-testid="app-calls" bind:clientWidth={logWidth}>
  {@render toolbar?.(dataTable)}

  <div class="min-w-0" data-call-list>
    <Table.Root containerClass="overflow-visible rounded-none border-0 bg-transparent shadow-none dark:bg-transparent" class="min-w-full border-separate border-spacing-0 [&_td]:bg-none">
      <Table.Header class="shadow-[inset_0_-0.5px_0_var(--hairline-strong)]">
        <Table.Row class="border-0 hover:bg-transparent">
          {#each shownColumns as column (column.id)}
            {@const sorted = column.getIsSorted()}
            {@const label = typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
            <Table.Head
              class="px-3 {column.id === 'time'
                ? 'w-32 min-w-32'
                : column.id === 'operation'
                  ? 'w-[38%] max-w-0'
                  : column.id === 'caller'
                    ? 'w-[22%] max-w-0'
                    : column.id === 'run'
                      ? 'w-[30%] max-w-0'
                      : column.id === 'duration'
                        ? 'w-24 min-w-24 text-right'
                        : 'w-24 min-w-24'}"
              aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
            >
              {#if column.getCanSort()}
                <button
                  type="button"
                  class="group/sort flex h-9 w-full cursor-pointer items-center gap-1 uppercase outline-none transition-colors hover:text-foreground focus-visible:text-foreground {sorted ? 'text-foreground' : ''}"
                  class:flex-row-reverse={column.id === "duration"}
                  onclick={column.getToggleSortingHandler()}
                >
                  <span class="truncate">{label}</span>
                  <DataTableSortIcon direction={sorted} />
                </button>
              {:else}
                <span class="block truncate">{label}</span>
              {/if}
            </Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <!-- The app disables selection at the root, so the rows opt back in: a reader must be able to drag an error out of the log. -->
      <Table.Body class={["select-text motion-safe:transition-opacity", isStale && "opacity-55"]} aria-busy={isStale}>
        {#each groups as group (group.runId ?? "")}
          {#if groupByRun}
            <Table.Row class="h-10 border-0 bg-[color-mix(in_oklch,var(--wash-1)_74%,var(--background))] shadow-[inset_0_-0.5px_0_var(--hairline),inset_0_0.5px_0_var(--hairline)] hover:bg-[color-mix(in_oklch,var(--wash-1)_74%,var(--background))]">
              <Table.Cell colspan={shownColumns.length} class="px-3 py-0 text-insights-table">
                <span class="flex min-w-0 items-center gap-3">
                  {#if group.runId}
                    <span class="truncate font-mono text-xs text-foreground">{group.runId}</span>
                    <span class="truncate text-muted-foreground">{group.workflow}</span>
                  {:else}
                    <span class="truncate text-muted-foreground">Not in a run</span>
                  {/if}
                  <span class="shrink-0 tabular-nums text-muted-foreground">{group.calls.length === 1 ? "1 call" : `${group.calls.length} calls`}</span>
                  {#if group.runId && onOpenRun}
                    {@const runId = group.runId}
                    <Button size="xs" variant="ghost" class="ml-auto" onclick={() => onOpenRun(runId)}>Open run</Button>
                  {/if}
                </span>
              </Table.Cell>
            </Table.Row>
          {/if}
          {#each group.calls as call (call.id)}
            {@const isOpen = openCallId === call.id}
            {@const isFailed = call.outcome === "failed"}
            <Table.Row
              class="h-10 cursor-pointer border-0 outline-none transition-[background-color] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) {isOpen
                ? `[&>td:first-child]:rounded-tl-xl [&>td:last-child]:rounded-tr-xl ${isFailed ? '[&>td]:bg-[color-mix(in_oklch,var(--failure)_8%,transparent)]' : '[&>td]:bg-[var(--wash-2)]'}`
                : 'shadow-[inset_0_-0.5px_0_var(--hairline)] hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)]'}"
              tabindex={0}
              aria-expanded={isOpen}
              aria-label="{call.operation}, {callOutcomeLabel(call.outcome)}, {callDurationText(call)}"
              data-call-row
              data-testid="app-call-row"
              onclick={() => {
                if (!hasTextSelection()) toggle(call.id);
              }}
              onkeydown={(event: KeyboardEvent & { currentTarget: HTMLElement }) => onRowKey(event, call.id)}
            >
              {#each shownColumns as column (column.id)}
                {#if column.id === "time"}
                  <Table.Cell class="truncate px-3 py-0 text-insights-table tabular-nums text-foreground" title="{new Date(call.startedAt).toLocaleString()} · {appTime(call.startedAt)}">
                    {callClockText(call.startedAt, withDay)}<span class="text-muted-foreground/60">{callMillisText(call.startedAt)}</span>
                  </Table.Cell>
                {:else if column.id === "operation"}
                  <Table.Cell class="max-w-0 px-3 py-0 text-insights-table text-foreground">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <!-- A model call goes by its model setting, marked so it does not read as an operation. -->
                      {#if call.kind === "model"}
                        <ModelIcon size={14} strokeWidth={1.5} class="shrink-0 text-muted-foreground" aria-label="Model call" />
                      {/if}
                      <span class="truncate">{call.operation}</span>
                    </span>
                  </Table.Cell>
                {:else if column.id === "caller"}
                  <Table.Cell class="max-w-0 truncate px-3 py-0 text-insights-table text-muted-foreground">{callerText(call.caller, webhooks)}</Table.Cell>
                {:else if column.id === "run"}
                  {@const runText = callRunText(call)}
                  <Table.Cell class="max-w-0 truncate px-3 py-0 text-insights-table text-muted-foreground" title={runText ?? undefined}>{runText ?? "–"}</Table.Cell>
                {:else if column.id === "outcome"}
                  <Table.Cell class="truncate px-3 py-0 text-insights-table {isFailed ? 'text-(--failure)' : 'text-muted-foreground'}">{callOutcomeLabel(call.outcome)}</Table.Cell>
                {:else if column.id === "version"}
                  <Table.Cell class="truncate px-3 py-0 text-insights-table tabular-nums text-muted-foreground">{versionLabel(call.version)}</Table.Cell>
                {:else if column.id === "duration"}
                  <Table.Cell class="truncate px-3 py-0 text-right text-insights-table tabular-nums {isFailed ? 'text-(--failure)' : 'text-foreground'}">{callDurationText(call)}</Table.Cell>
                {/if}
              {/each}
            </Table.Row>
            {#if isOpen}
              <Table.Row class="border-0 hover:bg-transparent">
                <Table.Cell
                  colspan={shownColumns.length}
                  class="rounded-b-xl p-0 whitespace-normal {isFailed ? 'bg-[color-mix(in_oklch,var(--failure)_8%,transparent)]' : 'bg-[var(--wash-2)]'}"
                >
                  {#if call.kind === "model"}
                    <ModelCallDetail {serverId} {appId} callId={call.id} />
                  {:else}
                    <CallDetail {serverId} {appId} callId={call.id} {webhooks} {onOpenRun} {onAskAgent} tinted={false} />
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        {:else}
          <Table.Row class="border-0 hover:bg-transparent">
            <Table.Cell colspan={Math.max(1, shownColumns.length)} class="p-0 whitespace-normal">
              <DataTableEmptyState filtered={false} title="No calls" description={empty} />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>

    {#if summary || hasHiddenRows || onLoadMore}
      <footer class="flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-1.5 text-insights-chrome text-muted-foreground">
        <span class="min-w-0 truncate tabular-nums" role="status">{summary ?? ""}</span>
        {#if hasHiddenRows || onLoadMore}
          <Button size="xs" variant="ghost" class="text-muted-foreground hover:text-foreground" onclick={showMore}>Show more</Button>
        {/if}
      </footer>
    {/if}
  </div>
</section>
