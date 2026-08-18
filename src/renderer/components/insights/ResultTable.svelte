<script lang="ts">
  import {
    createColumnHelper,
    createTable,
  } from '@tanstack/svelte-table'
  import { untrack } from 'svelte'
  import type { MetricsQueryResult, MetricsValue } from '../../../shared/observability-types'
  import * as Table from '../ui/table'
  import DataTableEmptyState from './data-table/DataTableEmptyState.svelte'
  import DataTableColumnsMenu from './data-table/DataTableColumnsMenu.svelte'
  import DataTableContextMenu from './data-table/DataTableContextMenu.svelte'
  import DataTablePagination from './data-table/DataTablePagination.svelte'
  import DataTableResizeHandle from './data-table/DataTableResizeHandle.svelte'
  import DataTableSortIcon from './data-table/DataTableSortIcon.svelte'
  import DataTableToolbar from './data-table/DataTableToolbar.svelte'
  import { isColumnResized, nudgeColumnSize, resetColumnSize, seedColumnSize } from './data-table/column-sizing'
  import { cellContextFrom, type CellContext } from './data-table/table-pointer'
  import { insightsTableFeatures, type InsightsTableFeatures } from './data-table/data-table-features'
  import { columnEmphasis, columnGrows, columnTrack, MIN_TRACK_PX } from './lib/table-grid'

  interface Props {
    result: MetricsQueryResult
  }

  interface ResultRow {
    rowIndex: number
    cells: MetricsValue[]
  }

  let { result }: Props = $props()

  const numericColumns = $derived(
    result.columns.map(
      (_, index) =>
        result.rows.some((row) => row[index] != null) &&
        result.rows.every((row) => row[index] == null || typeof row[index] === 'number'),
    ),
  )
  const gridColumns = $derived(
    result.columns.map((name, index) => ({ name, numeric: numericColumns[index] })),
  )
  const data = $derived(
    result.rows.map((cells, rowIndex): ResultRow => ({ rowIndex, cells })),
  )

  const columnHelper = createColumnHelper<InsightsTableFeatures, ResultRow>()
  const columns = $derived(
    columnHelper.columns(
      result.columns.map((name, index) =>
        columnHelper.accessor((row) => row.cells[index] ?? undefined, {
          id: String(index),
          header: name,
          sortFn: numericColumns[index] ? 'basic' : 'alphanumeric',
          sortUndefined: 'last',
          size: columnTrack(gridColumns[index]),
          minSize: MIN_TRACK_PX,
        }),
      ),
    ),
  )

  const table = createTable({
    features: insightsTableFeatures,
    get data() {
      return data
    },
    get columns() {
      return columns
    },
    columnResizeMode: 'onChange',
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  })

  let seededResult = untrack(() => result)
  $effect(() => {
    if (result === seededResult) return
    seededResult = result
    table.resetSorting()
    table.resetColumnVisibility()
    table.resetColumnSizing()
    table.setGlobalFilter('')
    table.setPageIndex(0)
  })

  /** Same rule as the turn listing: the column worth reading in place takes the
   *  leftover width, and pins its own so the row cannot size the table. */
  function trackStyle(index: number, sizePx: number): string {
    const column = gridColumns[index]
    return columnGrows(column, gridColumns) && !isColumnResized(table, String(index))
      ? `min-width:${sizePx}px;width:100%;max-width:0`
      : `width:${sizePx}px;min-width:${sizePx}px;max-width:${sizePx}px`
  }

  let rowMenu = $state<{ x: number; y: number; cell: CellContext } | null>(null)

  function openRowMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    rowMenu = { x: event.clientX, y: event.clientY, cell: cellContextFrom(event) }
  }

  function hideMenuColumn(columnId: string | null): (() => void) | undefined {
    if (!columnId) return undefined
    const column = table.getColumn(columnId)
    if (!column?.getCanHide()) return undefined
    return () => column.toggleVisibility(false)
  }

  function display(value: MetricsValue): string {
    if (value == null) return '—'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
    return value
  }
</script>

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden"
  aria-label="Query result"
