import { Marked, Tokenizer } from 'marked'

/** Soft line break: a single newline plus any indentation the wrap carried. */
const SOFT_WRAP = /[ \t]*\n[ \t]*/g

/**
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
export function createMarkdownParser(): Marked {
  const parser = new Marked()
  parser.use({
    tokenizer: {
      inlineText(src) {
        const token = Tokenizer.prototype.inlineText.call(this, src)
        if (token) token.text = token.text.replace(SOFT_WRAP, ' ')
        return token
      },
    },
  })
  return parser
}
