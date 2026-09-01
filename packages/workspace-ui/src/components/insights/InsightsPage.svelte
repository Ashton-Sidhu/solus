<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { fly } from "svelte/transition";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { getWorkspaceContext, runtime, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { toasts } from "../../lib/toasts";
  import type {
    MetricsTurnSortField,
    SavedMetricsQuery,
  } from "@solus/contracts/observability-types";
  import { findOpenTabForSession } from "../../lib/sessionUtils";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import { PageCrumbLine } from "../ui/list-page";
  import { formatRowCount } from "./lib/format";
  import { presetsFor, type InsightsPreset } from "./lib/insights-queries";
  import { rangeHeading, type TimeRange } from "./lib/time-range";
  import type { SqlEditorSources } from "./lib/sql-editor-extensions";
  import {
    eventPoints,
    eventsWithinSelection,
    resultRendering,
    toEventTable,
  } from "./lib/result-shape";
  import { labelForKind } from "./lib/span-palette";
  import {
    railIndexOf,
    railItemsFromEvents,
    railItemsFromTurns,
    type RailItem,
  } from "./lib/rail";
  import {
    toTurnRows,
    withStatus,
    type TurnRow,
    type TurnSort,
    type TurnSortKey,
    type TurnStatusFilter,
  } from "./lib/turn-rows";
  import {
    turnPoints,
    volumeWindow,
    withinSelection,
    type TimeSelection,
  } from "./lib/volume";
  import { insightsStore, type QueryForm, type QueryRunRecord } from "./insights.store.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import EventList from "./EventList.svelte";
  import InsightsRail from "./InsightsRail.svelte";
  import InsightsResultSkeleton from "./InsightsResultSkeleton.svelte";
  import QueryConsole from "./QueryConsole.svelte";
  import ResultRankingChart from "./ResultRankingChart.svelte";
  import ResultTable from "./ResultTable.svelte";
  import SaveQueryDialog from "./SaveQueryDialog.svelte";
  import SchemaSheet from "./SchemaSheet.svelte";
  import ResultTrendChart from "./ResultTrendChart.svelte";
  import TurnDetailPanel from "./TurnDetailPanel.svelte";
  import TurnList from "./TurnList.svelte";
  import VolumeChart from "./VolumeChart.svelte";

  /**
   * Insights — the query surface over `metrics.db`.
   *
   * One console asks the question, one histogram states the shape of the window
   * it was asked in, and one list answers it. Nothing here fetches: the store
   * owns the registry, the caches, and every run, so a deep link into a turn and
   * a click from this list cost the same.
   *
   * A turn opens the way a pull request does: its detail panel comes out from
   * the side while the listing compresses to a rail on the left, so the answer
   * stays readable while one row is being read. The open turn lives in the
   * route's params — that is what makes it deep-linkable.
   *
   * `metrics.db` is host-local — each host records its own runs — so the page
   * follows the active host and clears rather than mixing two machines' spans.
   */
  let { params, paneId }: RouteSurfaceProps<"insights"> = $props();

  const workspace = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const store = insightsStore;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const open = $derived(workspace.router.at("insights"));
  const serverId = $derived(serverConnections.resolveId(serversStore.activeServerId));
  /** Composing a query on a phone is not a workflow worth its cost: mobile gets
   *  presets and saved queries, read-only (approved exception, docs/plans). */
  const readOnly = $derived(runtime.isMobileViewport);

  let selection = $state<TimeSelection | null>(null);
  /** The measure the reader charted, where they overrode the one the answer's
   *  own shape picked. Ephemeral: it names a column of the result on screen,
   *  and means nothing once a different question has been asked. */
  let measure = $state<string | undefined>(undefined);
  let statusFilter = $state<TurnStatusFilter | null>(null);
  let grouped = $state(false);
  let sort = $state<TurnSort>({ key: "startedAt", dir: "desc" });
  let schemaRevision = $state(0);
  let loaded = $state(false);
  let schemaOpen = $state(false);
  let saveQueryOpen = $state(false);
  /** Query charts stay mounted when hidden so expanding one does not rebuild
   *  the chart or lose its hover state. The result table remains available. */
  let queryChartExpanded = $state(true);
  let queryConsole = $state<ReturnType<typeof QueryConsole> | null>(null);

  const TURN_SORT_FIELDS = {
    startedAt: "started_at",
    durationMs: "duration_ms",
    costUsd: "cost_usd",
    tokens: "tokens",
    model: "model",
    sessionId: "session_id",
    prompt: "prompt",
  } as const satisfies Record<TurnSortKey, MetricsTurnSortField>;

  $effect(() => {
    store.useHost(serverId);
  });

  // The page loads once per host, on entry. Re-entering re-asks the question
  // already on screen rather than replacing it with the default one — but it
  // does re-ask it, because the histogram is re-read on the same entry and the
  // two must describe the same window.
  $effect(() => {
    if (!open || loaded) return;
    loaded = true;
    void store.load().then(() => (schemaRevision += 1));
  });

  $effect(() => {
    if (!open) loaded = false;
  });

  // Closing the page ends the question it was asking: the next entry opens on
  // the default listing, not on the answer and history of the last visit.
  // Moving the page to the other pane destroys this surface too, and that is
  // not a close — the destination still shows insights, so it keeps its query.
  onDestroy(() => {
    if (!workspace.router.at("insights")) store.reset();
  });

  const rows = $derived(toTurnRows(store.result));
  const pagedTurns = $derived(store.hasPagedTurnListing);
  /** Which of the five renderings this answer uses. */
  const rendering = $derived(resultRendering(store.result, store.schema, measure));
  const eventTable = $derived(
    rendering.rendering === "events" && store.result
      ? toEventTable(store.result)
      : null,
  );
  const visibleRows = $derived(
    pagedTurns ? rows : withinSelection(rows, selection),
  );
  const visibleEventRows = $derived(
    eventTable ? eventsWithinSelection(eventTable.rows, selection) : [],
  );

  // ── The histogram ──
  // It counts the answer: a turn listing counts turns, an event listing counts
  // spans of that kind, and its brush narrows those same rows. An answer with
  // no rows to count keeps turn volume as the context it is missing from.
  //
  // An answer that lists nothing at all — a rollup, a trend — has no histogram:
  // a bar chart of turns beside a question about spend per model counts
  // something nobody asked about, and its brush would narrow nothing.
  const listsRows = $derived(rendering.rendering === "turns" || rendering.rendering === "events");
  const showVolume = $derived(listsRows || !store.result);
  // The status chips are a filter on the same answer, and they sit under the
  // bars that count it — so the bars follow them.
  const answerPoints = $derived(
    rendering.rendering === "events" && eventTable
      ? eventPoints(eventTable.rows)
      : rendering.rendering === "turns" && !pagedTurns
        ? turnPoints(withStatus(rows, statusFilter))
        : [],
  );
  const chartPoints = $derived(
    answerPoints.length > 0 ? answerPoints : turnPoints(store.volumeRows),
  );
  const chartCountLabel = $derived(
    answerPoints.length > 0 && rendering.rendering === "events"
      ? labelForKind(rendering.kind) || rendering.view.replace(/_/g, " ")
      : "Turns",
  );
  const chartWindow = $derived(volumeWindow(chartPoints, store.windowFrom, store.windowTo));
  const chartHeading = $derived(
    chartWindow.coversRange
      ? rangeHeading(store.range, chartCountLabel)
      : `${chartCountLabel} in this result`,
  );

  // A selection names instants in a histogram the answer no longer has; kept,
  // it would narrow the next listing from a control nobody can see.
  $effect(() => {
    if (!showVolume) selection = null;
  });

  const presets = $derived(presetsFor(store.form, store.range));

  const resultNote = $derived(
    store.bootstrapping && !store.running
      ? "Loading…"
      : store.running
        ? store.compiling
          ? "Compiling the question…"
          : "Running…"
        : store.error
          ? "Query failed"
          : store.result
            ? `${formatRowCount(store.turnPage?.totalRows ?? store.result.rows.length)} · ${store.lastRunMs} ms${
                store.answerWindowStale ? " · asked over the previous range — run again" : ""
              }`
            : "No query has run yet",
  );

  /** A run with no earlier answer to keep on screen — the page's first one, or
   *  the first after a host change. The chart and the list have nothing to draw
   *  yet, and an empty listing there would state that the host records nothing
   *  rather than that the answer is still coming. A re-run keeps its answer, so
   *  this never flashes over rows the reader is already reading.
   *
   *  It starts at the opening load, not at the statement: the registry and the
   *  saved queries are read first, and gating on `running` alone left that gap
   *  showing a real empty page between the pane's loading cover and this one. */
  const awaitingFirstAnswer = $derived(
    (store.running || store.bootstrapping) && !store.result,
  );

  const emptyHint = $derived(
    selection
      ? "The selected window is empty — clear it or widen the range."
      : statusFilter
        ? "Loosen the status filter."
        : "Metrics start when a version that records them runs; there is no backfill.",
  );

  const sources: SqlEditorSources = {
    schema: () => store.schema,
    cachedValues: (column) => store.cachedValues(column),
    requestValues: (column) => store.requestValues(column),
    validate: (sql) => store.validateSql(sql),
  };

  function run(form: QueryForm = store.form): void {
    if (form === "nl") void store.compileAndRun(workspace.ctx, store.question);
    else void store.runSql(store.sqlText);
  }

  function applyPreset(preset: InsightsPreset): void {
    if (preset.form === "nl") {
      store.form = "nl";
      store.question = preset.text;
      run();
    } else {
      // Preset SQL is Solus's own, so it is remembered by id and re-emitted at
      // whatever range is selected next rather than frozen at today's text.
      void store.runGenerated({ kind: "preset", presetId: preset.id });
    }
  }

  function applySaved(query: SavedMetricsQuery): void {
    if (query.form === "sql" && query.sql) {
      store.form = "sql";
      store.setUserSql(query.sql);
      void store.runSql(query.sql);
    } else if (query.spec) {
      void store.runSpec(query.spec);
    }
  }

  function applyHistory(record: QueryRunRecord): void {
    store.form = record.form;
    if (record.form === "nl") store.question = record.text;
    else store.setUserSql(record.text);
    run();
  }

  /** A brush selection names instants inside the old window; keeping it across
   *  a range change would filter the new answer to a window it does not cover. */
  function changeRange(next: TimeRange): void {
    selection = null;
    void store.setRange(next);
  }

  function changeSelection(next: TimeSelection | null): void {
    selection = next;
    if (pagedTurns) void store.setTurnSelection(next);
  }

  function changeTurnSort(next: TurnSort): void {
    sort = next;
    if (pagedTurns) {
      void store.setTurnSort({ field: TURN_SORT_FIELDS[next.key], dir: next.dir });
    }
  }

  function changeTurnStatus(next: TurnStatusFilter | null): void {
    statusFilter = next;
    if (pagedTurns) void store.setTurnStatus(next);
  }

  async function saveCurrent(name: string): Promise<void> {
    try {
      await store.saveCurrent(name);
      saveQueryOpen = false;
      toasts.success(`Saved “${name}”`);
    } catch (cause) {
      toasts.error(cause instanceof Error ? cause.message : "Could not save the query");
    }
  }

  /** The session id a span carries is Solus's own, so an open conversation is
   *  focused rather than opened a second time. A closed one is resumed from its
   *  indexed record: a span stores the session id, not its agent backend, and
   *  loading a Claude transcript through Codex returns an empty conversation. */
  async function openSession(sessionId: string): Promise<void> {
    const openTab = findOpenTabForSession(
      sessionId,
      workspace.tabs,
      workspace.sessions,
      workspace.tabOrder,
      undefined,
      serverId,
    );
    if (openTab) {
      workspace.selectTab(openTab);
      return;
    }
    const meta = await readSessionMeta(serverId, sessionId);
    if (meta) await workspace.resumeSession(meta);
    else toasts.error("That session is no longer on this host");
  }

  // ── The schema sheet ──
  // Reading the model and writing the query are one act, so the way out of the
  // sheet lands in the SQL tab with the column already at the cursor.
  async function insertColumn(name: string): Promise<void> {
    schemaOpen = false;
    store.form = "sql";
    // The editor mounts with the SQL tab, so the cursor exists only after the
    // form change has been applied.
    await tick();
    queryConsole?.insertIntoSql(name);
  }

  // ── The detail panel ──
  // The open turn is the route's params, so a row click, a span drill, and a
  // deep link from anywhere all land in the same place. The panel comes out
  // beside the list; below the width where both fit it covers the list instead.
  const openTraceId = $derived(params.traceId ?? null);
  const openSpanId = $derived(params.spanId ?? null);
  const panelOpen = $derived(openTraceId !== null);

  let pageWidth = $state(0);
  /** The reader's choice; forgotten when the panel closes. */
  let panelFullScreenChoice = $state(false);
  const roomForSplit = $derived(pageWidth >= 1040);
  const panelFullScreen = $derived(panelOpen && (panelFullScreenChoice || !roomForSplit));
  const splitList = $derived(panelOpen && !panelFullScreen);

  /** The rows the rail shows and the panel's stepper walks — the current
   *  answer's own order, turn- or span-grained to match its shape. */
  const railItems = $derived(
    rendering.rendering === "events" && eventTable
      ? railItemsFromEvents(eventTable.columns, visibleEventRows, rendering.kind)
      : railItemsFromTurns(visibleRows),
  );
  const railIndex = $derived(railIndexOf(railItems, openTraceId, openSpanId));
  /** What the current answer lists — the breadcrumb crumb and the rail heading
   *  are the same word, because they name the same set of rows. */
  const listLabel = $derived(
    rendering.rendering === "events"
      ? "Events"
      : rendering.rendering === "turns" || !store.result
        ? "Turns"
        : "Results",
  );

  function openRailItem(item: RailItem): void {
    workspace.openInsightsTurn(item.traceId, item.spanId ?? undefined);
  }

  function openTurn(row: TurnRow): void {
    workspace.openInsightsTurn(row.traceId);
  }

  /** An event row's drill path: the turn's waterfall, landed on this span. */
  function openSpan(traceId: string, spanId: string | null): void {
    workspace.openInsightsTurn(traceId, spanId ?? undefined);
  }

  /** Step to the row before or after the open one, in the rail's own order. */
  function stepPanel(delta: number): void {
    if (railIndex === -1 || railItems.length === 0) return;
    const next = railItems[(railIndex + delta + railItems.length) % railItems.length];
    if (next) openRailItem(next);
  }

  function closePanel(): void {
    panelFullScreenChoice = false;
    workspace.openInsights();
  }

  function closePage(): void {
    workspace.router.close("insights");
    requestInputFocus();
  }

  function toggleFullScreen(): void {
    panelFullScreenChoice = !panelFullScreenChoice;
  }

  useScope("insights", { active: () => open });
  // Esc walks back one step at a time: naming and schema sheets close first,
  // then full screen collapses to the split, then the split closes to the list,
  // and only the bare list closes the page.
  useKeybinding(
    "insights.close",
    () => {
      if (saveQueryOpen) {
        saveQueryOpen = false;
        return;
      }
      if (schemaOpen) {
        schemaOpen = false;
        return;
      }
      if (panelOpen) {
        if (panelFullScreenChoice && roomForSplit) panelFullScreenChoice = false;
        else closePanel();
        return;
      }
      closePage();
    },
    { enabled: () => open },
  );
  useKeybinding("insights.natural-language", () => (store.form = "nl"), { enabled: () => open });
  useKeybinding("insights.sql", () => (store.form = "sql"), { enabled: () => open });
  useKeybinding("insights.refresh", () => void store.refresh(), { enabled: () => open });
  useKeybinding(
    "insights.schema",
    () => {
      schemaOpen = !schemaOpen;
    },
    { enabled: () => open },
  );
</script>

<!-- A result carries several measures and the chart draws one. Which one it
     drew is the heading, and the heading is the control that changes it — the
     answer names itself rather than hiding the choice in a toolbar. The pick
     is by column name, so re-running the same question keeps it and asking a
     different one silently falls back to that answer's own preference. -->
{#snippet measureHeading(current: string, measures: string[], detail: string, chartId: string)}
  <header class="flex items-baseline gap-2">
    <h2 class="text-insights-summary font-semibold">
      {#if measures.length > 1}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="-mx-1 flex cursor-pointer items-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--wash-1)]"
            title="Chart another measure"
          >
            {current}
            <CaretDownIcon size={10} weight="bold" class="opacity-50" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" class="min-w-40">
            {#each measures as name (name)}
              <DropdownMenu.Item onSelect={() => (measure = name)}>
                <span class:font-semibold={name === current}>{name}</span>
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        {current}
      {/if}
    </h2>
    <span class="text-insights-summary text-muted-foreground">{detail}</span>
    <button
      type="button"
      class="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-md text-insights-summary text-muted-foreground transition-[background-color,color,scale] hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-10 [.is-laptop-display_&]:size-5.5"
      aria-label={queryChartExpanded ? "Collapse chart" : "Expand chart"}
      aria-controls={chartId}
      aria-expanded={queryChartExpanded}
      title={queryChartExpanded ? "Collapse chart" : "Expand chart"}
      onclick={() => (queryChartExpanded = !queryChartExpanded)}
    >
      <CaretDownIcon
        class="size-[1em] transition-transform {queryChartExpanded ? 'rotate-180' : ''}"
        aria-hidden="true"
      />
    </button>
  </header>
{/snippet}

<!-- The console owns the question's controls — the range lives on it. The head
     keeps only the way back to the default question. -->
{#snippet resetAction()}
  <button
    type="button"
    class="h-6 shrink-0 cursor-pointer rounded-md px-2 text-insights-chrome transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
    title="Back to the default question"
    onclick={() => void store.resetToDefault()}>Reset</button
  >
{/snippet}

<div
  class="relative flex h-full w-full flex-col overflow-hidden bg-background text-insights-chrome text-foreground [--insights-list-width:380px]"
  bind:clientWidth={pageWidth}
>
  <!-- The same crumb line every page head leads with, in this page's own band:
       Insights has no project scope (`metrics.db` is host-local), so the page
       menu is the first segment and the current question is the last. -->
  <header
    class="workspace-titlebar flex h-[calc(var(--solus-chrome-row-h,2.75rem)-0.25rem)] shrink-0 items-center pr-6 pl-[max(1.625rem,var(--solus-chrome-lead-inset,0px))] text-muted-foreground shadow-[inset_0_-0.5px_0_var(--hairline)] pointer-coarse:h-(--solus-chrome-row-h,2.75rem)"
  >
    <PageCrumbLine
      page="insights"
      trailingCrumb={splitList ? undefined : listLabel}
      actions={splitList ? undefined : resetAction}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={closePage}
    />
  </header>

  <!-- Hidden rather than unmounted while the panel is open: the console holds
       a CodeMirror editor and the histogram a chart, and closing the panel must
       not rebuild either or forget the draft being typed. -->
  <div
    class="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3.5 pb-4.5 sm:px-6.5 {splitList
      ? 'hidden'
      : ''}"
  >
    <QueryConsole
      bind:this={queryConsole}
      form={store.form}
      onFormChange={(form: QueryForm) => (store.form = form)}
      question={store.question}
      onQuestionChange={(value) => (store.question = value)}
      sqlText={store.sqlText}
      onSqlChange={(value) => store.setUserSql(value)}
      onRun={run}
      running={store.running}
      range={store.range}
      onRangeChange={changeRange}
      {resultNote}
      {schemaRevision}
      {schemaOpen}
      onOpenSchema={() => (schemaOpen = true)}
      {sources}
      savedQueries={store.savedQueries}
      history={store.history}
      {presets}
      onPreset={applyPreset}
      onSaved={applySaved}
      onDeleteSaved={(id) => void store.deleteSaved(id)}
      onSaveCurrent={() => (saveQueryOpen = true)}
      onHistory={applyHistory}
      {readOnly}
    />

    {#if store.error}
      <p
        class="shrink-0 rounded-lg px-3 py-2 text-insights-chrome leading-relaxed"
        style="background:color-mix(in oklch, var(--failure) 8%, transparent);color:var(--failure)"
        role="alert"
      >
        {store.error}
      </p>
    {/if}

    {#if awaitingFirstAnswer}
      <InsightsResultSkeleton />
    {:else}
      {#if showVolume}
        <VolumeChart
          points={chartPoints}
          aggregateBuckets={pagedTurns ? store.turnPage?.volume : undefined}
          aggregateStats={pagedTurns ? store.turnPage?.stats : undefined}
          heading={chartHeading}
          countLabel={chartCountLabel}
          from={chartWindow.from}
          to={chartWindow.to}
          {selection}
          onSelectionChange={changeSelection}
        />
      {/if}

      {#if rendering.rendering === "turns" || !store.result}
        <TurnList
          rows={visibleRows}
          {sort}
          onSortChange={changeTurnSort}
          {statusFilter}
          onStatusFilterChange={changeTurnStatus}
          {grouped}
          onGroupedChange={(next) => (grouped = next)}
          selectedTraceId={openTraceId}
          onOpenTurn={openTurn}
          onOpenSession={(sessionId) => void openSession(sessionId)}
          {emptyHint}
          totalRows={pagedTurns ? store.turnPage?.totalRows : undefined}
          pageIndex={pagedTurns ? store.turnPageIndex : undefined}
          pageSize={pagedTurns ? store.turnPageSize : undefined}
          onPageChange={pagedTurns ? (page) => void store.setTurnPage(page) : undefined}
          onPageSizeChange={pagedTurns ? (size) => void store.setTurnPageSize(size) : undefined}
          fullStatusCounts={pagedTurns ? store.turnPage?.statusCounts : undefined}
          fullP95DurationMs={pagedTurns ? store.turnPage?.stats.p95DurationMs : undefined}
          search={pagedTurns ? store.turnSearch : undefined}
          onSearchChange={pagedTurns ? (value) => store.setTurnSearch(value) : undefined}
        />
      {:else if rendering.rendering === "events" && eventTable}
        <EventList
          table={eventTable}
          view={rendering.view}
          kind={rendering.kind}
          rows={visibleEventRows}
          onOpenSpan={openSpan}
          {emptyHint}
        />
      {:else if rendering.rendering === "trend"}
        <section
          class="flex shrink-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)] [.is-laptop-display_&]:px-3 [.is-laptop-display_&]:py-2.5"
          aria-label="Trend"
        >
          {@render measureHeading(
            rendering.trend.valueColumn,
            rendering.trend.measures,
            `by ${rendering.trend.timeColumn}${
              rendering.trend.seriesColumn ? `, per ${rendering.trend.seriesColumn}` : ""
            }`,
            `query-trend-chart-${paneId}`,
          )}
          <div id={`query-trend-chart-${paneId}`} hidden={!queryChartExpanded}>
            <ResultTrendChart
              lines={rendering.trend.lines}
              mark={rendering.trend.mark}
              valueFormat={rendering.trend.valueFormat}
              hiddenSeries={rendering.trend.hiddenSeries}
            />
          </div>
        </section>
        <ResultTable result={store.result} />
      {:else if rendering.rendering === "ranking"}
        <section
          class="flex shrink-0 flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)] [.is-laptop-display_&]:px-3 [.is-laptop-display_&]:py-2.5"
          aria-label="Ranking"
        >
          {@render measureHeading(
            rendering.ranking.valueColumn,
            rendering.ranking.measures,
            `by ${rendering.ranking.dimensionColumn}`,
            `query-ranking-chart-${paneId}`,
          )}
          <div id={`query-ranking-chart-${paneId}`} hidden={!queryChartExpanded}>
            <ResultRankingChart
              bars={rendering.ranking.bars}
              valueFormat={rendering.ranking.valueFormat}
              hiddenBars={rendering.ranking.hiddenBars}
            />
          </div>
        </section>
        <ResultTable result={store.result} />
      {:else}
        <ResultTable result={store.result} />
      {/if}
    {/if}
  </div>

  {#if splitList}
    <div class="flex min-h-0 w-(--insights-list-width) flex-1 flex-col">
      <InsightsRail
        items={railItems}
        heading={listLabel}
        selectedIndex={railIndex}
        onOpenItem={openRailItem}
        onOpenSession={(sessionId) => void openSession(sessionId)}
        {emptyHint}
      />
    </div>
  {/if}

  {#if panelOpen && openTraceId}
    <!-- Out of the list's flow on purpose, not just when full screen: it covers
         the room the rail's width leaves rather than claiming its own, so the
         fly is transform and opacity alone and nothing relayouts. -->
    <div
      class="flex flex-col bg-background {panelFullScreen
        ? 'absolute inset-0 z-20'
        : 'absolute inset-y-0 right-0 left-(--insights-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'}"
      transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
    >
      <TurnDetailPanel
        traceId={openTraceId}
        spanId={openSpanId}
        fullScreen={panelFullScreen}
        onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
        {listLabel}
        onClose={closePanel}
        position={railIndex + 1}
        total={railItems.length}
        onStep={stepPanel}
      />
    </div>
  {/if}

  {#if schemaOpen}
    <SchemaSheet
      schema={store.schema}
      onClose={() => (schemaOpen = false)}
      onInsertColumn={(name) => void insertColumn(name)}
      {readOnly}
    />
  {/if}

  {#if saveQueryOpen}
    <SaveQueryDialog
      onClose={() => (saveQueryOpen = false)}
      onSave={saveCurrent}
    />
  {/if}
</div>
