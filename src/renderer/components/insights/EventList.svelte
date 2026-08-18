<script lang="ts">
  import { createColumnHelper, createTable } from '@tanstack/svelte-table'
  import { untrack } from 'svelte'
  import type { MetricsValue } from '../../../shared/observability-types'
  import * as Table from '../ui/table'
  import DataTableEmptyState from './data-table/DataTableEmptyState.svelte'
  import DataTableColumnsMenu from './data-table/DataTableColumnsMenu.svelte'
  import DataTableContextMenu from './data-table/DataTableContextMenu.svelte'
  import DataTablePagination from './data-table/DataTablePagination.svelte'
  import DataTableResizeHandle from './data-table/DataTableResizeHandle.svelte'
  import DataTableSortIcon from './data-table/DataTableSortIcon.svelte'
  import DataTableToolbar from './data-table/DataTableToolbar.svelte'
  import { isColumnResized, nudgeColumnSize, resetColumnSize, seedColumnSize } from './data-table/column-sizing'
  import { cellContextFrom, hasTextSelection, type CellContext } from './data-table/table-pointer'
  import { insightsTableFeatures, type InsightsTableFeatures } from './data-table/data-table-features'
  import { formatClock, formatDayClock, formatDuration, spansMultipleDays } from './lib/format'
  import type { EventColumn, EventRow, EventTable } from './lib/result-shape'
  import { colorForKind, labelForKind } from './lib/span-palette'
  import { columnEmphasis, columnGrows, columnTrack, MIN_TRACK_PX } from './lib/table-grid'
  import ResultTrendChart from './ResultTrendChart.svelte'

  interface Props {
    table: EventTable
    view: string
    kind: string
    rows: EventRow[]
    onOpenSpan: (traceId: string, spanId: string | null) => void
    emptyHint: string
  }

  let {
    table: eventTable,
    view,
    kind,
    rows,
    onOpenSpan,
    emptyHint,
  }: Props = $props()

  let rowMenu = $state<{ x: number; y: number; cell: CellContext; row: EventRow } | null>(null)

  const title = $derived(kind ? labelForKind(kind) : view.replace(/_/g, ' '))
  const seriesColor = $derived(colorForKind(kind))
  const spansDays = $derived(spansMultipleDays(rows.map((row) => row.startedAt)))

  /** Same rule as the turn listing: the column worth reading in place takes the
   *  leftover width until the reader resizes it, and every other column is
   *  pinned so no row can size the table. */
  function trackStyle(column: EventColumn, columnId: string, sizePx: number): string {
    return columnGrows(column, eventTable.columns) && !isColumnResized(dataTable, columnId)
      ? `min-width:${sizePx}px;width:100%;max-width:0`
      : `width:${sizePx}px;min-width:${sizePx}px;max-width:${sizePx}px`
  }

  const columnHelper = createColumnHelper<InsightsTableFeatures, EventRow>()
  const columns = $derived(
    columnHelper.columns(
      eventTable.columns.map((column, index) =>
        columnHelper.accessor((row) => row.cells[index] ?? undefined, {
          id: String(index),
          header: column.name,
          sortFn: column.numeric ? 'basic' : 'alphanumeric',
          sortUndefined: 'last',
          size: columnTrack(column),
          minSize: MIN_TRACK_PX,
        }),
      ),
    ),
  )
  const dataTable = createTable({
    features: insightsTableFeatures,
    get data() {
      return rows
    },
    get columns() {
      return columns
    },
    columnResizeMode: 'onChange',
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  })

  let seededTable = untrack(() => eventTable)
  $effect(() => {
    if (eventTable === seededTable) return
    seededTable = eventTable
    dataTable.resetSorting()
    dataTable.resetColumnVisibility()
    dataTable.resetColumnSizing()
    dataTable.setGlobalFilter('')
    dataTable.setPageIndex(0)
  })

  const chartRows = $derived(dataTable.getFilteredRowModel().rows.map((row) => row.original))
  const trendPoints = $derived(
    chartRows
      .filter((row) => row.durationMs != null)
      .map((row) => ({
        at: row.startedAt,
        value: row.durationMs ?? 0,
        failed: row.status === 'error' || row.status === 'interrupted',
        series: '',
        traceId: row.traceId,
        spanId: row.spanId,
      })),
  )

  function cellText(column: EventColumn, value: MetricsValue): string {
    if (value == null) return '—'
    if (column.format === 'time' && typeof value === 'number') {
      return spansDays ? formatDayClock(value) : formatClock(value)
    }
    if (column.format === 'duration' && typeof value === 'number') return formatDuration(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
    return value
  }

  function cellColor(column: EventColumn, row: EventRow): string {
    if (column.format === 'status') {
      if (row.status === 'error') return 'var(--failure)'
      if (row.status === 'interrupted') return 'var(--warning)'
      return 'var(--muted-foreground)'
    }
    return columnEmphasis(column) === 'secondary'
      ? 'var(--muted-foreground)'
      : 'var(--foreground)'
  }

  /** A click that ends a drag-select is the reader finishing a selection, not
   *  asking for the waterfall. */
  function open(row: EventRow): void {
    if (hasTextSelection()) return
    if (row.traceId) onOpenSpan(row.traceId, row.spanId)
  }

  function openRowMenu(event: MouseEvent, row: EventRow): void {
    event.preventDefault()
    event.stopPropagation()
    rowMenu = { x: event.clientX, y: event.clientY, cell: cellContextFrom(event), row }
  }

  function rowMenuActions(row: EventRow): { label: string; run: () => void }[] {
    const traceId = row.traceId
    if (!traceId) return []
    return [{ label: 'Open in waterfall', run: () => onOpenSpan(traceId, row.spanId) }]
  }

  function hideMenuColumn(columnId: string | null): (() => void) | undefined {
    if (!columnId) return undefined
    const column = dataTable.getColumn(columnId)
    if (!column?.getCanHide()) return undefined
    return () => column.toggleVisibility(false)
  }
</script>

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)] ring-1 ring-[color-mix(in_oklch,var(--foreground)_5%,transparent)]"
  aria-label="Events"
