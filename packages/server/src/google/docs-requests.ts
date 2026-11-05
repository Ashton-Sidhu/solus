import { Marked, type MarkedToken, type Token, type Tokens } from 'marked'
import type {
  DocsBulletPreset,
  DocsColor,
  DocsDimension,
  DocsParagraphBorder,
  DocsRequest,
  DocsTableCellBorder,
  DocsWrittenParagraphStyle,
  DocsWrittenSectionStyle,
  DocsWrittenTextStyle,
} from './docs-api'

/**
 * Markdown → Google Docs `batchUpdate` requests.
 *
 * Two stages, because the Docs API addresses everything by character index
 * and a table's indices are only knowable after it exists. `compileDocsBlocks`
 * turns markdown into a flat list of blocks, pure and testable. The publisher
 * then walks the blocks: runs of paragraphs become one batch whose
 * indices are computed here, and each table is inserted, read back, and filled
 * by `tableRequests` before the walk continues.
 */

/** A Google Font Docs ships with; Courier New is the one thing that makes a
 *  document look like 1998. */
export const CODE_FONT = 'Roboto Mono'

/** The body's content starts after the section break the document is born with. */
export const BODY_START = 1

/** The document's own margins. */
const PAGE_MARGIN_PT = 72

function pt(magnitude: number): DocsDimension {
  return { magnitude, unit: 'PT' }
}

function rgb(hex: string): DocsColor {
  const value = Number.parseInt(hex.slice(1), 16)
  return { color: { rgbColor: { red: ((value >> 16) & 255) / 255, green: ((value >> 8) & 255) / 255, blue: (value & 255) / 255 } } }
}

/**
 * The Solus document palette, from `workspace-ui/src/index.css`. Nothing in a
 * Solus document sits on a fill: no chip behind a code span, no card behind a
 * code block, no shaded table header. Structure is carried by warm rules and
 * by the mono face, and that is what a published doc must look like too.
 */
const INK = rgb('#343022')
const MUTED = rgb('#7d7a6e')
/** `--solus-art-border`, the rule that opens and closes a table and runs down
 *  the side of a code block. */
const RULE = rgb('#ebe5d8')
/** `--solus-doc-rule`: the same warm sand, faded, resolved against the white
 *  page a Google Doc is printed on. */
const ROW_RULE_COLOR = rgb('#f3ecdf')
const NO_CELL_BORDER: DocsTableCellBorder = { width: pt(0), dashStyle: 'SOLID', color: rgb('#ffffff') }

/** Every field a run or paragraph can carry is named on every update, so a
 *  style never leaks from the neighbouring text the API copies it from. */
const TEXT_FIELDS = 'bold,italic,strikethrough,weightedFontFamily,fontSize,foregroundColor,backgroundColor,link'
const PARAGRAPH_FIELDS =
  'namedStyleType,alignment,indentStart,indentEnd,indentFirstLine,spaceAbove,spaceBelow,lineSpacing,shading,borderTop,borderBottom,borderLeft,borderRight,borderBetween'

const NORMAL: DocsWrittenParagraphStyle = { namedStyleType: 'NORMAL_TEXT', spaceBelow: pt(8) }
const QUOTE: DocsWrittenParagraphStyle = { ...NORMAL, indentStart: pt(36) }
const RULE_PARAGRAPH: DocsWrittenParagraphStyle = {
  namedStyleType: 'NORMAL_TEXT',
  spaceBelow: pt(8),
  borderBottom: { width: pt(1), padding: pt(4), dashStyle: 'SOLID', color: RULE },
}
/** The left rule, with the gap between it and the code held as its padding. */
const CODE_RULE: DocsParagraphBorder = { width: pt(1), padding: pt(12), dashStyle: 'SOLID', color: RULE }
const NO_BORDER: DocsParagraphBorder = { width: pt(0), padding: pt(0), dashStyle: 'SOLID', color: RULE }

/**
 * A code block is a rule and nothing else — no frame, no fill. Every line
 * carries the identical left border, which is how Docs draws one continuous
 * rule down a run of paragraphs instead of a stack of separate ones.
 */
