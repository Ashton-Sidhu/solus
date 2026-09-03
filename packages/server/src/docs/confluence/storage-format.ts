import { Parser } from 'htmlparser2'
import { Marked, Renderer, type Token, type Tokens } from 'marked'
import { diagramEmbedWorkId, serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import { diagramAttachmentWorkId, type DiagramAttachment } from './diagram-attachments'

/**
 * Confluence storage format ↔ markdown.
 *
 * Storage format is XHTML plus Confluence's own `ac:` macro elements, so the
 * mapping is Confluence-specific either way: a general HTML-to-markdown library
 * would still hand back `<ac:structured-macro>` untouched. The parse is adopted
 * (htmlparser2 in XML mode); the mapping is ours.
 *
 * Conversion is lossy in one direction only, and never silently: a macro that
 * markdown cannot carry is named in `lossyParts` so the user is told what a
 * pull dropped instead of discovering it after a publish overwrites the page.
 */

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? value : null
  } catch {
    return null
  }
}

/**
 * Storage format is XHTML, so every tag the renderer emits must be closed and
 * raw HTML in the source markdown must be escaped rather than passed through —
 * an unbalanced tag makes Confluence reject the whole page.
 */
/** The same tokens with every `strong` replaced by its children, in place. */
function unwrapStrong(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => {
    if (token.type !== 'strong') return [token]
    // SAFETY: `type === 'strong'` identifies the token as `Tokens.Strong`,
    // whose `tokens` are its children.
    const strong = token as Tokens.Strong
    return unwrapStrong(strong.tokens)
  })
}

class StorageRenderer extends Renderer {
  /** Work id → the page attachment holding that diagram's PNG. */
  constructor(private readonly diagramAttachments: ReadonlyMap<string, DiagramAttachment>) {
    super()
  }

