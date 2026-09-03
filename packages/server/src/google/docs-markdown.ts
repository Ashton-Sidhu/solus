import { serializeDiagramEmbed, type DiagramEmbedReference } from '@solus/contracts/diagram-embed'
import type { DocsDocument, DocsParagraph, DocsStructuralElement, DocsTextStyle } from './docs-api'

/**
 * A Google Doc, read through the Docs API → the markdown Solus edits.
 *
 * The document says outright which paragraph is a heading, a bullet, or code,
 * so nothing here is guessed from spacing or glyphs. What markdown cannot
 * carry — an image that is not a Solus diagram — is named in `lossyParts`.
 */

export interface DocsMarkdown {
  markdown: string
  lossyParts: string[]
}

const MONOSPACE_FONTS = new Set([
  'Courier New', 'Courier', 'Consolas', 'Roboto Mono', 'Source Code Pro', 'Menlo', 'Monaco',
  'Fira Code', 'Fira Mono', 'JetBrains Mono', 'Ubuntu Mono', 'Inconsolata', 'IBM Plex Mono',
])
const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN'])
const HEADING_LEVELS = new Map<string, number>([
  ['TITLE', 1],
  ['SUBTITLE', 2],
  ['HEADING_1', 1],
  ['HEADING_2', 2],
  ['HEADING_3', 3],
  ['HEADING_4', 4],
  ['HEADING_5', 5],
  ['HEADING_6', 6],
])

interface Run {
  text: string
  style: DocsTextStyle
}

type Item =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'blank' }

function isCode(style: DocsTextStyle | undefined): boolean {
  const family = style?.weightedFontFamily?.fontFamily
  return !!family && MONOSPACE_FONTS.has(family)
}

function sameStyle(a: DocsTextStyle, b: DocsTextStyle): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strikethrough === !!b.strikethrough
    && isCode(a) === isCode(b) && a.link?.url === b.link?.url
}

function paragraphRuns(paragraph: DocsParagraph): Run[] {
  const runs: Run[] = []
  for (const element of paragraph.elements) {
    if (!element.textRun) continue
    const style = element.textRun.textStyle ?? {}
    const last = runs[runs.length - 1]
    if (last && sameStyle(last.style, style)) last.text += element.textRun.content
    else runs.push({ text: element.textRun.content, style })
  }
  const last = runs[runs.length - 1]
  if (last) last.text = last.text.replace(/\n$/, '')
  return runs
}

