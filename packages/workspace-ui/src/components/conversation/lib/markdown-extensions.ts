import type { MarkedExtension, Token } from 'marked'

/**
 * GitHub alerts (`> [!NOTE]`) and footnotes (`[^1]`) for assistant replies.
 *
 * Each token carries its body as source text. The renderer parses that text
 * again as markdown, so an alert or a footnote can hold links and code spans.
 */

export const ALERT_TOKEN = 'solusAlert'
export const FOOTNOTE_REF_TOKEN = 'solusFootnoteRef'
export const FOOTNOTE_SECTION_TOKEN = 'solusFootnoteSection'
export const FILE_CHIP_GROUP_TOKEN = 'solusFileChipGroup'

export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export interface Footnote {
  id: string
  text: string
}

const ALERT_RE = /^ {0,3}>[ \t]*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i
const FOOTNOTE_REF_RE = /^\[\^([^\]\s]+)\](?!:)/
const FOOTNOTE_SECTION_RE = /^(?:\[\^[^\]\s]+\]:[^\n]*(?:\n(?!\[\^)(?:[ \t]+[^\n]*|[ \t]*(?=\n)))*(?:\n|$))+/
const FOOTNOTE_DEFINITION_RE = /\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?!\[\^)[^\n]*)*)/g

/** The streaming parser re-lexes only the appended tail when every tokenizer
 *  carries this marker. An alert looks only at `src` from its own block start,
 *  so it is safe; footnotes cross blocks, so they do not carry it. */
const TAIL_WINDOW_SAFE = Symbol.for('svelte-markdown.tailWindowSafe')

function alertTokenizer(src: string) {
  const match = ALERT_RE.exec(src)
  const alertType = ALERT_TYPES.find((type) => type === match?.[1].toLowerCase())
  if (!match || !alertType) return undefined
  const text = match[2]
    .split('\n')
    .map((line) => line.replace(/^ {0,3}> ?/, ''))
    .join('\n')
    .trim()
  return { type: ALERT_TOKEN, raw: match[0], alertType, text }
}
Object.assign(alertTokenizer, { [TAIL_WINDOW_SAFE]: true })

export const alertMarkedExtension: MarkedExtension = {
  extensions: [
    {
      name: ALERT_TOKEN,
      level: 'block',
      start(src: string) {
        const index = src.search(/(?:^|\n) {0,3}>[ \t]*\[!/)
        return index === -1 ? undefined : index
      },
      tokenizer: alertTokenizer,
    },
  ],
}

export const footnoteMarkedExtension: MarkedExtension = {
  extensions: [
    {
      name: FOOTNOTE_REF_TOKEN,
      level: 'inline',
      start(src: string) {
        const index = src.indexOf('[^')
        return index === -1 ? undefined : index
      },
      tokenizer(src: string) {
        const match = FOOTNOTE_REF_RE.exec(src)
        return match ? { type: FOOTNOTE_REF_TOKEN, raw: match[0], id: match[1] } : undefined
      },
    },
    {
      name: FOOTNOTE_SECTION_TOKEN,
      level: 'block',
      start(src: string) {
        const index = src.search(/(?:^|\n)\[\^[^\]\s]+\]:/)
        return index === -1 ? undefined : index
      },
      tokenizer(src: string) {
        const match = FOOTNOTE_SECTION_RE.exec(src)
        if (!match) return undefined
        const footnotes: Footnote[] = []
        for (const definition of match[0].matchAll(FOOTNOTE_DEFINITION_RE)) {
          footnotes.push({ id: definition[1], text: definition[2].trim() })
        }
        return footnotes.length ? { type: FOOTNOTE_SECTION_TOKEN, raw: match[0], footnotes } : undefined
      },
    },
  ],
}