function codeParagraph(last: boolean): DocsWrittenParagraphStyle {
  return {
    namedStyleType: 'NORMAL_TEXT',
    indentStart: pt(0),
    indentEnd: pt(0),
    spaceAbove: pt(0),
    spaceBelow: pt(last ? 16 : 0),
    lineSpacing: 180,
    borderLeft: CODE_RULE,
    borderTop: NO_BORDER,
    borderBottom: NO_BORDER,
    borderRight: NO_BORDER,
    borderBetween: NO_BORDER,
  }
}

const CODE_TEXT: DocsWrittenTextStyle = { weightedFontFamily: { fontFamily: CODE_FONT }, fontSize: pt(9.5), foregroundColor: INK }
const CELL_TEXT: DocsWrittenTextStyle = { fontSize: pt(10), foregroundColor: INK }
/** A header cell is the mono face in tertiary ink, never a fill. */
const HEADER_TEXT: DocsWrittenTextStyle = { weightedFontFamily: { fontFamily: CODE_FONT }, fontSize: pt(10), foregroundColor: MUTED }
const CELL_PARAGRAPH: DocsWrittenParagraphStyle = { namedStyleType: 'NORMAL_TEXT', spaceAbove: pt(0), spaceBelow: pt(0), lineSpacing: 130 }
/**
 * A table opens and closes on a rule and separates its rows with a fainter
 * one. No vertical grid, no outer box, no header fill: the mono upper-cased
 * header is what marks the first row.
 */
const TABLE_EDGE: DocsTableCellBorder = { width: pt(1), dashStyle: 'SOLID', color: RULE }
const ROW_RULE: DocsTableCellBorder = { width: pt(0.5), dashStyle: 'SOLID', color: ROW_RULE_COLOR }

const SECTION_FIELDS = 'flipPageOrientation,marginTop,marginBottom,marginLeft,marginRight'

/** A document is portrait prose. */
function sectionStyle(): DocsWrittenSectionStyle {
  const margin = pt(PAGE_MARGIN_PT)
  return { flipPageOrientation: false, marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin }
}

/** Style the section that holds `index`. */
export function sectionStyleRequest(index: number): DocsRequest {
  return {
    updateSectionStyle: {
      range: { startIndex: index, endIndex: index + 1 },
      sectionStyle: sectionStyle(),
      fields: SECTION_FIELDS,
    },
  }
}

// ─── blocks ───

export interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  code?: boolean
  link?: string
}

export interface StyledRun {
  start: number
  end: number
  style: InlineStyle
}

export interface RichText {
  text: string
  runs: StyledRun[]
}

export interface ParagraphBlock {
  kind: 'paragraph'
  text: RichText
  style: DocsWrittenParagraphStyle
  /** A base style every run inherits: code lines and captions. */
  baseText?: DocsWrittenTextStyle
  bullet?: { preset: DocsBulletPreset; level: number }
}

export interface TableBlock {
  kind: 'table'
  rows: RichText[][]
}

export type DocsBlock = ParagraphBlock | TableBlock

function unescapeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strikethrough === !!b.strikethrough
    && !!a.code === !!b.code && a.link === b.link
}

class RichTextBuilder {
  text = ''
  readonly runs: StyledRun[] = []

  append(value: string, style: InlineStyle): void {
    if (!value) return
    const start = this.text.length
    this.text += value
    const last = this.runs[this.runs.length - 1]
    if (last && last.end === start && sameStyle(last.style, style)) last.end = this.text.length
    else this.runs.push({ start, end: this.text.length, style })
  }

  result(): RichText {
    return { text: this.text, runs: this.runs }
  }
}

/** The lexer here runs with no extensions, so every token is one of marked's
 *  own classes and `type` tells them apart. */
function builtInTokens(tokens: Token[]): MarkedToken[] {
  // SAFETY: `Token` widens to `Tokens.Generic` only for extension tokens, and
  // none are registered on the `Marked` instance that produced these.
  return tokens as MarkedToken[]
}

