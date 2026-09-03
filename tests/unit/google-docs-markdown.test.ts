import { describe, expect, test } from 'bun:test'
import { documentToMarkdown } from '@solus/server/google/docs-markdown'
import type { DocsDocument, DocsParagraph, DocsStructuralElement, DocsTextStyle } from '@solus/server/google/docs-api'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'

/**
 * The document says which paragraph is a heading, a bullet, or code; the
 * markdown must say the same thing, and nothing else.
 */

function paragraph(runs: [string, DocsTextStyle?][], extra: Partial<DocsParagraph> = {}): DocsStructuralElement {
  return {
    paragraph: {
      elements: runs.map(([content, textStyle]) => ({ textRun: { content, textStyle } })),
      ...extra,
    },
  }
}

const CODE: DocsTextStyle = { weightedFontFamily: { fontFamily: 'Courier New' } }

function doc(content: DocsStructuralElement[], lists: DocsDocument['lists'] = {}): DocsDocument {
  return { documentId: 'doc', body: { content }, lists }
}

describe('Google Doc → markdown', () => {
  test('headings come from named styles and drop the bold Docs paints on them', () => {
    const { markdown } = documentToMarkdown(doc([
      paragraph([['Design\n', { bold: true }]], { paragraphStyle: { namedStyleType: 'HEADING_1' } }),
      paragraph([['Body ', {}], ['bold', { bold: true }], ['.\n', {}]]),
    ]))
    expect(markdown).toBe('# Design\n\nBody **bold**.\n')
  })

  test('paragraphs are separated by blank lines, never joined by hard breaks', () => {
    const { markdown } = documentToMarkdown(doc([
      paragraph([['One\n']]),
      paragraph([['Two\n']]),
    ]))
    expect(markdown).toBe('One\n\nTwo\n')
  })

  test('bullets read their nesting level and whether the list is numbered', () => {
    const { markdown } = documentToMarkdown(doc([
      paragraph([['one\n']], { bullet: { listId: 'L' } }),
      paragraph([['inner\n']], { bullet: { listId: 'L', nestingLevel: 1 } }),
      paragraph([['two\n']], { bullet: { listId: 'L' } }),
    ], { L: { listProperties: { nestingLevels: [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED' }, { glyphType: 'DECIMAL' }] } } }))
    expect(markdown).toBe('- one\n  1. inner\n- two\n')
  })

  test('consecutive monospace paragraphs are one fence, blank lines included', () => {
    const { markdown } = documentToMarkdown(doc([
      paragraph([['if (a) {\n', CODE]]),
      paragraph([['\n']]),
      paragraph([['}\n', CODE]]),
      paragraph([['After\n']]),
    ]))
    expect(markdown).toBe('```\nif (a) {\n\n}\n```\n\nAfter\n')
  })

  test('an inline monospace run is a code span', () => {
    const { markdown } = documentToMarkdown(doc([paragraph([['Run ', {}], ['bun test', CODE], [' now\n', {}]])]))
    expect(markdown).toBe('Run `bun test` now\n')
  })

  test('a table is a pipe table with the first row as header', () => {
    const cell = (text: string): DocsStructuralElement['table'] extends infer T ? T extends { tableRows: { tableCells: (infer C)[] }[] } ? C : never : never =>
      ({ content: [paragraph([[`${text}\n`]])] })
    const { markdown } = documentToMarkdown(doc([{
      table: { tableRows: [{ tableCells: [cell('a'), cell('b')] }, { tableCells: [cell('1'), cell('x | y')] }] },
    }]))
    expect(markdown).toBe('| a | b |\n| --- | --- |\n| 1 | x \\| y |\n')
  })

  test('a bold header cell comes back unbolded, so a republish cannot make it permanent', () => {
    // WHY: a doc an older publish bolded would otherwise read back as
    // `| **Term** |`, and the next publish would bold it from the content.
    const cell = (text: string, style?: DocsTextStyle) => ({ content: [paragraph([[`${text}\n`, style]])] })
    const { markdown } = documentToMarkdown(doc([{
      table: {
        tableRows: [
          { tableCells: [cell('Term', { bold: true }), cell('Meaning', { bold: true })] },
          { tableCells: [cell('doc', { bold: true }), cell('A provider document')] },
        ],
      },
    }]))
    // Body cells keep their bold; only the header row's treatment is dropped.
    expect(markdown).toBe('| Term | Meaning |\n| --- | --- |\n| **doc** | A provider document |\n')
  })

  test('a mono header cell is a label, not a code span', () => {
    // WHY: the publish writes header cells in the mono face as the header
    // treatment. Reading that back as `code` would put backticks around
    // every column name on the first pull.
    const cell = (text: string, style?: DocsTextStyle) => ({ content: [paragraph([[`${text}\n`, style]])] })
    const { markdown } = documentToMarkdown(doc([{
      table: {
        tableRows: [
          { tableCells: [cell('Term', CODE), cell('Meaning', CODE)] },
          { tableCells: [cell('doc', CODE), cell('A provider document')] },
        ],
      },
    }]))
    expect(markdown).toBe('| Term | Meaning |\n| --- | --- |\n| `doc` | A provider document |\n')
  })

  test('an image captioned with a published diagram title becomes the embed again', () => {
    const { markdown, lossyParts } = documentToMarkdown(doc([
      { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'img' } }, { textRun: { content: '\n' } }] } },
      paragraph([['Architecture\n']]),
      paragraph([['After\n']]),
    ]), [{ workId: 'd1', title: 'Architecture' }])
    expect(markdown).toBe(`${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n\nAfter\n`)
    expect(lossyParts).toEqual([])
  })

  test('the section breaks around a figure page leave nothing in the markdown', () => {
    // WHY: a landscape diagram sits between two section breaks, each behind
    // an empty paragraph; a pull must read straight through them.
    const embed = serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })
    const { markdown } = documentToMarkdown(doc([
      paragraph([['Intro\n']]),
      paragraph([['\n']]),
      { startIndex: 7, endIndex: 8 },
      { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'img' } }, { textRun: { content: '\n' } }] } },
      paragraph([['Architecture\n']]),
      paragraph([['\n']]),
      { startIndex: 24, endIndex: 25 },
      paragraph([['After\n']]),
    ]), [{ workId: 'd1', title: 'Architecture' }])
    expect(markdown).toBe(`Intro\n\n${embed}\n\nAfter\n`)
  })

  test('an image Solus did not publish is named as lost, not silently dropped', () => {
    const { markdown, lossyParts } = documentToMarkdown(doc([
      { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'img' } }, { textRun: { content: '\n' } }] } },
      paragraph([['A screenshot\n']]),
    ]))
    expect(markdown).toBe('A screenshot\n')
    expect(lossyParts).toEqual(['image: A screenshot'])
  })
})
