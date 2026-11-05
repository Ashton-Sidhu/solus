import { describe, expect, test } from 'bun:test'
import {
  blockRequests,
  columnWidthsPt,
  compileDocsBlocks,
  tableRequests,
  type ParagraphBlock,
  type TableBlock,
} from '@solus/server/google/docs-requests'
import type { DocsRequest } from '@solus/server/google/docs-api'

/**
 * The Docs API addresses everything by character index and applies requests
 * in order. Every rule here is about an index landing where the text is.
 */

function inserts(requests: DocsRequest[]): { index: number; text: string }[] {
  return requests.flatMap((request) => ('insertText' in request ? [{ index: request.insertText.location.index, text: request.insertText.text }] : []))
}

function paragraphs(markdown: string): ParagraphBlock[] {
  return compileDocsBlocks(markdown).filter((block): block is ParagraphBlock => block.kind !== 'table')
}

describe('markdown → Docs blocks', () => {
  test('a heading is a named style, not bold text', () => {
    const [heading] = compileDocsBlocks('## Design')
    expect(heading).toMatchObject({ kind: 'paragraph', style: { namedStyleType: 'HEADING_2' } })
    expect(heading.kind === 'paragraph' && heading.text.runs[0].style.bold).toBeUndefined()
  })

  test('inline styles become runs with offsets into the paragraph text', () => {
    const [paragraph] = compileDocsBlocks('Plain **bold** and `code` [link](https://x.y)')
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph')
    expect(paragraph.text.text).toBe('Plain bold and code link')
    expect(paragraph.text.runs).toEqual([
      { start: 0, end: 6, style: {} },
      { start: 6, end: 10, style: { bold: true } },
      { start: 10, end: 15, style: {} },
      { start: 15, end: 19, style: { code: true } },
      { start: 19, end: 20, style: {} },
      { start: 20, end: 24, style: { link: 'https://x.y' } },
    ])
  })

  test('a code block is a rule and the mono face, never a filled card', () => {
    // WHY: nothing in a Solus document sits on a fill. A code block is the
    // left rule and the mono face, exactly as the editor draws it.
    const blocks = compileDocsBlocks('```ts\nif (a) {\n  return\n}\n```')
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', baseText: { weightedFontFamily: { fontFamily: 'Roboto Mono' } } })
    expect(blocks[1].kind === 'paragraph' && blocks[1].text.text).toBe('  return')
    expect(blocks[1].kind === 'paragraph' && blocks[1].style.shading).toBeUndefined()
    // Only the last line carries the gap to the next block.
    expect(blocks[1].kind === 'paragraph' && blocks[1].style.spaceBelow?.magnitude).toBe(0)
    expect(blocks[2].kind === 'paragraph' && blocks[2].style.spaceBelow?.magnitude).toBe(16)
    // One continuous rule: every line states the identical left border, and
    // no other edge, so Docs draws them as a single run.
    const left = blocks.map((block) => block.kind === 'paragraph' && block.style.borderLeft)
    expect(left[0]).toEqual(left[2])
    expect(left[0] && left[0].width.magnitude).toBe(1)
    expect(blocks[0].kind === 'paragraph' && blocks[0].style.borderTop?.width.magnitude).toBe(0)
  })

  test('a code span is the mono face in ink, with no chip behind it', () => {
    const plan = blockRequests(paragraphs('Run `bun test` now'), 1)
    const code = plan.requests.find(
      (request) => 'updateTextStyle' in request && request.updateTextStyle.textStyle.weightedFontFamily?.fontFamily === 'Roboto Mono',
    )
    expect(code && 'updateTextStyle' in code && code.updateTextStyle.textStyle.backgroundColor).toBeUndefined()
  })

  test('nested lists carry their level and the preset of their own list', () => {
    const blocks = compileDocsBlocks('- one\n  1. inner\n- two')
    expect(blocks.map((block) => block.kind === 'paragraph' && block.bullet)).toEqual([
      { preset: 'BULLET_DISC_CIRCLE_SQUARE', level: 0 },
      { preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN', level: 1 },
      { preset: 'BULLET_DISC_CIRCLE_SQUARE', level: 0 },
    ])
  })

  test.each(['', '\n\nAfter', '\n\n## Heading', '\n\n| Next |\n|---|\n| Value |'])(
    'each table leaves a blank line before following content: %s',
    (suffix) => {
      const blocks = compileDocsBlocks(`| Name |\n|---|\n| Value |${suffix}`)
      for (let index = 0; index < blocks.length; index += 1) {
        if (blocks[index].kind !== 'table') continue
        const spacer = blocks[index + 1]
        expect(spacer).toMatchObject({ kind: 'paragraph', text: { text: '', runs: [] }, style: { namedStyleType: 'NORMAL_TEXT' } })
        if (spacer.kind !== 'paragraph') throw new Error('expected a blank paragraph')
        const following = blocks[index + 2]
        const run = following?.kind === 'paragraph' ? [spacer, following] : [spacer]
        // The next block must start after the blank line, outside the filled table.
        const plan = blockRequests(run, 40)
        expect(inserts(plan.requests)[0]).toEqual({ index: 40, text: '\n' })
        if (run.length > 1) expect(inserts(plan.requests)[1].index).toBe(41)
        else expect(plan.endIndex).toBe(41)
      }
    },
  )

  test('a table header is never bold, even when the markdown asks for it', () => {
    // WHY: the header's treatment is the mono face in tertiary ink. A doc a
    // previous publish bolded reads back as `| **Term** |`, and honouring
    // that here would make the bold permanent.
    const [table] = compileDocsBlocks('| **a** | b |\n|---|---|\n| **1** | 2 |')
    if (table.kind !== 'table') throw new Error('expected a table')
    expect(table.rows[0][0].text).toBe('a')
    expect(table.rows[0][0].runs.every((run) => run.style.bold === false)).toBe(true)
    // A body cell keeps the bold the author wrote.
    expect(table.rows[1][0].runs[0].style.bold).toBe(true)
    expect(table.rows[1][1].text).toBe('2')
  })
})

describe('Docs requests', () => {
  test('appends paragraphs at consecutive indices and styles the exact range', () => {
    const plan = blockRequests(paragraphs('# Title\n\nBody **bold**'), 1)
    expect(inserts(plan.requests)).toEqual([
      { index: 1, text: 'Title\n' },
      { index: 7, text: 'Body bold\n' },
    ])
    const bold = plan.requests.find((request) => 'updateTextStyle' in request && request.updateTextStyle.textStyle.bold)
    expect(bold && 'updateTextStyle' in bold && bold.updateTextStyle.range).toEqual({ startIndex: 12, endIndex: 16 })
    expect(plan.endIndex).toBe(17)
  })

  test('every run names every style field, so nothing is inherited from the neighbour', () => {
    const plan = blockRequests(paragraphs('plain'), 1)
    const style = plan.requests.find((request) => 'updateTextStyle' in request)
    expect(style && 'updateTextStyle' in style && style.updateTextStyle.fields).toBe('bold,italic,strikethrough,weightedFontFamily,fontSize,foregroundColor,backgroundColor,link')
    // Stated, not cleared: a plain run is bold false, never "whatever the named style says".
    expect(style && 'updateTextStyle' in style && style.updateTextStyle.textStyle).toEqual({ bold: false, italic: false, strikethrough: false })
  })

  test('styles the paragraph before its runs, so the named style cannot override a bold', () => {
    const plan = blockRequests(paragraphs('**bold** text'), 1)
    const kinds = plan.requests.map((request) => Object.keys(request)[0])
    expect(kinds).toEqual(['insertText', 'updateParagraphStyle', 'updateTextStyle', 'updateTextStyle'])
  })

  test('steps the cursor back by the tabs a bullet request removes', () => {
    // WHY: nesting is encoded as leading tabs that createParagraphBullets
    // deletes, so everything inserted after the list would otherwise land one
    // character late per nested item.
    const plan = blockRequests(paragraphs('- one\n  - two\n\nAfter'), 1)
    expect(inserts(plan.requests)).toEqual([
      { index: 1, text: 'one\n' },
      { index: 5, text: '\ttwo\n' },
      { index: 9, text: 'After\n' },
    ])
    const bullets = plan.requests.find((request) => 'createParagraphBullets' in request)
    expect(bullets && 'createParagraphBullets' in bullets && bullets.createParagraphBullets.range).toEqual({ startIndex: 1, endIndex: 10 })
    expect(plan.endIndex).toBe(15)
  })

  test('fills table cells last to first so no insert moves a cell still to be written', () => {
    const table: TableBlock = {
      kind: 'table',
      rows: [
        [{ text: 'a', runs: [{ start: 0, end: 1, style: { bold: true } }] }, { text: 'b', runs: [{ start: 0, end: 1, style: { bold: true } }] }],
        [{ text: '1', runs: [{ start: 0, end: 1, style: {} }] }, { text: '22', runs: [{ start: 0, end: 2, style: {} }] }],
      ],
    }
    const requests = tableRequests(table, 5, [[{ startIndex: 7 }, { startIndex: 9 }], [{ startIndex: 12 }, { startIndex: 14 }]])
    expect(inserts(requests)).toEqual([
      { index: 15, text: '22' },
      { index: 13, text: '1' },
      { index: 10, text: 'b' },
      { index: 8, text: 'a' },
    ])
    // Horizontal rules only, and no fill anywhere: the vertical edges are
    // zero-width and the header carries no shading, the way a Solus table
    // reads as a band rather than a grid.
    const [everyCell, firstRow] = requests
    expect(everyCell).toMatchObject({
      updateTableCellStyle: {
        tableRange: { rowSpan: 2, columnSpan: 2 },
        tableCellStyle: { borderLeft: { width: { magnitude: 0 } }, borderRight: { width: { magnitude: 0 } } },
      },
    })
    // `backgroundColor` is named so Docs' own default cell grey is cleared.
    expect(everyCell && 'updateTableCellStyle' in everyCell && everyCell.updateTableCellStyle.fields).toContain('backgroundColor')
    // The opening rule is heavier than the ones between rows.
    expect(firstRow).toMatchObject({
      updateTableCellStyle: {
        tableRange: { tableCellLocation: { rowIndex: 0 }, rowSpan: 1 },
        tableCellStyle: { borderTop: { width: { magnitude: 1 } } },
      },
    })
    expect(firstRow && 'updateTableCellStyle' in firstRow && firstRow.updateTableCellStyle.tableCellStyle.backgroundColor).toBeUndefined()
  })

  test('column widths follow the content, with a floor for narrow columns', () => {
    const cell = (text: string) => ({ text, runs: [{ start: 0, end: text.length, style: {} }] })
    const widths = columnWidthsPt({
      kind: 'table',
      rows: [[cell('Term'), cell('Meaning')], [cell('doc'), cell('The single generic word for a provider document, used everywhere.')]],
    })
    expect(widths).toHaveLength(2)
    expect(widths[0]).toBeLessThan(widths[1])
    // The narrow column keeps at least its floor share of the page.
    expect(widths[0]).toBeGreaterThanOrEqual(Math.floor(468 * 0.16))
    expect(widths[0] + widths[1]).toBe(468)
  })
})
