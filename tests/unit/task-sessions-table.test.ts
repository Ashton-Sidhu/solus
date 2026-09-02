import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The sessions list is a table: attempts are a history, and a history is read
 * down a column. What makes it one is that the header and the rows agree about
 * every column — including the one holding the row's controls, which is the
 * column that has no header to make the disagreement visible.
 *
 * A cell that is `shrink-0` all the way down does not clip when it is declared
 * too narrow. It paints its contents over the neighbour to its left, which is
 * the "spill" shape in the renderer guide, and is what a running row did to
 * Started.
 */
const table = readFileSync(
  resolve(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/tasks/task-page/TaskSessionsList.svelte',
  ),
  'utf8',
)

const header = table.slice(table.indexOf('sticky top-0'), table.indexOf('{#each rows'))
const rows = table.slice(table.indexOf('{#each rows'), table.lastIndexOf('{/each}'))
const actions = rows.slice(rows.indexOf('The actions keep a column'))

/** Widths the element declares for itself, ignoring `.is-laptop-display` ones. */
const widths = (markup: string) => [...markup.matchAll(/(?<![:\]])w-\[(\d+)px\]/g)].map((m) => +m[1])
const laptopWidths = (markup: string) =>
  [...markup.matchAll(/is-laptop-display_&\]:w-\[(\d+)px\]/g)].map((m) => +m[1])

describe('the sessions table lines its columns up', () => {
  it('gives the header the same column widths the rows use', () => {
    // Both displays, because a laptop step applied to one and not the other is
    // a header that drifts off its own column on exactly one class of monitor.
    expect(widths(header)).toEqual(widths(rows))
    expect(laptopWidths(header)).toEqual(laptopWidths(rows))
  })

  it('declares four columns, so a hidden one cannot go unnoticed', () => {
    // Agent, Host, Started, actions. The Session cell is the flexible one and
    // declares no width at all.
    expect(widths(header)).toHaveLength(4)
  })
})

describe('the action cell reserves room for every control a row can hold', () => {
  const GAP = 4 // gap-1

  const controlCount = [...actions.matchAll(/type="button"/g)].length
  const sizes = new Set([...actions.matchAll(/(?<!:)size-\[(\d+)px\]/g)].map((m) => +m[1]))
  const laptopSizes = new Set(
    [...actions.matchAll(/is-laptop-display_&\]:size-\[(\d+)px\]/g)].map((m) => +m[1]),
  )

  it('holds four controls, the most a row has: Stop, split, open, unlink', () => {
    expect(controlCount).toBe(4)
  })

  it('sizes every control the same, or the cell has no single width to compute', () => {
    expect(sizes.size).toBe(1)
    expect(laptopSizes.size).toBe(1)
  })

  it('is at least as wide as the controls it must hold, on both displays', () => {
    // A running row is the widest case and the one that broke: four buttons in
    // a cell sized for three overflowed left across the Started column.
    const [size] = sizes
    const [laptopSize] = laptopSizes
    const [cell] = widths(actions)
    const [laptopCell] = laptopWidths(actions)

    expect(cell).toBeGreaterThanOrEqual(controlCount * size + (controlCount - 1) * GAP)
    expect(laptopCell).toBeGreaterThanOrEqual(
      controlCount * laptopSize + (controlCount - 1) * GAP,
    )
  })
})

describe('the table steps its geometry down on a laptop display', () => {
  /** The first declared value, and the `.is-laptop-display` one beside it. */
  const step = (markup: string, prop: 'h' | 'size') => ({
    desktop: Number(markup.match(new RegExp(`(?<![:\\]])${prop}-\\[(\\d+)px\\]`))?.[1]),
    laptop: Number(
      markup.match(new RegExp(`is-laptop-display_&\\]:${prop}-\\[(\\d+)px\\]`))?.[1],
    ),
  })

  /** Type follows the named rung (ADR-0013) and is not restated here. Height,
   *  padding and gaps are the display's business, and a table that keeps
   *  desktop rows on a laptop spends vertical space it cannot recover. */
  const expectStepsDown = (markup: string, prop: 'h' | 'size') => {
    const { desktop, laptop } = step(markup, prop)
    expect(desktop).toBeGreaterThan(0)
    expect(laptop).toBeGreaterThan(0)
    expect(laptop).toBeLessThan(desktop)
  }

  it('gives the header a shorter row on a laptop', () => expectStepsDown(header, 'h'))
  it('gives each session a shorter row on a laptop', () => expectStepsDown(rows, 'h'))
  it('gives the action buttons a smaller box on a laptop', () =>
    expectStepsDown(actions, 'size'))

  it('does not restate a type size, so the page rung still reaches it', () => {
    // The section used to pin `text-xs` twice, which overrode the page's own
    // `text-chrome-dense` and stopped it stepping for the pointer. Comments are
    // stripped first, so the one explaining that is allowed to name it.
    const markup = table.slice(table.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '')
    expect(markup).not.toContain('text-xs')
  })
})

describe('the table states what it knows and nothing else', () => {
  it('has no pulsing status dot', () => {
    // Perpetual animation is a paint cost on a surface that stays mounted, and
    // a dot says less than the word it sits next to.
    expect(table).not.toContain('animate-pulse')
  })

  it('has no state column, because a closed session has no knowable state', () => {
    // Running is stated inline beside the title where it is true. A column
    // would be mostly blanks claiming the lifecycle is known.
    expect(header).not.toContain('State')
    expect(header).not.toContain('Status')
  })
})