function wrap(text: string, marker: string): string {
  // Markdown markers must hug the text, so surrounding whitespace moves out.
  const match = /^(\s*)(.*?)(\s*)$/s.exec(text)
  if (!match || !match[2]) return text
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`
}

interface InlineOptions {
  /** A heading is bold in Docs by its named style; markdown must not say so
   *  a second time. */
  heading: boolean
  /** False where the mono face is a label rather than code — a table header. */
  monoIsCode?: boolean
}

function inlineMarkdown(runs: Run[], options: InlineOptions): string {
  return runs.map((run) => {
    const text = run.text.replaceAll('\u000b', '\n')
    if (!text.trim()) return text
    if (isCode(run.style) && options.monoIsCode !== false) {
      const fence = text.includes('`') ? '``' : '`'
      return `${fence}${text}${fence}`
    }
    let out = text
    if (run.style.strikethrough) out = wrap(out, '~~')
    if (run.style.italic) out = wrap(out, '*')
    if (run.style.bold && !options.heading) out = wrap(out, '**')
    if (run.style.link?.url) out = `[${out.trim()}](${run.style.link.url})`
    return out
  }).join('')
}

class MarkdownWriter {
  readonly items: Item[] = []
  readonly lossy = new Set<string>()
  private readonly byTitle: Map<string, DiagramEmbedReference>

  constructor(private readonly doc: DocsDocument, diagrams: DiagramEmbedReference[]) {
    this.byTitle = new Map(diagrams.map((diagram) => [diagram.title, diagram]))
  }

  content(elements: DocsStructuralElement[]): void {
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]
      if (element.table) {
        this.table(element.table.tableRows.map((row) => row.tableCells.map((cell) => cell.content)))
        continue
      }
      const paragraph = element.paragraph
      if (!paragraph) continue
      if (paragraph.elements.some((part) => part.inlineObjectElement)) {
        index = this.image(paragraph, elements, index)
        continue
      }
      this.paragraph(paragraph)
    }
  }

  private paragraph(paragraph: DocsParagraph): void {
    const runs = paragraphRuns(paragraph)
    const plain = runs.map((run) => run.text).join('')
    if (!plain.trim()) {
      this.items.push({ kind: 'blank' })
      return
    }
    const named = paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'
    const level = HEADING_LEVELS.get(named)
    if (level && !paragraph.bullet) {
      this.items.push({ kind: 'paragraph', text: `${'#'.repeat(level)} ${inlineMarkdown(runs, { heading: true }).trim()}` })
      return
    }
    if (paragraph.bullet) {
      const depth = paragraph.bullet.nestingLevel ?? 0
      const glyph = this.doc.lists?.[paragraph.bullet.listId]?.listProperties.nestingLevels[depth]?.glyphType
      const marker = glyph && ORDERED_GLYPHS.has(glyph) ? '1.' : '-'
      this.items.push({ kind: 'list', text: `${'  '.repeat(depth)}${marker} ${inlineMarkdown(runs, { heading: false }).trim()}` })
      return
    }
    if (runs.every((run) => !run.text.trim() || isCode(run.style))) {
      this.items.push({ kind: 'code', text: plain })
      return
    }
    const text = inlineMarkdown(runs, { heading: false }).trim()
    const quoted = (paragraph.paragraphStyle?.indentStart?.magnitude ?? 0) > 0
    this.items.push({ kind: 'paragraph', text: quoted ? text.split('\n').map((line) => `> ${line}`).join('\n') : text })
  }

  /** An image paragraph, and the caption paragraph Solus wrote after it. */
  private image(paragraph: DocsParagraph, elements: DocsStructuralElement[], index: number): number {
    const own = paragraphRuns(paragraph).map((run) => run.text).join('').trim()
    let captionIndex = index + 1
    let caption = ''
    while (captionIndex < elements.length) {
      const next = elements[captionIndex].paragraph
      if (!next) break
      caption = paragraphRuns(next).map((run) => run.text).join('').trim()
      if (caption) break
      captionIndex += 1
    }
    const diagram = this.byTitle.get(own) ?? this.byTitle.get(caption)
    if (diagram) {
      this.items.push({ kind: 'paragraph', text: serializeDiagramEmbed(diagram) })
      return this.byTitle.get(caption) === diagram ? captionIndex : index
    }
    this.lossy.add(`image: ${own || caption || 'untitled'}`)
    if (own) this.items.push({ kind: 'paragraph', text: own })
    return index
  }

  private table(rows: DocsStructuralElement[][][]): void {
    // A header cell carries its treatment — the mono face, and bold in a doc
    // an older publish wrote — as style, never as content. Reading either one
    // back as markdown would put `**` or backticks in the text, and the next
    // publish would then bold it for real, forever.
    const cellText = (content: DocsStructuralElement[], header: boolean) =>
      content
        .map((element) => (element.paragraph ? inlineMarkdown(paragraphRuns(element.paragraph), { heading: header, monoIsCode: !header }).trim() : ''))
        .filter(Boolean)
        .join(' ')
        .replaceAll('|', '\\|')
        .replaceAll('\n', ' ')
    const lines = rows.map((row, index) => `| ${row.map((cell) => cellText(cell, index === 0)).join(' | ')} |`)
    if (lines.length === 0) return
    const columns = rows[0].length
    lines.splice(1, 0, `|${' --- |'.repeat(columns)}`)
    this.items.push({ kind: 'paragraph', text: lines.join('\n') })
  }

  result(): DocsMarkdown {
    const blocks: string[] = []
    let code: string[] | null = null
    let pendingBlankInCode = 0
    const closeCode = () => {
      if (code) blocks.push(`\`\`\`\n${code.join('\n')}\n\`\`\``)
      code = null
      pendingBlankInCode = 0
    }
    let previous: Item['kind'] | null = null
    for (const item of this.items) {
      if (item.kind === 'code') {
        if (!code) code = []
        while (pendingBlankInCode > 0) {
          code.push('')
          pendingBlankInCode -= 1
        }
        code.push(item.text)
        previous = 'code'
        continue
      }
      if (item.kind === 'blank') {
        if (code) pendingBlankInCode += 1
        continue
      }
      closeCode()
      if (item.kind === 'list' && previous === 'list') blocks[blocks.length - 1] += `\n${item.text}`
      else blocks.push(item.text)
      previous = item.kind
    }
    closeCode()
    return { markdown: blocks.join('\n\n').trim() + '\n', lossyParts: [...this.lossy] }
  }
}

export function documentToMarkdown(doc: DocsDocument, diagrams: DiagramEmbedReference[] = []): DocsMarkdown {
  const writer = new MarkdownWriter(doc, diagrams)
  writer.content(doc.body?.content ?? [])
  return writer.result()
}