>
  <header
    class="flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
  >
    <div class="flex min-w-0 shrink-0 items-baseline gap-2">
      <h2 class="text-[0.8125rem] font-medium text-foreground">Result</h2>
      <p class="truncate text-xs tabular-nums text-muted-foreground">
        {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'} · {result.columns.length} columns
      </p>
    </div>

    <DataTableToolbar {table} filterPlaceholder="Filter result…" />
    <span class="flex-1"></span>
    <DataTableColumnsMenu {table} />
  </header>

  <div class="min-h-0 flex-1 overflow-auto" data-sb>
    <Table.Root containerClass="overflow-visible" class="min-w-full border-separate border-spacing-0">
      <Table.Header class="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--hairline-strong),0_3px_8px_-6px_rgba(0,0,0,0.28)]">
        {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row class="border-0 bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))] hover:bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))]">
            {#each headerGroup.headers as header (header.id)}
              {@const index = Number(header.column.id)}
              {@const sorted = header.column.getIsSorted()}
              <Table.Head
                colspan={header.colSpan}
                class="group/head relative h-9 px-3 text-xs font-normal text-muted-foreground"
                style="{trackStyle(index, header.getSize())};text-align:{numericColumns[index] ? 'right' : 'left'}"
                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
              >
                {#if !header.isPlaceholder}
                  <button
                    type="button"
                    class="group/sort flex h-9 w-full cursor-pointer items-center gap-1 outline-none transition-colors hover:text-foreground focus-visible:text-foreground {sorted ? 'text-foreground' : ''}"
                    class:flex-row-reverse={numericColumns[index]}
                    onclick={header.column.getToggleSortingHandler()}
                  >
                    <span class="truncate">{result.columns[index]}</span>
                    <DataTableSortIcon direction={sorted} />
                  </button>
                {/if}
                <DataTableResizeHandle
                  columnLabel={result.columns[index]}
                  active={header.column.getIsResizing()}
                  onStart={(event, renderedWidthPx) => {
                    seedColumnSize(table, header.column.id, renderedWidthPx)
                    header.getResizeHandler()(event)
                  }}
                  onNudge={(delta) => nudgeColumnSize(table, header.column.id, delta)}
                  onReset={() => resetColumnSize(table, header.column.id)}
                />
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <!-- The app disables selection at the root, so the rows opt back in: a
           reader must be able to drag a prompt or an id out of the table. -->
      <Table.Body class="select-text">
        {#each table.getRowModel().rows as row (row.original.rowIndex)}
          <Table.Row
            class="h-10 border-0 shadow-[inset_0_-0.5px_0_var(--hairline)] transition-[background-color,box-shadow] hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)]"
            oncontextmenu={openRowMenu}
          >
            {#each row.getVisibleCells() as cell (cell.id)}
              {@const index = Number(cell.column.id)}
              {@const value = cell.getValue() as MetricsValue}
              {@const emphasis = columnEmphasis(gridColumns[index])}
              <Table.Cell
                class="truncate px-3 py-0 text-xs {emphasis === 'primary' ? 'font-medium' : ''} {numericColumns[index] ? 'tabular-nums' : ''}"
                style="{trackStyle(index, cell.column.getSize())};text-align:{numericColumns[index]
                  ? 'right'
                  : 'left'};color:{emphasis === 'secondary'
                  ? 'var(--muted-foreground)'
                  : 'var(--foreground)'}"
                title={display(value)}
                data-column-id={cell.column.id}
                data-column-label={result.columns[index]}
              >{display(value)}</Table.Cell>
            {/each}
          </Table.Row>
        {:else}
          <Table.Row class="border-0 hover:bg-transparent">
            <Table.Cell colspan={Math.max(1, table.getVisibleLeafColumns().length)} class="p-0">
              <DataTableEmptyState
                filtered={result.rows.length > 0}
                title={result.rows.length === 0 ? 'No result rows' : 'No matching rows'}
                description={result.rows.length === 0
                  ? 'The query ran successfully but returned no data.'
                  : 'Change or clear the table filter to see more rows.'}
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
  <DataTablePagination {table} />

  {#if rowMenu}
    {@const menu = rowMenu}
    <DataTableContextMenu
      x={menu.x}
      y={menu.y}
      cell={menu.cell}
      onHideColumn={hideMenuColumn(menu.cell.columnId)}
      onResetWidths={() => table.resetColumnSizing()}
      onClose={() => (rowMenu = null)}
    />
  {/if}
</section>
