import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const insights = join(import.meta.dir, '../../packages/workspace-ui/src/components/insights')
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

  // Why it matters: a session in the Sessions table is an entry in a list of
  // sessions. Expanded without a bound, one long session pushes every other
  // session off the screen, and the reader loses the listing they opened.
  test('an expanded session is bounded and scrolls in place', () => {
    const source = read('TurnList.svelte')
    // Three 2.5rem rows on a laptop, five on a taller desktop display.
    expect(source).toContain('max-h-30')
    expect(source).toContain('[@media(min-height:1000px)]:max-h-50')
    expect(source).toContain('scrollbar-on-hover')
    expect(source).toContain('overscroll-contain')
    // A table row cannot scroll, so the turns are their own table in one
    // full-width cell. It keeps the columns aligned by reserving the thumb's
    // gutter and drawing itself that much wider, instead of letting the
    // scrollbar narrow the flexible prompt column out of line with the header.
    expect(source).toContain('[scrollbar-gutter:stable]')
    expect(source).toContain('w-[calc(100%+0.5rem)]')
    // A bounded window can hide a turn opened by deep link or by the panel's
    // stepper, so the list has to bring the open row back into view.
    expect(source).toContain('data-trace-row={row.traceId}')
    expect(source).toContain('scrollIntoView({ block: "nearest" })')
  })

  // Why it matters: the row washes carry status — failed, interrupted. Adding
  // a third wash for "open in the panel" overloads the same channel, and bold
  // asks a prompt to answer a question its neighbours cannot.
  test('the turn open in the panel is outlined, not filled or bolded', () => {
    const source = read('TurnList.svelte')
    expect(source).toContain(
      "'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--solus-art-1)_55%,transparent)]'",
    )
    expect(source).not.toContain('class:font-medium={row.traceId === selectedTraceId}')
    expect(source).not.toContain('var(--solus-art-1) 7%')
    expect(source).toContain('aria-current={current ? "true" : undefined}')
    // Status keeps its washes.
    expect(source).toContain('var(--failure) 7%')
    expect(source).toContain('var(--warning) 8%')
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

  test('clickable rows use washes without side rails', () => {
    // WHY: a rail adds a second selection language beside the row wash. Hover
    // and selection should change the row surface without adding edge chrome.
    for (const component of ['TurnList.svelte', 'EventList.svelte']) {
      const source = read(component)
      expect(source, component).toContain('hover:bg-')
      expect(source, component).not.toContain('inset_2px_0_0')
    }
    expect(read('TurnList.svelte')).toContain('row.traceId === selectedTraceId')
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

  test('table answers sit directly on the page instead of on a card', () => {
    for (const component of ['TurnList.svelte', 'EventList.svelte', 'ResultTable.svelte']) {
      const source = read(component)
      const root = source.slice(source.indexOf('<section'), source.indexOf('>', source.indexOf('<section')))
      // WHY: the table already has strong header and row structure. A rounded,
      // raised container adds an unnecessary second surface around the answer.
      expect(root, component).not.toContain('rounded-xl')
      expect(root, component).not.toContain('bg-card')
      expect(root, component).not.toContain('--insights-card-shadow')
      expect(root, component).not.toContain('ring-1')
      expect(source, component).toContain('sticky top-0 z-10 bg-background')
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
