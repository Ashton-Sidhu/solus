<script lang="ts">
  import { serverConnections } from "@client-core/server-connections";
  import { readSessionMeta } from "@client-core/session-meta";
  import { getWorkspaceContext, runtime, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { toasts } from "../../lib/toasts";
  import type { SavedMetricsQuery } from "../../../shared/observability-types";
  import { findOpenTabForSession } from "../../lib/sessionUtils";
  import { formatRowCount } from "./lib/format";
  import { defaultExploreSql, type InsightsPreset } from "./lib/insights-queries";
  import type { SqlEditorSources } from "./lib/sql-editor-extensions";
  import { eventsWithinSelection, resultShape, toEventTable } from "./lib/result-shape";
  import {
    toTurnRows,
    type TurnRow,
    type TurnSort,
    type TurnStatusFilter,
  } from "./lib/turn-rows";
  import { withinSelection, type TimeSelection } from "./lib/volume";
  import { buildTraceView } from "./lib/waterfall";
  import { insightsStore, type QueryForm, type QueryRunRecord } from "./insights.store.svelte";
  import EventList from "./EventList.svelte";
  import QueryConsole from "./QueryConsole.svelte";
  import ResultTable from "./ResultTable.svelte";
  import ResultTrendChart from "./ResultTrendChart.svelte";
  import TurnDrawer from "./TurnDrawer.svelte";
  import TurnList from "./TurnList.svelte";
  import TurnVolumeChart from "./TurnVolumeChart.svelte";

  /**
   * Insights — the query surface over `metrics.db`.
   *
   * One console asks the question, one histogram states the shape of the window
   * it was asked in, and one list answers it. Nothing here fetches: the store
   * owns the registry, the caches, and every run, so a deep link into a turn and
   * a click from this list cost the same.
   *
   * `metrics.db` is host-local — each host records its own runs — so the page
   * follows the active host and clears rather than mixing two machines' spans.
   */
  const workspace = getWorkspaceContext();
  const store = insightsStore;

  const open = $derived(workspace.router.at("insights"));
  const serverId = $derived(serverConnections.resolveId(serversStore.activeServerId));
  /** Composing a query on a phone is not a workflow worth its cost: mobile gets
   *  presets and saved queries, read-only (approved exception, docs/plans). */
  const readOnly = $derived(runtime.isMobileViewport);

  let selection = $state<TimeSelection | null>(null);
  let statusFilter = $state<TurnStatusFilter | null>(null);
  let grouped = $state(false);
  let sort = $state<TurnSort>({ key: "startedAt", dir: "desc" });
  let selectedTraceId = $state<string | null>(null);
  let traceLoading = $state(false);
  let schemaRevision = $state(0);
  let loaded = $state(false);

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

  const rows = $derived(toTurnRows(store.result));
  /** Which of the four result shapes this answer renders as. */
  const shape = $derived(resultShape(store.result, store.schema));
  const eventTable = $derived(
    shape.shape === "events" && store.result
      ? toEventTable(store.result, store.schema, shape.view)
      : null,
  );
  const visibleRows = $derived(withinSelection(rows, selection));
  const visibleEventRows = $derived(
    eventTable ? eventsWithinSelection(eventTable.rows, selection) : [],
  );
  const volumeSelection = $derived(withinSelection(store.volumeRows, selection));

  const selectedIndex = $derived(
    selectedTraceId ? visibleRows.findIndex((row) => row.traceId === selectedTraceId) : -1,
  );
  const selectedTurn = $derived(selectedIndex >= 0 ? visibleRows[selectedIndex] : null);
  const selectedTrace = $derived(
    selectedTraceId ? buildTraceView(store.trace(selectedTraceId)) : null,
  );
  const selectedSession = $derived(
    selectedTurn?.sessionId ? store.sessionSummary(selectedTurn.sessionId) : null,
  );

  const resultNote = $derived(
    store.running
      ? "Running…"
      : store.error
        ? "Query failed"
        : store.result
          ? `${formatRowCount(store.result.rows.length)} · ${store.lastRunMs} ms`
          : "No query has run yet",
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

  function run(): void {
    if (store.form === "nl") void store.compileAndRun(workspace.ctx, store.question);
    else void store.runSql(store.sqlText);
  }

  function applyPreset(preset: InsightsPreset): void {
    if (preset.form === "nl") {
      store.form = "nl";
      store.question = preset.text;
    } else {
      store.form = "sql";
      store.sqlText = preset.text;
    }
    run();
  }

  function applySaved(query: SavedMetricsQuery): void {
    if (query.form === "sql" && query.sql) {
      store.form = "sql";
      store.sqlText = query.sql;
      void store.runSql(query.sql);
    } else if (query.spec) {
      void store.runSpec(query.spec);
    }
  }

  function applyHistory(record: QueryRunRecord): void {
    store.form = record.form;
    if (record.form === "nl") store.question = record.text;
    else store.sqlText = record.text;
    run();
  }

  async function saveCurrent(): Promise<void> {
    const name = globalThis.prompt("Name this query")?.trim();
    if (!name) return;
    try {
      await store.saveCurrent(name);
      toasts.success(`Saved “${name}”`);
    } catch (cause) {
      toasts.error(cause instanceof Error ? cause.message : "Could not save the query");
    }
  }

  function openTurn(row: TurnRow): void {
    selectedTraceId = row.traceId;
    traceLoading = true;
    void store.loadTrace(row.traceId).then(() => (traceLoading = false));
    if (row.sessionId) void store.loadSessionSummary(row.sessionId);
  }

  function stepSelection(delta: number): void {
    const next = visibleRows[selectedIndex + delta];
    if (next) openTurn(next);
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

  function openFullPage(): void {
    if (!selectedTraceId) return;
    workspace.openInsightsTurn(selectedTraceId);
    selectedTraceId = null;
  }

  /** An event row's drill path: the turn's waterfall, landed on this span. */
  function openSpan(traceId: string, spanId: string | null): void {
    workspace.openInsightsTurn(traceId, spanId ?? undefined);
  }

  function resetQuery(): void {
    store.sqlText = defaultExploreSql();
    store.form = "sql";
    void store.runSql(store.sqlText);
  }

  useScope("insights", { active: () => open });
  useKeybinding(
    "insights.close",
    () => {
      if (selectedTraceId) selectedTraceId = null;
      else {
        workspace.router.close("insights");
        requestInputFocus();
      }
    },
    { enabled: () => open },
  );
  useKeybinding("insights.natural-language", () => (store.form = "nl"), { enabled: () => open });
  useKeybinding("insights.sql", () => (store.form = "sql"), { enabled: () => open });
  useKeybinding("insights.refresh", () => void store.refresh(), { enabled: () => open });
</script>

<div class="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
  <header
    class="flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-2 pr-6 pl-[max(1.625rem,var(--solus-chrome-lead-inset,0px))] text-xs text-muted-foreground shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <span class="font-medium text-foreground">Insights</span>
    <span class="opacity-45">/</span>
    <span>Explore turns</span>
    <span class="flex-1"></span>
    <label
      class="flex cursor-pointer items-center gap-1.5 text-[0.625rem] select-none"
      title="Reveal internal.* kinds and the Solus-health presets"
    >
      <input
        type="checkbox"
        class="size-3 accent-(--primary)"
        checked={store.showInternals}
        onchange={(event) => store.setShowInternals(event.currentTarget.checked)}
      />
      Show Solus internals
    </label>
    <button
      type="button"
      class="cursor-pointer rounded px-1.5 py-0.5 text-[0.625rem] transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
      onclick={resetQuery}>Reset</button
    >
  </header>

  <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3.5 pb-4.5 sm:px-6.5">
    <QueryConsole
      form={store.form}
      onFormChange={(form: QueryForm) => (store.form = form)}
      question={store.question}
      onQuestionChange={(value) => (store.question = value)}
      sqlText={store.sqlText}
      onSqlChange={(value) => (store.sqlText = value)}
      onRun={run}
      running={store.running}
      compiledSql={store.compiledSql}
      {resultNote}
      schema={store.schema}
      {schemaRevision}
      {sources}
      savedQueries={store.savedQueries}
      history={store.history}
      showInternals={store.showInternals}
      onPreset={applyPreset}
      onSaved={applySaved}
      onDeleteSaved={(id) => void store.deleteSaved(id)}
      onSaveCurrent={() => void saveCurrent()}
      onHistory={applyHistory}
      onOpenInEditor={() => {
        store.form = "sql";
        store.sqlText = store.compiledSql;
      }}
      {readOnly}
    />

    {#if store.error}
      <p
        class="shrink-0 rounded-lg px-3 py-2 text-[0.6875rem] leading-relaxed"
        style="background:color-mix(in oklch, var(--failure) 8%, transparent);color:var(--failure)"
        role="alert"
      >
        {store.error}
      </p>
    {/if}

    <TurnVolumeChart
      rows={store.volumeRows}
      from={store.windowTo - store.windowMs}
      to={store.windowTo}
      {selection}
      onSelectionChange={(next) => (selection = next)}
      selectedRows={volumeSelection}
    />

    {#if shape.shape === "turns" || !store.result}
      <TurnList
        rows={visibleRows}
        {sort}
        onSortChange={(next) => (sort = next)}
        {statusFilter}
        onStatusFilterChange={(next) => (statusFilter = next)}
        {grouped}
        onGroupedChange={(next) => (grouped = next)}
        {selectedTraceId}
        onOpenTurn={openTurn}
        onOpenSession={(sessionId) => void openSession(sessionId)}
        {emptyHint}
      />
    {:else if shape.shape === "events" && eventTable}
      <EventList
        table={eventTable}
        view={shape.view}
        kind={shape.kind}
        rows={visibleEventRows}
        onOpenSpan={openSpan}
        {emptyHint}
      />
    {:else if shape.shape === "trend"}
      <section
        class="flex shrink-0 flex-col gap-1 rounded-xl bg-card px-4 py-2.5 shadow-[shadow:var(--elev-ring)]"
        aria-label="Trend"
      >
        <header class="flex items-baseline gap-2">
          <h2 class="text-xs font-medium">{shape.series.valueColumn}</h2>
          <span class="text-[0.6875rem] text-muted-foreground">by {shape.series.timeColumn}</span>
        </header>
        <ResultTrendChart
          points={shape.series.points}
          mark={shape.series.mark}
          valueFormat={shape.series.valueFormat}
        />
      </section>
      <ResultTable result={store.result} />
    {:else}
      <ResultTable result={store.result} />
    {/if}
  </div>

  {#if selectedTurn}
    <TurnDrawer
      turn={selectedTurn}
      trace={selectedTrace}
      {traceLoading}
      session={selectedSession}
      index={selectedIndex}
      total={visibleRows.length}
      onPrevious={selectedIndex > 0 ? () => stepSelection(-1) : null}
      onNext={selectedIndex < visibleRows.length - 1 ? () => stepSelection(1) : null}
      onClose={() => (selectedTraceId = null)}
      onOpenFullPage={openFullPage}
      onOpenTurn={(traceId) => {
        const row = visibleRows.find((candidate) => candidate.traceId === traceId);
        if (row) openTurn(row);
        else workspace.router.open({ name: "insightsTurn", params: { traceId } });
      }}
    />
  {/if}
</div>
