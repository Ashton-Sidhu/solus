import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The column resize handle is the 1px rule ProseMirror drops into every cell of
// a column when the pointer reaches its border. It is absolutely positioned, so
// it takes no layout space — but it still contributes scrollable overflow, and
// the table sits in a `.tableWrapper` with `overflow-x: auto`.
//
// The handle used to hang 1px past the cell (`right: -1px; bottom: -1px`) to
// sit on the collapsed border. On the last column or the last row that 1px was
// outside the table, the wrapper answered with a scrollbar, and with classic
// scrollbars the 100%-wide table narrowed by the scrollbar's width on hover and
// grew back on leave. That is the column "stutter" a reader saw every time they
// reached for a border.
//
// This pins the handle inside the cell box, where no overhang exists to scroll.

const CSS = readFileSync(
  new URL('../../packages/workspace-ui/src/index.css', import.meta.url).pathname,
  'utf8',
)

function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start))
}

describe('table column resize handle', () => {
  test('never overhangs the cell it is drawn in', () => {
    // WHY: a negative inset on any side is scrollable overflow inside the
    // table wrapper's auto-scrolling box. The wrapper reacts with a scrollbar,
    // the table's width changes, and every column shifts on hover.
    const handle = ruleBody('.solus-doc-editor .ProseMirror .column-resize-handle')
    const insets = [...handle.matchAll(/\b(top|right|bottom|left)\s*:\s*([^;]+);/g)]
    expect(insets.length).toBeGreaterThan(0)
    for (const [, side, value] of insets) {
      expect({ side, value: value.trim() }).not.toMatchObject({ value: expect.stringMatching(/^-/) })
    }
  })
})
