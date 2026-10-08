<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { fly } from "svelte/transition";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext, serversStore } from "../../contexts";
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
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import { ListPage, PageCrumbLine } from "../ui/list-page";
  import DetailPanelResizeHandle from "../ui/list-page/DetailPanelResizeHandle.svelte";
  import { FoldingToolbar } from "../ui/list-page/folding-toolbar.svelte";
  import {
    canSplitDetailPanel,
    clampDetailPanelWidth,
    detailPanelWidth,
    readSavedDetailPanelWidth,
    saveDetailPanelWidth,
  } from "../ui/list-page/detail-panel-width";
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
    countByStatus,
    searchTurns,
    sortTurns,
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
  import InsightsRailToolbar from "./InsightsRailToolbar.svelte";
  import InsightsCondensedCrumbs from "./InsightsCondensedCrumbs.svelte";
  import InsightsResultSkeleton from "./InsightsResultSkeleton.svelte";
  import QueryConsole from "./QueryConsole.svelte";
  import ResultRankingChart from "./ResultRankingChart.svelte";
  import ResultTable from "./ResultTable.svelte";
  import SaveQueryDialog from "./SaveQueryDialog.svelte";
  import SchemaSheet from "./SchemaSheet.svelte";
  import ResultTrendChart from "./ResultTrendChart.svelte";
  import SessionDetailPanel from "./SessionDetailPanel.svelte";
  import TurnDetailPanel from "./TurnDetailPanel.svelte";
  import TurnList from "./TurnList.svelte";
  import VolumeChart from "./VolumeChart.svelte";
  import { turnHostChoices, turnHostLabel, turnHostServerId } from "./lib/turn-hosts";

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
   * follows the Run on host and clears rather than mixing two machines' spans.
   */
  let { params, paneId }: RouteSurfaceProps<"insights"> = $props();

  const workspace = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const store = insightsStore;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const open = $derived(workspace.router.at("insights"));
  // `metrics.db` is a machine's. At app.solus.sh the active host can be the
  // organization's Solus API, which records no turns, so read the Run on host.
  const serverId = $derived.by(() => {
    // Read so a host switch, or a machine connecting or dropping, chooses again.
    void serversStore.activeServerId;
    void serversStore.executionServers.map((server) => server.status);
    return serverConnections.runOnHostId();
  });
  // Turns this person ran on other hosts are pulled into the host's record
  // (docs/plans/insights-across-hosts.md); each row names the host it ran on.
  const hostLabel = (turn: { hostId: string | null; hostname: string | null }): string =>
    turnHostLabel(turn, serversStore.servers, store.serverId);
  const hostChoices = $derived(turnHostChoices(store.turnListingSummary?.hosts ?? [], hostLabel));

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
    host: "host",
    user: "user",
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
    // The marks a person put on turns, for the chips on the rows. Small, and
    // read once per host.
    void store.loadTurnFlags();
  });

  $effect(() => {
    if (!open) loaded = false;
  });

  // The listing follows turns as they start and end while the page is open.
  $effect(() => {
    if (!open) return;
    return store.watchTurns();
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
  /** One search for the turns, whichever of the list or the rail holds the
   *  field: the host runs it on a paged listing; an answer that arrived whole
   *  is searched here. */
  let localTurnSearch = $state("");
  const turnSearch = $derived(pagedTurns ? store.turnSearch : localTurnSearch);
  const visibleRows = $derived(
    pagedTurns ? rows : searchTurns(withinSelection(rows, selection), localTurnSearch),
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
  /** The answer lists turns, so the rail can search, sort, and filter it. */
  const listsTurns = $derived(rendering.rendering === "turns" || !store.result);
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
            ? `${formatRowCount(store.turnListingSummary?.totalRows ?? store.result.rows.length)} · ${store.lastRunMs} ms${
                store.answerWindowStale ? " · asked over the previous range — run again" : ""
              }`
            : "No query has run yet",
  );

  /** The chart and listing are one answer. While the next answer is compiling
   *  or running, replace both with their shared skeleton instead of briefly
   *  deriving a chart from the old result under the new query state. */
  const awaitingAnswer = $derived(store.running || store.bootstrapping);

  const emptyHint = $derived(
    selection
      ? "The selected window is empty — clear it or widen the range."
      : turnSearch
        ? "Clear or change the search."
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

  function changeTurnSearch(next: string): void {
    if (pagedTurns) store.setTurnSearch(next);
    else localTurnSearch = next;
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
  /** A session opens on the host its turn ran on: a pulled turn's session is
   *  on another host, reachable only while this client is connected to it. */
  async function openSession(sessionId: string): Promise<void> {
    const pulledHostId = store.volumeRows.find((row) => row.sessionId === sessionId)?.hostId ?? null;
    const sessionServerId = pulledHostId ? turnHostServerId(pulledHostId, serversStore.servers) : serverId;
    if (!sessionServerId) {
      toasts.error("That session ran on a host this client is not connected to");
      return;
    }
    const tabId = await workspace.revealSession(sessionId, sessionServerId);
    if (!tabId) toasts.error("That session is no longer on its host");
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
  /** A session's own page, in the same panel a turn opens in. */
  const openSessionId = $derived(params.sessionId ?? null);
  const panelOpen = $derived(openTraceId !== null || openSessionId !== null);

  let pageWidth = $state(0);
  /** The reader's choice; forgotten when the panel closes. */
  let panelFullScreenChoice = $state(false);
  // The split the Pull Requests page draws, opened wider: a turn is the thing
  // being read and the rail is navigation. The drag is remembered per page.
  const roomForSplit = $derived(canSplitDetailPanel(pageWidth));
  let savedPanelWidth = $state(readSavedDetailPanelWidth("insights"));
  const panelWidth = $derived(detailPanelWidth("insights", savedPanelWidth, pageWidth));
  const maxPanelWidth = $derived(clampDetailPanelWidth(Number.POSITIVE_INFINITY, pageWidth));
  const panelFullScreen = $derived(panelOpen && (panelFullScreenChoice || !roomForSplit));
  const splitList = $derived(panelOpen && !panelFullScreen);

  /** The turns the rail lists, narrowed and ordered the way the list beside
   *  it would be. The host already filtered a paged listing; filtering it
   *  again here makes a keystroke answer at once, before the page returns,
   *  and never drops a row the host kept (`searchTurns`). The host's order
   *  stands on a paged listing; an answer that arrived whole is sorted here. */
  const railTurns = $derived.by(() => {
    const narrowed = searchTurns(withStatus(visibleRows, statusFilter), turnSearch);
    return pagedTurns ? narrowed : sortTurns(narrowed, sort);
  });
  // ── The folding rail head ──
  // The pull request list's fold: scrolled past the narrowing row, the row
  // folds into the crumb line as `Insights / All turns ▾ / Newest first ▾`.
  let railScrollTop = $state(0);
  let railSearchEl = $state<HTMLInputElement | null>(null);
  const railFold = new FoldingToolbar(
    () => railScrollTop,
    () => !!turnSearch,
    () => railSearchEl,
  );
  const railCondensed = $derived(railFold.condensed);

  const railStatusCounts = $derived(
    (pagedTurns ? store.turnListingSummary?.statusCounts : undefined) ?? countByStatus(visibleRows),
  );

  /** The rows the rail shows and the panel's stepper walks — the current
   *  answer's own order, turn- or span-grained to match its shape. */
  const railItems = $derived(
    rendering.rendering === "events" && eventTable
      ? railItemsFromEvents(eventTable.columns, visibleEventRows, rendering.kind)
      : railItemsFromTurns(railTurns),
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
          <DropdownMenu.Content align="start" class="w-max min-w-40 max-w-[calc(100vw-2rem)] overflow-x-auto">
            {#each measures as name (name)}
              <DropdownMenu.Item class="whitespace-nowrap" onSelect={() => (measure = name)}>
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
      class="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-md text-insights-summary text-muted-foreground transition-[background-color,color,scale] hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-10"
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

<svelte:window
  onpointerdown={railFold.pressStarted}
  onpointerup={railFold.pressEnded}
  onpointercancel={railFold.pressEnded}
/>

{#snippet railCrumbs()}
  <InsightsCondensedCrumbs
    {sort}
    onSortChange={changeTurnSort}
    {statusFilter}
    onStatusFilterChange={changeTurnStatus}
    onSearch={railFold.unfoldSearch}
  />
{/snippet}

{#snippet resizeHandle()}
  <DetailPanelResizeHandle
    width={panelWidth}
    maxWidth={maxPanelWidth}
    label="Resize the Insights panel"
    onResize={(width) => (savedPanelWidth = clampDetailPanelWidth(width, pageWidth))}
    onCommit={(width) => saveDetailPanelWidth("insights", clampDetailPanelWidth(width, pageWidth))}
  />
{/snippet}

<!-- The rail's narrowing row: the same search, sort, and status the
     full-width list holds, in the pull request list's shape. -->
{#snippet railFilters()}
  <InsightsRailToolbar
    bind:searchEl={railSearchEl}
    onSearchFocusChange={railFold.searchFocusChanged}
    search={turnSearch}
    onSearchChange={changeTurnSearch}
    {sort}
    onSortChange={changeTurnSort}
    {statusFilter}
    onStatusFilterChange={changeTurnStatus}
    counts={railStatusCounts}
    hostChoices={pagedTurns ? hostChoices : []}
    hostFilter={store.turnHost}
    onHostFilterChange={(hostId) => void store.setTurnHost(hostId)}
  />
{/snippet}

<!-- The console owns the question's controls — the range lives on it. The head
     keeps only the way back to the default question. -->
{#snippet resetAction()}
  <button
    type="button"
    class="h-6 shrink-0 cursor-pointer rounded-md px-2 text-insights-chrome text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
    title="Back to the default question"
    onclick={() => void store.resetToDefault()}>Reset</button
  >
{/snippet}

<div
  class="@container relative flex h-full w-full flex-col overflow-hidden bg-background text-insights-chrome text-foreground"
  style="--insights-list-width: {pageWidth - panelWidth}px"
  bind:clientWidth={pageWidth}
>
  <!-- The same crumb line every page head leads with, in this page's own band:
       Insights has no project scope (`metrics.db` is host-local), so the page
       menu is the first segment and the current question is the last.
       Absent while a turn is open, split or full screen: that turn's own band
       carries the whole path and the window controls, the way a pull request's
       does. Kept beside the rail, this line sat in the centered page measure —
       its title floated mid-rail and its ✕ hung over the panel — and the two
       bands showed the same crumb and the same ✕ twice on one edge. -->
  {#if !panelOpen}
  <!-- Match the Tasks header measure and keep the loading shell aligned. -->
  <div class="mx-auto w-full max-w-[72rem] shrink-0 px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4">
  <header
    class="workspace-titlebar box-content flex h-[31px] shrink-0 items-center pt-[42px] pb-[13px] pointer-coarse:h-9 @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5!"
  >
    <PageCrumbLine
      page="insights"
      trailingCrumb={listLabel}
      actions={resetAction}
      onClose={closePage}
    />
  </header>
  </div>
  {/if}

  <!-- Everything under the crumb line: the console, the rail beside a turn, and
       the turn itself, which is positioned against this box so it never covers
       the crumb line beside a list — only the room the rail leaves. -->
  <div class="relative flex min-h-0 flex-1 flex-col">
  <!-- Hidden rather than unmounted while the panel is open: the console holds
       a CodeMirror editor and the histogram a chart, and closing the panel must
       not rebuild either or forget the draft being typed. Under a full-screen
       turn it stays in the flow, covered — so it is `inert`, or the tab order
       and a screen reader would walk a console nobody can see. -->
  <div
    class="mx-auto flex min-h-0 w-full max-w-[72rem] flex-1 flex-col gap-3 px-8 pb-4.5 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4 {splitList
      ? 'hidden'
      : ''}"
    inert={panelFullScreen}
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

    {#if awaitingAnswer}
      <InsightsResultSkeleton />
    {:else}
      {#if showVolume}
        <VolumeChart
          points={chartPoints}
          aggregateBuckets={pagedTurns ? store.turnListingSummary?.volume : undefined}
          aggregateStats={pagedTurns ? store.turnListingSummary?.stats : undefined}
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
          onOpenSessionPage={(sessionId) => workspace.openInsightsSession(sessionId)}
          sessionName={(sessionId) => store.sessionName(sessionId)}
          flags={store.turnFlags}
          {emptyHint}
          totalRows={pagedTurns ? store.turnListingSummary?.totalRows : undefined}
          pageIndex={pagedTurns ? store.turnPageIndex : undefined}
          pageSize={pagedTurns ? store.turnPageSize : undefined}
          onPageChange={pagedTurns ? (page) => void store.setTurnPage(page) : undefined}
          onPageSizeChange={pagedTurns ? (size) => void store.setTurnPageSize(size) : undefined}
          rowsLoading={pagedTurns && store.turnRowsLoading}
          fullStatusCounts={pagedTurns ? store.turnListingSummary?.statusCounts : undefined}
          fullP95DurationMs={pagedTurns ? store.turnListingSummary?.stats.p95DurationMs : undefined}
          search={turnSearch}
          onSearchChange={changeTurnSearch}
          {hostLabel}
          hostChoices={pagedTurns ? hostChoices : []}
          hostFilter={store.turnHost}
          onHostFilterChange={(hostId) => void store.setTurnHost(hostId)}
          pulling={pagedTurns && (store.insightPull?.pulling ?? false)}
          pullError={store.insightPull?.error ?? null}
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
          class="flex shrink-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)]"
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
          class="flex shrink-0 flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)]"
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
    <!-- The rail is the Pull Requests column beside an open review: the same
         list shell in its split shape, with a chrome-row head that sits level
         with the panel's band across the seam. -->
    <div class="flex min-h-0 w-(--insights-list-width) flex-1 flex-col">
      <ListPage
        split
        chromeHead
        contentOwnsScroll
        page="insights"
        onRefresh={() => void store.refresh()}
        refreshing={store.running}
        onClose={closePage}
        filters={listsTurns ? railFilters : undefined}
        toolbarFilters
        wrapFilters
        condensed={listsTurns && railCondensed}
        condensedCrumbs={railCrumbs}
      >
        <InsightsRail
          items={railItems}
          heading={listLabel}
          selectedIndex={railIndex}
          onOpenItem={openRailItem}
          onOpenSession={(sessionId) => void openSession(sessionId)}
          flags={store.turnFlags}
          {emptyHint}
          bind:scrollTop={railScrollTop}
        />
      </ListPage>
    </div>
  {/if}

  {#if panelOpen && openSessionId}
    <div
      class="flex flex-col bg-background {panelFullScreen
        ? 'absolute inset-0 z-20'
        : 'absolute inset-y-0 right-0 left-(--insights-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong)]'}"
      transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
    >
      {#if !panelFullScreen}{@render resizeHandle()}{/if}
      <SessionDetailPanel
        sessionId={openSessionId}
        fullScreen={panelFullScreen}
        onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
        {listLabel}
        onClose={closePanel}
      />
    </div>
  {:else if panelOpen && openTraceId}
    <!-- Out of the list's flow on purpose, not just when full screen: it covers
         the room the rail's width leaves rather than claiming its own, so the
         fly is transform and opacity alone and nothing relayouts. -->
    <div
      class="flex flex-col bg-background {panelFullScreen
        ? 'absolute inset-0 z-20'
        : 'absolute inset-y-0 right-0 left-(--insights-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong)]'}"
      transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
    >
      {#if !panelFullScreen}{@render resizeHandle()}{/if}
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
  </div>

  {#if schemaOpen}
    <SchemaSheet
      schema={store.schema}
      onClose={() => (schemaOpen = false)}
      onInsertColumn={(name) => void insertColumn(name)}
    />
  {/if}

  {#if saveQueryOpen}
    <SaveQueryDialog
      onClose={() => (saveQueryOpen = false)}
      onSave={saveCurrent}
    />
  {/if}
</div>