>
  <header
    class="flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
  >
    <div class="flex min-w-0 shrink-0 items-baseline gap-2">
      <span class="flex items-center gap-2">
        <span
          class="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
          style="background:{seriesColor}"
        ></span>
        <h2 class="truncate text-[0.8125rem] font-medium text-foreground">{title}</h2>
      </span>
      <p class="truncate text-xs tabular-nums text-muted-foreground">{rows.length} of {eventTable.rows.length}</p>
    </div>

    <DataTableToolbar table={dataTable} filterPlaceholder="Filter events…" />
    <span class="flex-1"></span>
    <DataTableColumnsMenu table={dataTable} />
  </header>

  {#if trendPoints.length >= 2}
    <div class="shrink-0 px-4 pt-2 pb-1 shadow-[inset_0_-0.5px_0_var(--hairline)]">
      <ResultTrendChart
        lines={[{ label: '', points: trendPoints, segments: [trendPoints] }]}
        mark="points"
        valueFormat="duration"
        color={seriesColor}
        valueLabel="duration"
        onSelect={(point) => {
          if (point.traceId) onOpenSpan(point.traceId, point.spanId ?? null)
        }}
      />
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-auto" data-sb>
    <Table.Root containerClass="overflow-visible" class="min-w-full border-separate border-spacing-0">
      <Table.Header class="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--hairline-strong),0_3px_8px_-6px_rgba(0,0,0,0.28)]">
        {#each dataTable.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row class="border-0 bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--card))] hover:bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--card))]">
            {#each headerGroup.headers as header (header.id)}
              {@const index = Number(header.column.id)}
              {@const column = eventTable.columns[index]}
              {@const sorted = header.column.getIsSorted()}
              <Table.Head
                colspan={header.colSpan}
                class="group/head relative h-9 px-3 text-xs font-normal text-muted-foreground"
                style="{trackStyle(column, header.column.id, header.getSize())};text-align:{column.numeric ? 'right' : 'left'}"
                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
              >
                <button
                  type="button"
                  class="group/sort flex h-9 w-full cursor-pointer items-center gap-1 outline-none transition-colors hover:text-foreground focus-visible:text-foreground {sorted ? 'text-foreground' : ''}"
                  class:flex-row-reverse={column.numeric}
                  onclick={header.column.getToggleSortingHandler()}
                >
                  <span class="truncate">{column.name}</span>
                  <DataTableSortIcon direction={sorted} />
                </button>
                <DataTableResizeHandle
                  columnLabel={column.name}
                  active={header.column.getIsResizing()}
                  onStart={(event, renderedWidthPx) => {
                    seedColumnSize(dataTable, header.column.id, renderedWidthPx)
                    header.getResizeHandler()(event)
                  }}
                  onNudge={(delta) => nudgeColumnSize(dataTable, header.column.id, delta)}
                  onReset={() => resetColumnSize(dataTable, header.column.id)}
                />
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <!-- The app disables selection at the root, so the rows opt back in: a
           reader must be able to drag a prompt or an id out of the table. -->
      <Table.Body class="select-text">
        {#each dataTable.getRowModel().rows as row (row.original.spanId ?? `${row.original.startedAt}:${row.id}`)}
          <Table.Row
            class="h-10 border-0 outline-none shadow-[inset_0_-0.5px_0_var(--hairline)] transition-[background-color,box-shadow] hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) {row.original.traceId != null ? 'cursor-pointer hover:shadow-[inset_2px_0_0_color-mix(in_oklch,var(--solus-art-1)_55%,transparent),inset_0_-0.5px_0_var(--hairline)]' : ''}"
            tabindex={row.original.traceId != null ? 0 : undefined}
            title={row.original.traceId != null ? "Open this span in its turn's waterfall" : undefined}
            onclick={() => open(row.original)}
            oncontextmenu={(event) => openRowMenu(event, row.original)}
            onkeydown={(event) => {
              if (row.original.traceId != null && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                open(row.original)
              }
            }}
          >
            {#each row.getVisibleCells() as cell (cell.id)}
              {@const index = Number(cell.column.id)}
              {@const column = eventTable.columns[index]}
              {@const text = cellText(column, cell.getValue() as MetricsValue)}
              <Table.Cell
                class="truncate px-3 py-0 text-xs {columnEmphasis(column) === 'primary' ? 'font-medium' : ''} {column.numeric || column.format !== 'raw' ? 'tabular-nums' : ''}"
                style="{trackStyle(column, cell.column.id, cell.column.getSize())};text-align:{column.numeric ? 'right' : 'left'};color:{cellColor(column, row.original)}"
                title={text}
                data-column-id={cell.column.id}
                data-column-label={column.name}
              >{text}</Table.Cell>
            {/each}
          </Table.Row>
        {:else}
          <Table.Row class="border-0 hover:bg-transparent">
            <Table.Cell colspan={Math.max(1, dataTable.getVisibleLeafColumns().length)} class="p-0">
              <DataTableEmptyState
                filtered={rows.length > 0}
                title={rows.length === 0 ? 'No events in this result' : 'No matching events'}
                description={rows.length === 0 ? emptyHint : 'Change or clear the table filter to see more events.'}
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
  <DataTablePagination table={dataTable} />

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