function inlineTokens(tokens: Token[], style: InlineStyle, out: RichTextBuilder): void {
  for (const token of builtInTokens(tokens)) {
    switch (token.type) {
      case 'text':
        if (token.tokens?.length) inlineTokens(token.tokens, style, out)
        else out.append(token.escaped ? unescapeEntities(token.text) : token.text, style)
        break
      case 'escape':
        out.append(token.text, style)
        break
      case 'strong':
        inlineTokens(token.tokens, { ...style, bold: true }, out)
        break
      case 'em':
        inlineTokens(token.tokens, { ...style, italic: true }, out)
        break
      case 'del':
        inlineTokens(token.tokens, { ...style, strikethrough: true }, out)
        break
      case 'codespan':
        out.append(unescapeEntities(token.text), { ...style, code: true })
        break
      case 'link':
        inlineTokens(token.tokens, { ...style, link: token.href }, out)
        break
      case 'image':
        out.append(token.text, style)
        break
      case 'br':
        // A vertical tab is the Docs API's line break inside one paragraph.
        out.append('\u000b', style)
        break
      case 'html':
        out.append(token.text, style)
        break
      default:
        out.append(token.raw, style)
    }
  }
}

function richText(tokens: Token[], style: InlineStyle = {}): RichText {
  const builder = new RichTextBuilder()
  inlineTokens(tokens, style, builder)
  return builder.result()
}

function unbolded(text: RichText): RichText {
  return { text: text.text, runs: text.runs.map(({ start, end, style }) => ({ start, end, style: { ...style, bold: false } })) }
}

function plainText(text: string): RichText {
  return { text, runs: text ? [{ start: 0, end: text.length, style: {} }] : [] }
}

interface BlockContext {
  quote: boolean
  bullet?: { preset: DocsBulletPreset; level: number }
}

class BlockCompiler {
  readonly blocks: DocsBlock[] = []

  markdown(source: string): void {
    const marked = new Marked()
    marked.setOptions({ gfm: true })
    this.tokens(marked.lexer(source), { quote: false })
  }

  private paragraph(text: RichText, context: BlockContext): void {
    const block: ParagraphBlock = { kind: 'paragraph', text, style: context.quote ? QUOTE : NORMAL }
    if (context.bullet) block.bullet = context.bullet
    this.blocks.push(block)
  }

  private tokens(tokens: Token[], context: BlockContext): void {
    for (const token of builtInTokens(tokens)) {
      switch (token.type) {
        case 'space':
          break
        case 'heading':
          this.blocks.push({
            kind: 'paragraph',
            text: richText(token.tokens),
            style: { namedStyleType: `HEADING_${Math.min(6, token.depth)}` },
          })
          break
        case 'paragraph':
          this.paragraph(richText(token.tokens), context)
          break
        case 'text':
          this.paragraph(token.tokens ? richText(token.tokens) : plainText(token.text), context)
          break
        case 'code': {
          const lines = token.text.split('\n')
          lines.forEach((line, index) => {
            this.blocks.push({
              kind: 'paragraph',
              text: plainText(line),
              style: codeParagraph(index === lines.length - 1),
              baseText: CODE_TEXT,
            })
          })
          break
        }
        case 'blockquote':
          this.tokens(token.tokens, { ...context, quote: true })
          break
        case 'list':
          this.list(token, context)
          break
        case 'table':
          this.blocks.push({
            kind: 'table',
            rows: [
              // The header's treatment is the mono face in tertiary ink, and
              // nothing else. Bold is dropped even when the markdown asks for
              // it, so a doc an older publish bolded does not stay bold; the
              // case is left alone, since Docs has no text-transform and
              // changing it would change what a pull reads back.
              token.header.map((cell) => unbolded(richText(cell.tokens))),
              ...token.rows.map((row) => row.map((cell) => richText(cell.tokens))),
            ],
          })
          // Keep a blank line between the table and the next block, even at the end of the document.
          this.blocks.push({ kind: 'paragraph', text: plainText(''), style: NORMAL })
          break
        case 'hr':
          this.blocks.push({ kind: 'paragraph', text: plainText(''), style: RULE_PARAGRAPH })
          break
        case 'html':
          this.paragraph(plainText(token.text.trim()), context)
          break
        default:
          this.paragraph(plainText(token.raw.trim()), context)
      }
    }
  }

  private list(list: Tokens.List, context: BlockContext): void {
    const preset: DocsBulletPreset = list.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE'
    const level = context.bullet ? context.bullet.level + 1 : 0
    for (const item of list.items) {
      const [first, ...rest] = builtInTokens(item.tokens)
      const bullet = { preset, level }
      const lead = first && (first.type === 'text' || first.type === 'paragraph')
        ? richText(first.tokens ?? [])
        : plainText('')
      if (item.task) {
        lead.text = `${item.checked ? '[x] ' : '[ ] '}${lead.text}`
        lead.runs = [{ start: 0, end: 4, style: {} }, ...lead.runs.map((run) => ({ ...run, start: run.start + 4, end: run.end + 4 }))]
      }
      this.paragraph(lead, { ...context, bullet })
      const body = first && !(first.type === 'text' || first.type === 'paragraph') ? item.tokens : rest
      this.tokens(body, { ...context, bullet })
    }
  }
}

