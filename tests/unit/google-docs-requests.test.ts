import { describe, expect, test } from 'bun:test'
import {
  blockRequests,
  columnWidthsPt,
  compileDocsBlocks,
  fitImageToPage,
  tableRequests,
  type DocsImage,
  type RunBlock,
  type TableBlock,
} from '@solus/server/google/docs-requests'
import type { DocsRequest } from '@solus/server/google/docs-api'
import { pngPixelSize } from '@solus/server/docs/png'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'

/**
 * The Docs API addresses everything by character index and applies requests
 * in order. Every rule here is about an index landing where the text is.
 */

function inserts(requests: DocsRequest[]): { index: number; text: string }[] {
  return requests.flatMap((request) => ('insertText' in request ? [{ index: request.insertText.location.index, text: request.insertText.text }] : []))
}

function paragraphs(markdown: string, images: DocsImage[] = []): RunBlock[] {
  return compileDocsBlocks(markdown, images).filter((block): block is RunBlock => block.kind !== 'table')
}

function sections(requests: DocsRequest[]): { break?: number; styled: number; landscape: boolean }[] {
  return requests.flatMap((request, index) => {
    if (!('updateSectionStyle' in request)) return []
    const previous = requests[index - 1]
    const breakAt = previous && 'insertSectionBreak' in previous ? previous.insertSectionBreak.location.index : undefined
    return [{
      ...(breakAt === undefined ? {} : { break: breakAt }),
      styled: request.updateSectionStyle.range.startIndex,
      landscape: request.updateSectionStyle.sectionStyle.flipPageOrientation,
    }]
  })
}

const image: DocsImage = { workId: 'd1', title: 'Architecture', uri: 'https://drive.google.com/uc?id=x', widthPt: 720, heightPt: 300 }
const secondImage: DocsImage = { ...image, workId: 'd2', title: 'System map' }