  override html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeXml(text)
  }

  override br(): string {
    return '<br/>'
  }

  override hr(): string {
    return '<hr/>'
  }

  /**
   * Confluence draws `<th>` bold from its own stylesheet, so a `<strong>`
   * inside one is redundant — and it round-trips into `**` in the markdown,
   * which the next publish would then honour, making the bold permanent.
   */
  override tablecell(token: Tokens.TableCell): string {
    const tag = token.header ? 'th' : 'td'
    const tokens = token.header ? unwrapStrong(token.tokens) : token.tokens
    const align = token.align ? ` style="text-align:${token.align};"` : ''
    return `<${tag}${align}>${this.parser.parseInline(tokens)}</${tag}>`
  }

  override checkbox({ checked }: Tokens.Checkbox): string {
    // Confluence's own task list is a different element with server-owned ids.
    // Plain text round-trips back into markdown task syntax on the next pull.
    return checked ? '[x] ' : '[ ] '
  }

  override code({ text, lang }: Tokens.Code): string {
    const language = lang?.trim().split(/\s+/)[0]
    const parameter = language ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` : ''
    // CDATA cannot nest, so a body containing the terminator must break out of
    // the section and back in, exactly as Confluence itself writes it.
    const body = text.replaceAll(']]>', ']]]]><![CDATA[>')
    return `<ac:structured-macro ac:name="code">${parameter}<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`
  }

  override link({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens)
    // A diagram embed is a link in markdown and a picture on the page. The
    // alt text carries the title, which is what a pull reads the embed's
    // label back from.
    const workId = diagramEmbedWorkId(href)
    const attachment = workId ? this.diagramAttachments.get(workId) : undefined
    if (attachment) {
      // The label's own tokens, not the rendered inline markup: an alt
      // attribute holds text, and marked has already turned `\[` back into `[`.
      const alt = tokens.map((token) => ('text' in token ? token.text : '')).join('')
      return `<ac:image ac:alt="${escapeXml(alt)}" ac:width="${attachment.widthPx}"><ri:attachment ri:filename="${escapeXml(attachment.filename)}"/></ac:image>`
    }
    const safe = safeHref(href)
    if (!safe) return label
    const titleAttribute = title ? ` title="${escapeXml(title)}"` : ''
    return `<a href="${escapeXml(safe)}"${titleAttribute}>${label}</a>`
  }

  override image({ href, text }: Tokens.Image): string {
    const safe = safeHref(href)
    if (!safe) return escapeXml(text)
    return `<ac:image ac:alt="${escapeXml(text)}"><ri:url ri:value="${escapeXml(safe)}"/></ac:image>`
  }
}

export function markdownToStorage(markdown: string, diagramAttachments: ReadonlyMap<string, DiagramAttachment> = new Map()): string {
  const marked = new Marked()
  marked.setOptions({ gfm: true, renderer: new StorageRenderer(diagramAttachments) })
  return String(marked.parse(markdown, { async: false })).trim()
}

// ─── storage → markdown ───

interface ListFrame {
  ordered: boolean
  index: number
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const IGNORED_INLINE = new Set(['span', 'div', 'time', 'font', 'ri:url', 'ri:attachment', 'ri:page'])

interface TableState {
  rows: string[][]
  headerRow: boolean
  firstRowIsHeader: boolean
}

export interface StorageToMarkdownResult {
  markdown: string
  /** Macros and elements markdown could not carry, by name, deduplicated. */
  lossyParts: string[]
}

interface Block {
  text: string
  /** List items are joined by a single newline; every other pair of blocks is
   *  separated by a blank line. A blank line between items would make markdown
   *  read the list as loose and re-render it with paragraph spacing. */
  listItem: boolean
}

/**
 * Walks the storage XHTML once and writes markdown as it goes. Block content is
 * collected in `inline` and flushed when its element closes, which is what lets
 * a nested list interrupt its parent list item without reordering the output.
 */
class StorageWalker {
  private blocks: Block[] = []
  private inline = ''
  private lists: ListFrame[] = []
  private quoteDepth = 0
  private table: TableState | null = null
  /** Inside a `<th>`, where Confluence's own stylesheet supplies the bold. */
  private inHeaderCell = false
  private codeLanguage: string | null = null
  private inPlainTextBody = false
  private inMacroParameter: string | null = null
  private suppressDepth = 0
  /** The alt of the `<ac:image>` being read, held until its source element
   *  arrives; null when no image is open. */
  private imageAlt: string | null = null
  /** `</a>` carries no attributes, so the href waits here for its closing tag. */
  private hrefs: string[] = []
  private readonly lossy = new Set<string>()

  result(): StorageToMarkdownResult {
    this.flush()
    const markdown = this.blocks
      .reduce((text, block, index) => {
        if (index === 0) return block.text
        const separator = block.listItem && this.blocks[index - 1]!.listItem ? '\n' : '\n\n'
        return `${text}${separator}${block.text}`
      }, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { markdown, lossyParts: [...this.lossy] }
  }

  private flush(prefix = ''): void {
    const text = this.inline.replace(/[ \t]+\n/g, '\n').trim()
    this.inline = ''
    if (!text) return
    const quoted = this.quoteDepth > 0 ? text.split('\n').map((line) => `> ${line}`).join('\n') : text
    this.blocks.push({ text: prefix ? `${prefix}${quoted}` : quoted, listItem: prefix !== '' && this.lists.length > 0 })
  }

  private listPrefix(): string {
    const frame = this.lists[this.lists.length - 1]
    if (!frame) return ''
    const indent = '  '.repeat(this.lists.length - 1)
    return frame.ordered ? `${indent}${frame.index}. ` : `${indent}- `
  }

  text(value: string): void {
    if (this.suppressDepth > 0) return
    if (this.inMacroParameter) return
    if (this.inPlainTextBody) {
      this.inline += value
      return
    }
    // Storage format indents its markup; collapsing runs keeps that whitespace
    // out of the prose without touching code, which never reaches here.
    this.inline += value.replace(/\s+/g, ' ')
  }

  open(rawName: string, attribs: Record<string, string>): void {
    const name = rawName.toLowerCase()
    if (this.suppressDepth > 0) {
      this.suppressDepth += 1
      return
    }

    if (name === 'ac:structured-macro') {
      const macro = attribs['ac:name'] ?? 'macro'
      if (macro === 'code') {
        this.flush()
        this.codeLanguage = ''
        return
      }
      // Every other macro is a Confluence feature with no markdown equivalent.
      // Naming it is the honest answer; inventing a rendering is not.
      this.lossy.add(macro)
      this.suppressDepth = 1
      return
    }

    if (name === 'ac:parameter') {
      this.inMacroParameter = attribs['ac:name'] ?? ''
      return
    }

    if (name === 'ac:plain-text-body' || name === 'ac:rich-text-body') {
      this.inPlainTextBody = true
      this.inline = ''
      return
    }

    if (name === 'ac:image') {
      // The source is a child element, so the alt waits here for it. An image
      // whose source Solus cannot address writes nothing at all.
      this.imageAlt = attribs['ac:alt'] ?? ''
      return
    }

    if (name === 'ri:url' && this.imageAlt !== null) {
      this.inline += `![${this.imageAlt}](${attribs['ri:value'] ?? ''})`
      return
    }

    if (name === 'ri:attachment' && this.imageAlt !== null) {
      const filename = attribs['ri:filename'] ?? ''
      const workId = diagramAttachmentWorkId(filename)
      // Solus's own diagram: the filename names the work and the alt carries
      // the title, so the live embed is restored instead of reported lost.
      if (workId) {
        this.inline += serializeDiagramEmbed({ workId, title: this.imageAlt })
      } else {
        this.inline += `![${this.imageAlt}](${filename})`
        this.lossy.add('attachment')
      }
      return
    }

    if (name === 'ac:link' || name === 'ac:task-list' || name === 'ac:task') {
      this.lossy.add(name.replace('ac:', ''))
      return
    }

    if (HEADINGS.has(name) || name === 'p') {
      this.flush()
      return
    }

    if (name === 'ul' || name === 'ol') {
      this.flush()
      this.lists.push({ ordered: name === 'ol', index: 0 })
      return
    }

    if (name === 'li') {
      this.flush()
      const frame = this.lists[this.lists.length - 1]
      if (frame) frame.index += 1
      return
    }

    if (name === 'blockquote') {
      this.flush()
      this.quoteDepth += 1
      return
    }

    if (name === 'table') {
      this.flush()
      this.table = { rows: [], headerRow: false, firstRowIsHeader: false }
      return
    }

    if (name === 'tr' && this.table) {
      this.table.rows.push([])
      this.table.headerRow = false
      return
    }

    if ((name === 'td' || name === 'th') && this.table) {
      if (name === 'th') {
        this.table.headerRow = true
        this.inHeaderCell = true
        if (this.table.rows.length === 1) this.table.firstRowIsHeader = true
      }
      this.inline = ''
      return
    }

    // Confluence draws a header cell bold itself. Writing that bold into the
    // markdown would make the next publish ask for it explicitly, and the
    // emphasis would never come off again.
    if ((name === 'strong' || name === 'b') && this.inHeaderCell) return
    if (name === 'strong' || name === 'b') this.inline += '**'
    else if (name === 'em' || name === 'i') this.inline += '_'
    else if (name === 'del' || name === 's' || name === 'strike') this.inline += '~~'
    else if (name === 'code' && !this.inPlainTextBody) this.inline += '`'
    else if (name === 'a') {
      this.hrefs.push(attribs.href ?? '')
      this.inline += '['
    } else if (name === 'br') this.inline += '\n'
    else if (name === 'hr') {
      this.flush()
      this.blocks.push({ text: '---', listItem: false })
    } else if (name === 'img') {
      this.inline += `![${attribs.alt ?? ''}](${attribs.src ?? ''})`
    } else if (name === 'pre') {
      this.flush()
      this.codeLanguage = ''
      this.inPlainTextBody = true
    } else if (!IGNORED_INLINE.has(name) && !name.startsWith('ac:') && !name.startsWith('ri:')) {
      // Anything unrecognized keeps its text; the tag itself is dropped.
    }
  }

  close(rawName: string): void {
    const name = rawName.toLowerCase()
    if (this.suppressDepth > 0) {
      this.suppressDepth -= 1
      return
    }

    if (name === 'ac:parameter') {
      this.inMacroParameter = null
      return
    }

    if (name === 'ac:structured-macro') {
      if (this.codeLanguage !== null) {
        const fence = `\`\`\`${this.codeLanguage}\n${this.inline.replace(/\n+$/, '')}\n\`\`\``
        this.inline = ''
        this.codeLanguage = null
        this.blocks.push({ text: fence, listItem: false })
      }
      return
    }

    if (name === 'ac:plain-text-body' || name === 'ac:rich-text-body') {
      this.inPlainTextBody = false
      return
    }

    if (name === 'ac:image') {
      this.imageAlt = null
      return
    }

    if (HEADINGS.has(name)) {
      const level = Number(name.slice(1))
      this.flush(`${'#'.repeat(level)} `)
      return
    }

    if (name === 'p') {
      this.flush(this.lists.length && this.inline.trim() ? this.listPrefix() : '')
      return
    }

    if (name === 'li') {
      this.flush(this.listPrefix())
      return
    }

    if (name === 'ul' || name === 'ol') {
      this.flush()
      this.lists.pop()
      return
    }

    if (name === 'blockquote') {
      this.flush()
      this.quoteDepth = Math.max(0, this.quoteDepth - 1)
      return
    }

    if ((name === 'td' || name === 'th') && this.table) {
      const row = this.table.rows[this.table.rows.length - 1]
      row?.push(this.inline.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim())
      this.inline = ''
      this.inHeaderCell = false
      return
    }

    if ((name === 'strong' || name === 'b') && this.inHeaderCell) return

    if (name === 'table' && this.table) {
      this.blocks.push({ text: renderTable(this.table), listItem: false })
      this.table = null
      return
    }

    if (name === 'strong' || name === 'b') this.inline += '**'
    else if (name === 'em' || name === 'i') this.inline += '_'
    else if (name === 'del' || name === 's' || name === 'strike') this.inline += '~~'
    else if (name === 'code' && !this.inPlainTextBody) this.inline += '`'
    else if (name === 'a') {
      const href = this.hrefs.pop() ?? ''
      this.inline += href ? `](${href})` : ']'
    } else if (name === 'pre') {
      const fence = `\`\`\`\n${this.inline.replace(/\n+$/, '')}\n\`\`\``
      this.inline = ''
      this.codeLanguage = null
      this.inPlainTextBody = false
      this.blocks.push({ text: fence, listItem: false })
    }
  }

  parameterValue(value: string): void {
    if (this.inMacroParameter === 'language' && this.codeLanguage !== null) {
      this.codeLanguage = value.trim()
    }
  }

  get readingParameter(): boolean {
    return this.inMacroParameter !== null
  }
}

function renderTable(table: TableState): string {
  const rows = table.rows.filter((row) => row.length > 0)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill('')]
  const header = table.firstRowIsHeader ? pad(rows[0]!) : Array(width).fill('')
  const body = table.firstRowIsHeader ? rows.slice(1) : rows
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`),
  ]
  return lines.join('\n')
}

export function storageToMarkdown(storage: string): StorageToMarkdownResult {
  const walker = new StorageWalker()
  const parser = new Parser(
    {
      onopentag: (name, attribs) => walker.open(name, attribs),
      onclosetag: (name) => walker.close(name),
      ontext: (text) => {
        if (walker.readingParameter) walker.parameterValue(text)
        else walker.text(text)
      },
    },
    { xmlMode: false, recognizeCDATA: true, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(storage)
  parser.end()
  return walker.result()
}