export function compileDocsBlocks(markdown: string): DocsBlock[] {
  const compiler = new BlockCompiler()
  compiler.markdown(markdown)
  return compiler.blocks
}

// ─── requests ───

function textStyleFor(style: InlineStyle, base: DocsWrittenTextStyle | undefined): DocsWrittenTextStyle {
  // Bold, italic, and strikethrough are stated both ways rather than cleared,
  // so a run never depends on what a named style would have inherited.
  const written: DocsWrittenTextStyle = {
    ...base,
    bold: !!style.bold,
    italic: !!style.italic,
    strikethrough: !!style.strikethrough,
  }
  if (style.code) {
    // The mono face in strong ink, with no chip behind it: a fill on every
    // span pockmarks dense technical prose, and accent ink would compete with
    // the real links beside it.
    written.weightedFontFamily = { fontFamily: CODE_FONT }
    written.fontSize = pt(10)
    written.foregroundColor = INK
  }
  if (style.link) written.link = { url: style.link }
  return written
}

function runRequests(text: RichText, at: number, base: DocsWrittenTextStyle | undefined): DocsRequest[] {
  return text.runs.map((run) => ({
    updateTextStyle: {
      range: { startIndex: at + run.start, endIndex: at + run.end },
      textStyle: textStyleFor(run.style, base),
      fields: TEXT_FIELDS,
    },
  }))
}

export interface BatchPlan {
  requests: DocsRequest[]
  /** Where the next block goes once these requests have run. */
  endIndex: number
}

/**
 * Requests for a run of paragraph blocks appended at
 * `startIndex`. Indices are tracked through every insert; a bullet request
 * removes the leading tabs that encode nesting, so the cursor steps back by
 * that count when a list closes.
 */
export function blockRequests(blocks: ParagraphBlock[], startIndex: number): BatchPlan {
  const requests: DocsRequest[] = []
  let cursor = startIndex
  let bullets: { preset: DocsBulletPreset; start: number; end: number; tabs: number } | null = null

  const closeBullets = () => {
    if (!bullets) return
    requests.push({ createParagraphBullets: { range: { startIndex: bullets.start, endIndex: bullets.end }, bulletPreset: bullets.preset } })
    cursor -= bullets.tabs
    bullets = null
  }

  for (const block of blocks) {
    // A list closes before the next block is placed: the bullet request
    // shortens the text, and the cursor must follow before anything lands.
    if (!block.bullet || (bullets && bullets.preset !== block.bullet.preset)) closeBullets()

    const prefix = block.bullet ? '\t'.repeat(block.bullet.level) : ''
    const text = `${prefix}${block.text.text}\n`
    requests.push({ insertText: { location: { index: cursor }, text } })
    // The paragraph's named style goes on first; the runs are styled after
    // it, so nothing the named style carries can override a bold or a font.
    requests.push({ updateParagraphStyle: { range: { startIndex: cursor, endIndex: cursor + text.length }, paragraphStyle: block.style, fields: PARAGRAPH_FIELDS } })
    requests.push(...runRequests(block.text, cursor + prefix.length, block.baseText))

    if (block.bullet) {
      if (!bullets) bullets = { preset: block.bullet.preset, start: cursor, end: cursor, tabs: 0 }
      bullets.end = cursor + text.length
      bullets.tabs += block.bullet.level
    }
    cursor += text.length
  }
  closeBullets()
  return { requests, endIndex: cursor }
}

export interface TableCellSlot {
  /** The cell's own start index in the document; its empty paragraph begins
   *  one after it. */
  startIndex: number
}

/**
 * Fill a table the document already holds. Cells are written last to first so
 * that no insert moves a cell still waiting to be written.
 */