/**
 * `![caption](/Users/me/Application Support/clip.mp4)` as an image. CommonMark
 * ends a destination at the first space, so the reply would show the raw
 * source. Agents are told to embed absolute paths, and the macOS data folder
 * holds a space, so this matches only an absolute or `file:` path with
 * whitespace — the one form CommonMark has already rejected. An optional
 * `"title"` at the end stays the title.
 */
export const SPACED_IMAGE_PATH_RE = /!\[[^\]\n]*\]\((?:\/|file:)[^\n()]*\s/
const SPACED_IMAGE_RE = /^!\[([^\]\n]*)\]\(((?:\/|file:)[^\n()]*?)(?:\s+"([^"\n]*)")?\)/

function spacedImageTokenizer(this: { lexer: { inlineTokens(src: string): Token[] } }, src: string) {
  const match = SPACED_IMAGE_RE.exec(src)
  const href = match?.[2].trim()
  if (!match || !href || !/\s/.test(href)) return undefined
  return {
    type: 'image',
    raw: match[0],
    href,
    title: match[3] ?? null,
    text: match[1],
    tokens: this.lexer.inlineTokens(match[1]),
  }
}
Object.assign(spacedImageTokenizer, { [TAIL_WINDOW_SAFE]: true })

export const spacedImagePathMarkedExtension: MarkedExtension = {
  extensions: [
    {
      name: 'solusSpacedImagePath',
      level: 'inline',
      start(src: string) {
        const index = src.indexOf('![')
        return index === -1 ? undefined : index
      },
      tokenizer: spacedImageTokenizer,
    },
  ],
}

/**
 * A file link and the punctuation right after it, as one token. A file chip is
 * an inline block, so a browser can break the line between the chip and its
 * `.` or `,`, and the mark then starts the next line alone. The renderer keeps
 * the two on one line. `FILE_CHIP_PUNCTUATION_RE` finds the candidates in a
 * reply. Both take only a link that `MarkdownLink` draws as a file: like
 * `parseFileHref`, a `file://` URL or a path with no scheme and no `#`.
 */
const FILE_HREF = String.raw`(?:file:\/\/|(?![a-z][a-z0-9+.-]*:|#))[^()\s]+`
export const FILE_CHIP_PUNCTUATION_RE = new RegExp(String.raw`\]\(${FILE_HREF}\)[.,;:!?)]`, 'i')
const FILE_CHIP_GROUP_RE = new RegExp(String.raw`^(\[(?:\\.|[^[\]\\\n])*\]\(${FILE_HREF}\))([.,;:!?)]+)`, 'i')

function fileChipGroupTokenizer(this: { lexer: { inlineTokens(src: string): Token[] } }, src: string) {
  const match = FILE_CHIP_GROUP_RE.exec(src)
  if (!match) return undefined
  // The link alone: lexing the punctuation with it would match this tokenizer again.
  const punctuation = { type: 'text', raw: match[2], text: match[2], escaped: false }
  return { type: FILE_CHIP_GROUP_TOKEN, raw: match[0], tokens: [...this.lexer.inlineTokens(match[1]), punctuation] }
}
Object.assign(fileChipGroupTokenizer, { [TAIL_WINDOW_SAFE]: true })

export const fileChipGroupMarkedExtension: MarkedExtension = {
  extensions: [
    {
      name: FILE_CHIP_GROUP_TOKEN,
      level: 'inline',
      start(src: string) {
        const index = src.indexOf('[')
        return index === -1 ? undefined : index
      },
      tokenizer: fileChipGroupTokenizer,
    },
  ],
}

/** Move to the footnote or back to its reference inside the same reply. Ids
 *  repeat across replies (every reply has a `[^1]`), so the lookup never
 *  leaves the reply that holds the control. */
export function jumpWithinReply(from: HTMLElement, selector: string): void {
  const target = from.closest('.response-markdown')?.querySelector<HTMLElement>(selector)
  if (!target) return
  target.scrollIntoView({ block: 'nearest' })
  target.focus({ preventScroll: true })
}
