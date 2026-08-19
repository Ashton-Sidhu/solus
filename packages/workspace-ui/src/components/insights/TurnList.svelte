<script lang="ts">
  import {
    createColumnHelper,
    createTable,
    functionalUpdate,
    type SortingState,
  } from "@tanstack/svelte-table";
  import { CaretRightIcon, StackSimpleIcon } from "phosphor-svelte";
  import * as Table from "../ui/table";
  import DataTableEmptyState from "./data-table/DataTableEmptyState.svelte";
  import DataTableColumnsMenu from "./data-table/DataTableColumnsMenu.svelte";
  import DataTableContextMenu from "./data-table/DataTableContextMenu.svelte";
  import DataTablePagination from "./data-table/DataTablePagination.svelte";
  import DataTableResizeHandle from "./data-table/DataTableResizeHandle.svelte";
  import DataTableSortIcon from "./data-table/DataTableSortIcon.svelte";
  import DataTableToolbar from "./data-table/DataTableToolbar.svelte";
  import {
    isColumnResized,
    nudgeColumnSize,
    resetColumnSize,
    seedColumnSize,
  } from "./data-table/column-sizing";
  import {
    cellContextFrom,
    hasTextSelection,
    type CellContext,
  } from "./data-table/table-pointer";
  import {
    insightsTableFeatures,
    type InsightsTableFeatures,
  } from "./data-table/data-table-features";
  import {
    formatClock,
    formatCost,
    formatDayClock,
    formatDuration,
    formatTokens,
    singleLine,
    spansMultipleDays,
  } from "./lib/format";
  import { MIN_TRACK_PX } from "./lib/table-grid";
  import {
    countByStatus,
    groupBySession,
    p95Duration,
    withStatus,
    type TurnRow,
    type TurnSort,
    type TurnSortKey,
    type TurnStatusFilter,
  } from "./lib/turn-rows";

  interface Props {
    rows: TurnRow[];
    sort: TurnSort;
    onSortChange: (sort: TurnSort) => void;
    statusFilter: TurnStatusFilter | null;
    onStatusFilterChange: (status: TurnStatusFilter | null) => void;
    grouped: boolean;
    onGroupedChange: (grouped: boolean) => void;
    selectedTraceId: string | null;
    onOpenTurn: (row: TurnRow) => void;
    onOpenSession: (sessionId: string) => void;
    emptyHint: string;
  }

  let {
    rows,
    sort,
    onSortChange,
    statusFilter,
    onStatusFilterChange,
    grouped,
    onGroupedChange,
    selectedTraceId,
    onOpenTurn,
    onOpenSession,
    emptyHint,
  }: Props = $props();

  let collapsed = $state<Record<string, boolean>>({});
  /** A session's turns are a bounded window, so a turn opened from anywhere but
   *  a click on its own row — a deep link, the panel's turn stepper — can sit
   *  below it. The list brings the open row back into view. */
  let listElement = $state<HTMLElement | null>(null);
  $effect(() => {
    const traceId = selectedTraceId;
    if (!listElement || !traceId) return;
    listElement
      .querySelector<HTMLElement>(`[data-trace-row="${CSS.escape(traceId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
  let rowMenu = $state<{
    x: number;
    y: number;
    cell: CellContext;
    row: TurnRow;
  } | null>(null);
  const counts = $derived(countByStatus(rows));
  const statusRows = $derived(withStatus(rows, statusFilter));
  const p95 = $derived(p95Duration(rows));

  // The clock column names two different instants once a listing straddles a
  // day, so the rows say which day they are on.
  const spansDays = $derived(
    spansMultipleDays(rows.map((row) => row.startedAt)),
  );

  const STATUS_FILTERS: { id: TurnStatusFilter; label: string }[] = [
    { id: "ok", label: "Succeeded" },
    { id: "error", label: "Failed" },
    { id: "interrupted", label: "Interrupted" },
  ];
  const HEADS: { key: TurnSortKey; label: string; align: "start" | "end" }[] = [
    { key: "startedAt", label: "Time", align: "start" },
    { key: "prompt", label: "Prompt", align: "start" },
    { key: "sessionId", label: "Session", align: "start" },
    { key: "model", label: "Model", align: "start" },
    { key: "durationMs", label: "Duration", align: "end" },
    { key: "costUsd", label: "Cost", align: "end" },
    { key: "tokens", label: "Tokens", align: "end" },
  ];
  // Default widths, in pixels and including the cell's own padding, sized from
  // what each column holds: a wall-clock instant with its day, a session uuid,
  // a model name, and measures no wider than their widest value. They are only
  // defaults — every column is resizable.
  const WIDTHS = {
    startedAt: 124,
    prompt: 360,
    sessionId: 216,
    model: 152,
    durationMs: 104,
    costUsd: 92,
    tokens: 96,
  } satisfies Record<TurnSortKey, number>;

  /** The leftover width goes to the prompt, which is the column worth reading
   *  in place. Left to the browser it pools between the ids and the measures,
   *  which is how a truncated prompt ends up beside four columns of blank.
   *
   *  `width:100%` claims the slack and `max-width:0` stops the prompt's own
   *  length from sizing the table instead — the two together are what make a
   *  cell truncate rather than scroll. Drag the prompt and it stops absorbing
   *  the slack: a width the reader set is theirs. */
  function trackStyle(key: TurnSortKey, sizePx: number): string {
    return key === "prompt" && !isColumnResized(dataTable, "prompt")
      ? `min-width:${sizePx}px;width:100%;max-width:0`
      : `width:${sizePx}px;min-width:${sizePx}px;max-width:${sizePx}px`;
  }

  const columnHelper = createColumnHelper<InsightsTableFeatures, TurnRow>();
  const columns = columnHelper.columns([
    columnHelper.accessor("startedAt", {
      id: "startedAt",
      header: "Time",
      sortDescFirst: true,
      size: WIDTHS.startedAt,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor("prompt", {
      id: "prompt",
      header: "Prompt",
      sortDescFirst: true,
      size: WIDTHS.prompt,
      minSize: 200,
    }),
    columnHelper.accessor((row) => row.sessionId ?? undefined, {
      id: "sessionId",
      header: "Session",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.sessionId,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.model ?? undefined, {
      id: "model",
      header: "Model",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.model,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.durationMs ?? undefined, {
      id: "durationMs",
      header: "Duration",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.durationMs,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.costUsd ?? undefined, {
      id: "costUsd",
      header: "Cost",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.costUsd,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor(
      (row) =>
        row.inputTokens == null && row.outputTokens == null
          ? undefined
          : (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      {
        id: "tokens",
        header: "Tokens",
        sortDescFirst: true,
        sortUndefined: "last",
        size: WIDTHS.tokens,
        minSize: MIN_TRACK_PX,
      },
    ),
  ]);

  const dataTable = createTable({
    features: insightsTableFeatures,
    get data() {
      return statusRows;
    },
    columns,
    state: {
      get sorting(): SortingState {
        return [{ id: sort.key, desc: sort.dir === "desc" }];
      },
    },
    // The listing is always sorted by something: the parent holds one sort key
    // and one direction, and there is no "unsorted" turn order to return to.
    // With removal enabled, the third state is an empty sorting array this
    // component cannot express, so a header stopped toggling after one click.
    enableSortingRemoval: false,
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, [
        { id: sort.key, desc: sort.dir === "desc" },
      ]);
      const first = next[0];
      const matchingHead = first
        ? HEADS.find((head) => head.key === first.id)
        : undefined;
      if (first && matchingHead) {
        onSortChange({
          key: matchingHead.key,
          dir: first.desc ? "desc" : "asc",
        });
      }
    },
    columnResizeMode: "onChange",
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  });

  const filteredSortedRows = $derived(
    dataTable.getSortedRowModel().rows.map((row) => row.original),
  );
  const pageRows = $derived(
    dataTable.getRowModel().rows.map((row) => row.original),
  );
  const groups = $derived(grouped ? groupBySession(filteredSortedRows) : []);

  function head(columnId: string): (typeof HEADS)[number] {
    return HEADS.find((candidate) => candidate.key === columnId) ?? HEADS[0];
  }

  /** A click that ends a drag-select is the reader finishing a selection, not
   *  asking for the turn. */
  function activate(row: TurnRow): void {
    if (hasTextSelection()) return;
    onOpenTurn(row);
  }

  function openRowMenu(event: MouseEvent, row: TurnRow): void {
    event.preventDefault();
    event.stopPropagation();
    rowMenu = {
      x: event.clientX,
      y: event.clientY,
      cell: cellContextFrom(event),
      row,
    };
  }

  function rowMenuActions(row: TurnRow): { label: string; run: () => void }[] {
    const actions = [{ label: "Open turn", run: () => onOpenTurn(row) }];
    const sessionId = row.sessionId;
    if (sessionId)
      actions.push({
        label: "Open session",
        run: () => onOpenSession(sessionId),
      });
    return actions;
  }

  function hideMenuColumn(columnId: string | null): (() => void) | undefined {
    if (!columnId) return undefined;
    const column = dataTable.getColumn(columnId);
    if (!column?.getCanHide()) return undefined;
    return () => column.toggleVisibility(false);
  }

  /** Status only. The turn open in the panel is marked by an outline rather
   *  than a fill: a wash on a row whose neighbours are all hoverable reads as
   *  selection, and it competes with the two washes that carry real state. */
  function rowBackground(row: TurnRow): string {
    if (row.status === "error")
      return "color-mix(in oklch, var(--failure) 7%, transparent)";
    if (row.status === "interrupted")
      return "color-mix(in oklch, var(--warning) 8%, transparent)";
    return "transparent";
  }

  function durationColor(row: TurnRow): string {
    if (row.status === "error") return "var(--failure)";
    if (p95 != null && row.durationMs != null && row.durationMs >= p95)
      return "var(--warning)";
    return "var(--foreground)";
  }
</script>

{#snippet statusFilters()}
  <div
    class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-1)] p-0.5 shadow-[inset_0_0_0_0.5px_var(--hairline)]"
    role="group"
    aria-label="Filter by status"
  >
    {#each STATUS_FILTERS as filter (filter.id)}
      {@const active = statusFilter === filter.id}
      <button
        type="button"
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs outline-none transition-[background-color,color,box-shadow,scale] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] pointer-coarse:h-9"
        style="background:{active
          ? 'var(--card)'
          : 'transparent'};box-shadow:{active
          ? 'var(--elev-ring), 0 1px 2px -1px rgba(0,0,0,0.08)'
          : 'none'};color:{active
          ? 'var(--foreground)'
          : 'var(--muted-foreground)'}"
        aria-pressed={active}
        onclick={() => onStatusFilterChange(active ? null : filter.id)}
      >
        {filter.label}
        <span class="tabular-nums opacity-60">{counts[filter.id]}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet groupToggle()}
  <button
    type="button"
    class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs outline-none transition-[background-color,color,box-shadow,scale] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] pointer-coarse:h-10"
    style="box-shadow:inset 0 0 0 0.5px var(--hairline);background:{grouped
      ? 'var(--wash-3)'
      : 'transparent'};color:{grouped
      ? 'var(--foreground)'
      : 'var(--muted-foreground)'}"
    aria-pressed={grouped}
    onclick={() => onGroupedChange(!grouped)}
  >
    <StackSimpleIcon class="size-3.5" aria-hidden="true" />
    <span class="hidden sm:inline">Group by session</span>
  </button>
{/snippet}

{#snippet turnCell(row: TurnRow, columnId: string, indent: number)}
  {#if columnId === "startedAt"}
    <span
      class="block truncate text-xs tabular-nums text-muted-foreground"
      style="padding-left:{indent}px"
    >
      {spansDays ? formatDayClock(row.startedAt) : formatClock(row.startedAt)}
    </span>
  {:else if columnId === "prompt"}
    <span class="flex min-w-0 items-center gap-2">
      <span class="truncate text-[0.8125rem]" title={row.prompt}
        >{singleLine(row.prompt) || "—"}</span
      >
    </span>
  {:else if columnId === "sessionId"}
    {#if grouped}
      <span></span>
    {:else}
      <button
        type="button"
        class="cursor-pointer truncate text-left text-xs text-muted-foreground transition-colors hover:text-(--primary) hover:underline"
        onclick={(event) => {
          event.stopPropagation();
          if (row.sessionId) onOpenSession(row.sessionId);
        }}
        disabled={!row.sessionId}>{row.sessionId ?? "—"}</button
      >
    {/if}
  {:else if columnId === "model"}
    <span class="block truncate text-xs text-muted-foreground"
      >{row.model ?? "—"}</span
    >
  {:else if columnId === "durationMs"}
    <span
      class="block text-right text-xs tabular-nums"
      style="color:{durationColor(row)}">{formatDuration(row.durationMs)}</span
    >
  {:else if columnId === "costUsd"}
    <span class="block text-right text-xs tabular-nums"
      >{formatCost(row.costUsd)}</span
    >
  {:else if columnId === "tokens"}
    <span class="block text-right text-xs tabular-nums"
      >{formatTokens(
        row.inputTokens == null && row.outputTokens == null
          ? null
          : (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      )}</span
    >
  {/if}
{/snippet}

<!-- One turn, listed flat or under its session. The turn open in the panel
     takes a hairline outline in place of its own row rule: it says "this is the
     one you are reading" without a fill that would read as selection, without
     weight the neighbouring prompts cannot answer, and without a dot or an edge
     rail. The error and interrupted washes stay: those are the row's state. -->
{#snippet turnRow(row: TurnRow, indent: number)}
  {@const current = row.traceId === selectedTraceId}
  <Table.Row
    class="h-10 cursor-pointer border-0 outline-none transition-[background-color,box-shadow] hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) {current
      ? 'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--solus-art-1)_55%,transparent)]'
      : 'shadow-[inset_0_-0.5px_0_var(--hairline)]'}"
    style="background:{rowBackground(row)}"
    data-trace-row={row.traceId}
    aria-current={current ? "true" : undefined}
    tabindex={0}
    onclick={() => activate(row)}
    oncontextmenu={(event) => openRowMenu(event, row)}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenTurn(row);
      }
    }}
  >
    {#each dataTable.getVisibleLeafColumns() as column (column.id)}
      <Table.Cell
        class="overflow-hidden px-3 py-0"
        style={trackStyle(head(column.id).key, column.getSize())}
        data-column-id={column.id}
        data-column-label={head(column.id).label}
        >{@render turnCell(row, column.id, indent)}</Table.Cell
      >
    {/each}
  </Table.Row>
{/snippet}

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden"
  aria-label={grouped ? "Sessions" : "Turns"}
>
  <header
    class="flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
  >
    <div class="flex min-w-0 shrink-0 items-baseline gap-2">
      <h2 class="text-[0.8125rem] font-medium text-foreground">
        {grouped ? "Sessions" : "Turns"}
      </h2>
      <p class="truncate text-xs tabular-nums text-muted-foreground">
        {#if grouped}{groups.length} sessions · {filteredSortedRows.length} turns{:else}{filteredSortedRows.length}
          of {rows.length}{/if}
      </p>
    </div>

    <DataTableToolbar table={dataTable} filterPlaceholder="Filter turns…" />
    {@render groupToggle()}
    <span class="flex-1"></span>
    {@render statusFilters()}
    <DataTableColumnsMenu table={dataTable} />
  </header>

  <div class="min-h-0 flex-1 overflow-auto" data-sb bind:this={listElement}>
    <Table.Root
      containerClass="overflow-visible"
      class="min-w-full border-separate border-spacing-0"
    >
      <Table.Header
        class="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--hairline-strong),0_3px_8px_-6px_rgba(0,0,0,0.28)]"
      >
        {#each dataTable.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row
            class="border-0 bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))] hover:bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))]"
          >
            {#each headerGroup.headers as header (header.id)}
              {@const definition = head(header.column.id)}
              {@const sorted = header.column.getIsSorted()}
              <Table.Head
                colspan={header.colSpan}
                class="group/head relative h-9 px-3 text-xs font-normal text-muted-foreground"
                style="{trackStyle(
                  definition.key,
                  header.getSize(),
                )};text-align:{definition.align === 'end' ? 'right' : 'left'}"
                aria-sort={sorted === "asc"
                  ? "ascending"
                  : sorted === "desc"
                    ? "descending"
                    : "none"}
              >
                <button
                  type="button"
                  class="group/sort flex h-9 w-full cursor-pointer items-center gap-1 outline-none transition-colors hover:text-foreground focus-visible:text-foreground {sorted
                    ? 'text-foreground'
                    : ''}"
                  class:flex-row-reverse={definition.align === "end"}
                  onclick={header.column.getToggleSortingHandler()}
                >
                  <span class="truncate"
                    >{grouped && definition.key === "sessionId"
                      ? ""
                      : definition.label}</span
                  >
                  <DataTableSortIcon direction={sorted} />
                </button>
                <DataTableResizeHandle
                  columnLabel={definition.label}
                  active={header.column.getIsResizing()}
                  onStart={(event, renderedWidthPx) => {
                    seedColumnSize(dataTable, definition.key, renderedWidthPx);
                    header.getResizeHandler()(event);
                  }}
                  onNudge={(delta) =>
                    nudgeColumnSize(dataTable, definition.key, delta)}
                  onReset={() => resetColumnSize(dataTable, definition.key)}
                />
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <!-- The app disables selection at the root, so the rows opt back in: a
           reader must be able to drag a prompt or an id out of the table. -->
      <Table.Body class="select-text">
        {#if grouped}
          {#each groups as group (group.sessionId)}
            {@const open = collapsed[group.sessionId] !== true}
            <Table.Row
              class="h-10 cursor-pointer bg-[color-mix(in_oklch,var(--wash-1)_74%,var(--background))] outline-none shadow-[inset_0_-0.5px_0_var(--hairline),inset_0_0.5px_0_var(--hairline)] transition-[background-color,box-shadow] hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
              tabindex={0}
              aria-expanded={open}
              onclick={() => (collapsed[group.sessionId] = open)}
            >
              {#each dataTable.getVisibleLeafColumns() as column (column.id)}
                <Table.Cell
                  class="overflow-hidden px-3 py-0 text-xs"
                  style={trackStyle(head(column.id).key, column.getSize())}
                  data-column-id={column.id}
                  data-column-label={head(column.id).label}
                >
                  {#if column.id === "startedAt"}
                    <span class="flex items-center gap-1.5 tabular-nums">
                      <CaretRightIcon
                        class="size-2.5 opacity-70 transition-transform duration-150 motion-reduce:transition-none"
                        weight="bold"
                        style="transform:rotate({open ? 90 : 0}deg)"
                      />
                      {group.turns.length}
                      {group.turns.length === 1 ? "turn" : "turns"}
                    </span>
                  {:else if column.id === "prompt"}
                    <span class="block truncate text-[0.8125rem] font-medium"
                      >{singleLine(group.firstPrompt)}</span
                    >
                  {:else if column.id === "sessionId"}
                    <span class="block truncate">{group.sessionId}</span>
                  {:else if column.id === "durationMs"}
                    <span class="block text-right tabular-nums"
                      >{formatDuration(group.totalDurationMs)}</span
                    >
                  {:else if column.id === "costUsd"}
                    <span class="block text-right tabular-nums"
                      >{formatCost(group.totalCostUsd)}</span
                    >
                  {/if}
                </Table.Cell>
              {/each}
            </Table.Row>
            {#if open}
              <!-- An expanded session is bounded so it stays an entry in a list
                   of sessions: three turns on a laptop, five on a taller
                   desktop display, then the session scrolls in place under the
                   app's standard thumb. Without it one long session pushes
                   every other session off the screen.

                   The turns are their own table inside one full-width cell,
                   which is what lets them scroll at all — table rows cannot.
                   The columns still line up because the inner table reserves a
                   stable gutter and is drawn that much wider, so the thumb sits
                   over the last cell's padding instead of narrowing the
                   prompt. -->
              <Table.Row class="border-0 hover:bg-transparent">
                <Table.Cell
                  colspan={Math.max(1, dataTable.getVisibleLeafColumns().length)}
                  class="p-0"
                >
                  <Table.Root
                    containerClass="scrollbar-on-hover max-h-30 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [@media(min-height:1000px)]:max-h-50"
                    class="w-[calc(100%+0.5rem)] border-separate border-spacing-0"
                  >
                    <Table.Body class="select-text">
                      {#each group.turns as row (row.traceId)}
                        {@render turnRow(row, 14)}
                      {/each}
                    </Table.Body>
                  </Table.Root>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        {:else}
          {#each pageRows as row (row.traceId)}
            {@render turnRow(row, 0)}
          {/each}
        {/if}

        {#if filteredSortedRows.length === 0}
          <Table.Row class="border-0 hover:bg-transparent">
            <Table.Cell
              colspan={Math.max(1, dataTable.getVisibleLeafColumns().length)}
              class="p-0"
            >
              <DataTableEmptyState
                filtered={statusRows.length > 0}
                title={statusRows.length === 0
                  ? "No turns in this result"
                  : "No matching turns"}
                description={statusRows.length === 0
                  ? emptyHint
                  : "Change or clear the table filter to see more turns."}
              />
            </Table.Cell>
          </Table.Row>
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
  {#if !grouped}
    <DataTablePagination table={dataTable} />
  {/if}

  {#if rowMenu}
    {@const menu = rowMenu}
    <DataTableContextMenu
      x={menu.x}
      y={menu.y}
      cell={menu.cell}
      actions={rowMenuActions(menu.row)}
      onHideColumn={hideMenuColumn(menu.cell.columnId)}
      onResetWidths={() => dataTable.resetColumnSizing()}
      onClose={() => (rowMenu = null)}
    />
  {/if}
</section>