export function tableRequests(table: TableBlock, tableStartIndex: number, cells: TableCellSlot[][]): DocsRequest[] {
  const columns = table.rows[0]?.length ?? 0
  const requests: DocsRequest[] = []
  if (columns > 0) {
    const cellRange = (rowIndex: number, rowSpan: number) => ({
      tableCellLocation: { tableStartLocation: { index: tableStartIndex }, rowIndex, columnIndex: 0 },
      rowSpan,
      columnSpan: columns,
    })
    const CELL_FIELDS = 'backgroundColor,paddingTop,paddingBottom,paddingLeft,paddingRight,borderTop,borderBottom,borderLeft,borderRight'
    requests.push({
      updateTableCellStyle: {
        tableRange: cellRange(0, table.rows.length),
        tableCellStyle: {
          // No fill anywhere, including the header: `backgroundColor` is named
          // in the fields so Docs' own default grey is cleared.
          backgroundColor: rgb('#ffffff'),
          paddingTop: pt(7),
          paddingBottom: pt(7),
          paddingLeft: pt(7),
          paddingRight: pt(7),
          borderTop: ROW_RULE,
          borderBottom: ROW_RULE,
          borderLeft: NO_CELL_BORDER,
          borderRight: NO_CELL_BORDER,
        },
        fields: CELL_FIELDS,
      },
    })
    // The table's own opening and closing rules are heavier than the ones
    // between rows, which is what makes it read as a band rather than a grid.
    requests.push({
      updateTableCellStyle: {
        tableRange: cellRange(0, 1),
        tableCellStyle: { borderTop: TABLE_EDGE, borderBottom: TABLE_EDGE },
        fields: 'borderTop,borderBottom',
      },
    })
    if (table.rows.length > 1) {
      requests.push({
        updateTableCellStyle: {
          tableRange: cellRange(table.rows.length - 1, 1),
          tableCellStyle: { borderBottom: TABLE_EDGE },
          fields: 'borderBottom',
        },
      })
    }
    columnWidthsPt(table).forEach((width, column) => {
      requests.push({
        updateTableColumnProperties: {
          tableStartLocation: { index: tableStartIndex },
          columnIndices: [column],
          tableColumnProperties: { widthType: 'FIXED_WIDTH', width: pt(width) },
          fields: 'widthType,width',
        },
      })
    })
  }
  for (let row = table.rows.length - 1; row >= 0; row -= 1) {
    for (let column = table.rows[row].length - 1; column >= 0; column -= 1) {
      const slot = cells[row]?.[column]
      const text = table.rows[row][column]
      if (!slot) continue
      const at = slot.startIndex + 1
      if (text.text) requests.push({ insertText: { location: { index: at }, text: text.text } })
      requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + text.text.length + 1 }, paragraphStyle: CELL_PARAGRAPH, fields: PARAGRAPH_FIELDS } })
      requests.push(...runRequests(text, at, row === 0 ? HEADER_TEXT : CELL_TEXT))
    }
  }
  return requests
}

/** The printable width of a portrait page, in points. */
const TABLE_WIDTH_PT = 468
const MIN_COLUMN_SHARE = 0.16

/**
 * Column widths that follow the content: each column takes a share of the
 * page proportional to its longest cell, with a floor so a column of short
 * ids stays readable next to a column of prose.
 */
export function columnWidthsPt(table: TableBlock): number[] {
  const columns = table.rows[0]?.length ?? 0
  if (columns === 0) return []
  const longest = Array.from({ length: columns }, (_, column) =>
    Math.max(1, ...table.rows.map((row) => Math.min(60, row[column]?.text.length ?? 0))),
  )
  const total = longest.reduce((sum, length) => sum + length, 0)
  const raw = longest.map((length) => length / total)
  const narrow = raw.map((share) => share < MIN_COLUMN_SHARE)
  const narrowCount = narrow.filter(Boolean).length
  const wideTotal = raw.reduce((sum, share, column) => (narrow[column] ? sum : sum + share), 0)
  // Narrow columns take exactly the floor; the rest share what is left.
  const shares = raw.map((share, column) =>
    narrowCount === columns ? 1 / columns
      : narrow[column] ? MIN_COLUMN_SHARE
        : (share / wideTotal) * (1 - narrowCount * MIN_COLUMN_SHARE),
  )
  const widths = shares.map((share) => Math.round(share * TABLE_WIDTH_PT))
  widths[widths.length - 1] += TABLE_WIDTH_PT - widths.reduce((sum, width) => sum + width, 0)
  return widths
}