describe('markdown → Docs blocks', () => {
  test('a heading is a named style, not bold text', () => {
    const [heading] = compileDocsBlocks('## Design', [])
    expect(heading).toMatchObject({ kind: 'paragraph', style: { namedStyleType: 'HEADING_2' } })
    expect(heading.kind === 'paragraph' && heading.text.runs[0].style.bold).toBeUndefined()
  })

  test('inline styles become runs with offsets into the paragraph text', () => {
    const [paragraph] = compileDocsBlocks('Plain **bold** and `code` [link](https://x.y)', [])
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
    const blocks = compileDocsBlocks('```ts\nif (a) {\n  return\n}\n```', [])
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
    const blocks = compileDocsBlocks('- one\n  1. inner\n- two', [])
    expect(blocks.map((block) => block.kind === 'paragraph' && block.bullet)).toEqual([
      { preset: 'BULLET_DISC_CIRCLE_SQUARE', level: 0 },
      { preset: 'NUMBERED_DECIMAL_ALPHA_ROMAN', level: 1 },
      { preset: 'BULLET_DISC_CIRCLE_SQUARE', level: 0 },
    ])
  })

  test('an embedded diagram becomes an image and a caption that names it', () => {
    const blocks = compileDocsBlocks(serializeDiagramEmbed({ workId: 'd1', title: 'Fallback' }), [image])
    // The figure page opens the run, so the image follows the section block.
    expect(blocks[0]).toEqual({ kind: 'section', orientation: 'landscape' })
    expect(blocks[1]).toEqual({ kind: 'image', image })
    expect(blocks[2].kind === 'paragraph' && blocks[2].text.text).toBe('Architecture')
  })

  test('a diagram gets a landscape page of its own, and the prose after it returns to portrait', () => {
    // WHY: a graph squeezed into a portrait page is unreadable; a landscape
    // page is the one thing Docs offers that makes it larger.
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const blocks = compileDocsBlocks(`Intro\n\n${embed}\n\nAfter`, [secondImage])
    expect(blocks.map((block) => (block.kind === 'section' ? `section:${block.orientation}` : block.kind))).toEqual([
      'paragraph', 'section:landscape', 'image', 'paragraph', 'section:portrait', 'paragraph',
    ])
  })

  test('the heading that introduces a diagram travels onto the figure page', () => {
    // WHY: left in the portrait section, the heading is the last line of the
    // previous page and the reader meets the drawing with nothing naming it.
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const blocks = compileDocsBlocks(`Intro\n\n## System map\n\n${embed}\n\nAfter`, [secondImage])
    expect(blocks.map((block) =>
      block.kind === 'section' ? `section:${block.orientation}`
        : block.kind === 'paragraph' ? `${block.style.namedStyleType}:${block.text.text}`
          : block.kind)).toEqual([
      'NORMAL_TEXT:Intro',
      'section:landscape',
      'HEADING_2:System map',
      'image',
      'NORMAL_TEXT:System map',
      'section:portrait',
      'NORMAL_TEXT:After',
    ])
  })

  test('prose before a diagram stays in the prose, and only a heading is lifted', () => {
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const blocks = compileDocsBlocks(`How it fits together.\n\n${embed}`, [secondImage])
    expect(blocks.map((block) => (block.kind === 'section' ? `section:${block.orientation}` : block.kind))).toEqual([
      'paragraph', 'section:landscape', 'image', 'paragraph',
    ])
  })

  test('two diagrams in a row share one landscape section, and a closing one leaves no blank page', () => {
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const blocks = compileDocsBlocks(`Intro\n\n${embed}\n\n${embed}`, [secondImage])
    expect(blocks.map((block) => (block.kind === 'section' ? `section:${block.orientation}` : block.kind))).toEqual([
      'paragraph', 'section:landscape', 'image', 'paragraph', 'image', 'paragraph',
    ])
  })

  test('fails before any request when a diagram was not prepared', () => {
    expect(() => compileDocsBlocks(serializeDiagramEmbed({ workId: 'missing', title: 'Missing' }), [])).toThrow('was not prepared')
  })

  test('a table header is never bold, even when the markdown asks for it', () => {
    // WHY: the header's treatment is the mono face in tertiary ink. A doc a
    // previous publish bolded reads back as `| **Term** |`, and honouring
    // that here would make the bold permanent.
    const [table] = compileDocsBlocks('| **a** | b |\n|---|---|\n| **1** | 2 |', [])
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

  test('an image takes one index and its own paragraph', () => {
    const plan = blockRequests(paragraphs(serializeDiagramEmbed({ workId: 'd1', title: 'x' }), [image]), 1)
    // The figure page is styled in place at the start of the body, so the
    // image is the first thing inserted.
    expect(plan.requests[1]).toEqual({
      insertInlineImage: {
        location: { index: 1 },
        uri: image.uri,
        objectSize: { width: { magnitude: 720, unit: 'PT' }, height: { magnitude: 300, unit: 'PT' } },
      },
    })
    expect(inserts(plan.requests)).toEqual([
      { index: 2, text: '\n' },
      { index: 3, text: 'Architecture\n' },
    ])
  })

  test('a section break takes two indices, and the text after it lands past both', () => {
    // WHY: the API adds a newline before every break it inserts; forgetting
    // that shifts every paragraph after a figure page by one character.
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const plan = blockRequests(paragraphs(`Intro\n\n${embed}\n\nAfter`, [secondImage]), 1)
    expect(sections(plan.requests)).toEqual([
      { break: 7, styled: 9, landscape: true },
      { break: 22, styled: 24, landscape: false },
    ])
    expect(inserts(plan.requests)).toEqual([
      { index: 1, text: 'Intro\n' },
      { index: 10, text: '\n' },
      { index: 11, text: 'System map\n' },
      { index: 24, text: 'After\n' },
    ])
    expect(plan.endIndex).toBe(30)
  })

  test('a figure page at the start of the document styles the first section instead of breaking before it', () => {
    // WHY: a break at index 1 would leave an empty portrait page in front.
    const embed = serializeDiagramEmbed({ workId: 'd2', title: 'System map' })
    const plan = blockRequests(paragraphs(`${embed}\n\nAfter`, [secondImage]), 1)
    expect(sections(plan.requests)).toEqual([
      { styled: 1, landscape: true },
      { break: 14, styled: 16, landscape: false },
    ])
    expect(plan.requests[0]).toMatchObject({ updateSectionStyle: { range: { startIndex: 1, endIndex: 2 } } })
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

describe('diagram sizing', () => {
  function png(width: number, height: number): Buffer {
    const header = Buffer.alloc(24)
    header.write('\x89PNG\r\n\x1a\n', 0, 'latin1')
    header.writeUInt32BE(13, 8)
    header.write('IHDR', 12, 'latin1')
    header.writeUInt32BE(width, 16)
    header.writeUInt32BE(height, 20)
    return header
  }

  test('a figure fills its landscape page, on whichever axis runs out first', () => {
    // WHY: the page is the diagram's whole allowance, so the figure takes all
    // of it — 720pt wide, or 492pt tall once the caption's room is kept back.
    expect(fitImageToPage({ width: 2400, height: 1200 })).toEqual({ widthPt: 720, heightPt: 360 })
    expect(fitImageToPage({ width: 800, height: 1600 })).toEqual({ widthPt: 210, heightPt: 420 })
    // Only the aspect is read. How many pixels the client spent is its own
    // business: it rasterizes for where the figure lands, so a figure is never
    // placed smaller to make up for a raster that was too coarse.
    expect(fitImageToPage({ width: 400, height: 300 })).toEqual({ widthPt: 560, heightPt: 420 })
    expect(fitImageToPage({ width: 4000, height: 3000 })).toEqual({ widthPt: 560, heightPt: 420 })
    expect(pngPixelSize(png(800, 600))).toEqual({ width: 800, height: 600 })
    expect(pngPixelSize(Buffer.from('not a png'))).toBeNull()
  })
})
