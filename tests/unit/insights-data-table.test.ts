import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const insights = join(import.meta.dir, '../../src/renderer/components/insights')
const read = (path: string): string => readFileSync(join(insights, path), 'utf8')

describe('Insights data-table foundation', () => {
  test('registers only the TanStack features the Insights tables expose', () => {
    const source = read('data-table/data-table-features.ts')
    for (const feature of [
      'columnFilteringFeature',
      'columnVisibilityFeature',
      'globalFilteringFeature',
      'rowPaginationFeature',
      'rowSortingFeature',
      'createFilteredRowModel()',
      'createPaginatedRowModel()',
      'createSortedRowModel()',
    ]) {
      expect(source).toContain(feature)
    }
    expect(source).not.toContain('rowSelectionFeature')
  })

  test('turn, event, and arbitrary SQL results share search, visibility, and paging controls', () => {
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      const source = read(component)
      expect(source).toContain('createTable({')
      expect(source).toContain('<DataTableToolbar')
      expect(source).toContain('<DataTablePagination')
      expect(source).toContain('<DataTableSortIcon')
      expect(source).toContain('<DataTableEmptyState')
      expect(source).toContain('<Table.Root')
    }
  })

  test('session grouping stays intact and does not paginate a session across pages', () => {
    const source = read('TurnList.svelte')
    expect(source).toContain('{#if !grouped}')
    expect(source).toContain('<DataTablePagination table={dataTable} />')
    expect(source).toContain('groupBySession(filteredSortedRows)')
  })

  test('keeps table questions above the rows and navigation below them', () => {
    const toolbar = read('data-table/DataTableToolbar.svelte')
    const pagination = read('data-table/DataTablePagination.svelte')
    expect(toolbar).toContain('data-insights-table-toolbar')
    expect(toolbar).toContain('Filter table rows')
    expect(read('data-table/DataTableColumnsMenu.svelte')).toContain('Visible columns')
    expect(toolbar).not.toContain('Previous page')
    expect(pagination).toContain('data-insights-table-pagination')
    expect(pagination).toContain('Rows per page')
    expect(pagination).toContain('Previous page')
    expect(pagination).toContain('Next page')
  })

  test('uses finite micro-interactions and visible empty states', () => {
    const sortIcon = read('data-table/DataTableSortIcon.svelte')
    const emptyState = read('data-table/DataTableEmptyState.svelte')
    expect(sortIcon).toContain('duration-200')
    expect(sortIcon).toContain("direction === 'asc'")
    expect(sortIcon).toContain("direction === 'desc'")
    expect(sortIcon).not.toContain('animate-')
    expect(emptyState).toContain('{#if filtered}')
    expect(emptyState).toContain('{title}')
    expect(emptyState).toContain('{description}')
    expect(emptyState).not.toContain('animate-')
  })

  test('every table asks its question from one band, not a stack of chrome', () => {
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      const source = read(component)
      const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
      // WHY: title, filters, and search are one question about one answer. Split
      // across bands they read as three unrelated toolbars above the rows.
      expect(header, component).toContain('<DataTableToolbar')
    }
  })

  test('the column worth reading in place takes the leftover width', () => {
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      // WHY: left to the browser the slack pools between the ids and the
      // measures, so a prompt truncates beside four columns of blank.
      expect(read(component), component).toContain('width:100%;max-width:0')
    }
  })

  test('page size is the shared select primitive, not browser chrome', () => {
    const pagination = read('data-table/DataTablePagination.svelte')
    expect(pagination).toContain('Select.Trigger')
    expect(pagination).not.toContain('<select')
  })

  test('search leads the header band and the column menu closes it', () => {
    const source = read('TurnList.svelte')
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
    // WHY: search and grouping both change which rows exist, so they read as
    // one pair beside the result's name; the status filters and the shared
    // column menu close the band at its trailing edge.
    expect(header.indexOf('<DataTableToolbar')).toBeLessThan(header.indexOf('{@render groupToggle()}'))
    expect(header.indexOf('{@render groupToggle()}')).toBeLessThan(header.indexOf('{@render statusFilters()}'))
    expect(header.indexOf('{@render statusFilters()}')).toBeLessThan(header.indexOf('<DataTableColumnsMenu'))
  })

  test('every column can be resized, by pointer and by keyboard', () => {
    const features = read('data-table/data-table-features.ts')
    expect(features).toContain('columnResizingFeature')
    expect(features).toContain('columnSizingFeature')
    const handle = read('data-table/DataTableResizeHandle.svelte')
    // WHY: a default width is a guess about content nobody has seen yet, so the
    // reader must be able to overrule it without a mouse.
    expect(handle).toContain('ArrowLeft')
    expect(handle).toContain('ArrowRight')
    expect(handle).toContain('onReset')
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      expect(read(component), component).toContain('<DataTableResizeHandle')
      expect(read(component), component).toContain('getResizeHandler()')
    }
  })

  test('a click that ends a text selection does not open the row', () => {
    // WHY: the mouse-up that finishes a drag-select is also a click, so a
    // clickable row otherwise makes its own text impossible to copy by hand.
    for (const component of ['TurnList.svelte', 'EventList.svelte']) {
      expect(read(component), component).toContain('hasTextSelection()')
    }
  })

  test('every row answers a right-click, and copies what it shows', () => {
    const pointer = read('data-table/table-pointer.ts')
    // WHY: a duration must copy as `26m54`, not as the epoch difference the
    // model holds — the reader is copying what they can see.
    expect(pointer).toContain('textContent')
    expect(pointer).toContain("join('\\t')")
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      const source = read(component)
      expect(source, component).toContain('oncontextmenu=')
      expect(source, component).toContain('<DataTableContextMenu')
      expect(source, component).toContain('data-column-id=')
    }
    const menu = read('data-table/DataTableContextMenu.svelte')
    expect(menu).toContain('Copy row')
    expect(menu).toContain('Reset column widths')
  })

  test('a drag begins at the width the column has on screen', () => {
    const sizing = read('data-table/column-sizing.ts')
    const handle = read('data-table/DataTableResizeHandle.svelte')
    // WHY: the column absorbing the row's leftover width renders wider than the
    // size the table holds for it, so a drag that starts from the stored number
    // snaps the column to its default before it follows the pointer.
    expect(sizing).toContain('seedColumnSize')
    expect(handle).toContain('getBoundingClientRect')
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      expect(read(component), component).toContain('seedColumnSize(')
    }
  })

  test('a header toggles ascending and descending, and never into nothing', () => {
    const source = read('TurnList.svelte')
    // WHY: the parent holds exactly one sort key and one direction, so
    // TanStack's third "unsorted" state is a value this listing cannot express.
    // Left enabled, the empty sorting array was dropped and the header stopped
    // responding after its first click.
    expect(source).toContain('enableSortingRemoval: false')
  })

  test('event search also narrows the chart so the plot and rows answer the same filter', () => {
    const source = read('EventList.svelte')
    expect(source).toContain('dataTable.getFilteredRowModel().rows.map')
    expect(source).toContain('chartRows')
  })
})
