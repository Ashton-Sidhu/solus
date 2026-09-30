import { Marked, Tokenizer } from 'marked'
import { MarkdownManager } from '@tiptap/markdown'
import type { JSONContent } from '@tiptap/core'
import { documentExtensions } from './schema'

/** The parser option Tiptap takes. Tiptap depends on its own copy of marked,
 *  so its option names that copy's type. */
type TiptapMarked = NonNullable<NonNullable<ConstructorParameters<typeof MarkdownManager>[0]>['marked']>

/** Soft line break: a single newline plus any indentation the wrap carried. */
const SOFT_WRAP = /[ \t]*\n[ \t]*/g

/** Give bold precedence when it encloses the entire contents of a code span. */
export function boldTextInCodeSpan(text: string): string | null {
  const marker = text.startsWith('**') && text.endsWith('**') ? '**'
    : text.startsWith('__') && text.endsWith('__') ? '__'
    : null
  if (!marker) return null

  const content = text.slice(2, -2)
  if (!content || content.trim() !== content || content.startsWith(marker[0]) || content.endsWith(marker[0]) || content.includes(marker)) return null
  return content
}

/**
 * The markdown tokenizer every document reads through.
 *
 * Agent-authored markdown (plans especially) arrives hard-wrapped at ~80–100
 * columns. ProseMirror renders its editable surface with `white-space: pre-wrap`,
 * so those wraps would show as real line breaks: prose would stop mid-column
 * while tables and code blocks still span the full width. CommonMark treats a
 * soft break as a space, so collapse it while tokenizing.
 *
 * Only inline text is rewritten — fenced and indented code arrive as `code`
 * tokens and explicit hard breaks (two trailing spaces) as `br` tokens, so both
 * keep their newlines. `raw` is left alone; marked advances the cursor by it.
 *
 * Fresh instance per editor: `@tiptap/markdown` calls `use()` on whatever
 * instance it's given to register node tokenizers, so a shared one would
 * accumulate duplicates as editors mount.
 */
export function createMarkdownParser(): TiptapMarked {
  const parser = new Marked()
  parser.use({
    extensions: [{
      name: 'boldCodeSpan',
      level: 'inline',
      start: (src) => src.indexOf('`'),
      tokenizer(src) {
        const match = /^(`+)([\s\S]*?)\1(?!`)/.exec(src)
        if (!match) return
        const boldText = boldTextInCodeSpan(match[2])
        if (boldText === null) return
        return { type: 'strong', raw: match[0], text: boldText, tokens: [{ type: 'text', raw: boldText, text: boldText }] }
      },
    }],
    tokenizer: {
      inlineText(src) {
        const token = Tokenizer.prototype.inlineText.call(this, src)
        if (token) token.text = token.text.replace(SOFT_WRAP, ' ')
        return token
      },
    },
  })
  // Tiptap reads only `Lexer`, `defaults`, `lexer`, `use`, and `setOptions`,
  // which a `Marked` instance has with the same signatures.
  // @ts-expect-error Tiptap types this option with its own nested copy of marked.
  return parser
}

let codec: MarkdownManager | null = null

/** One manager for the process: parsing and serializing keep no state
 *  between calls, and building the schema is the expensive part. */
function documentCodec(): MarkdownManager {
  codec ??= new MarkdownManager({ marked: createMarkdownParser(), extensions: documentExtensions() })
  return codec
}

/**
 * A work's markdown as document JSON, the same content the editor builds.
 *
 * Without a DOM, raw HTML in the markdown (not an ```html fence) is kept as
 * literal text; the editor instead parses it with the schema's HTML rules.
 * Do not use this conversion for writes of content that holds raw HTML.
 */
export function parseDocumentMarkdown(markdown: string): JSONContent {
  return documentCodec().parse(markdown)
}

/** Document JSON as the markdown the editor would save. */
export function serializeDocumentMarkdown(doc: JSONContent): string {
  return documentCodec().serialize(doc)
}
