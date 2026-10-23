import type { Theme, ThemedToken } from '@pierre/highlights'

/** The HTML of each line of a code block, coloured for both themes. */
export type CodeHighlighter = (code: string) => string[]

interface Highlights {
  codeToTokens: typeof import('@pierre/highlights').codeToTokens
  isSupportedLanguage: typeof import('@pierre/highlights').isSupportedLanguage
  themes: { light: Theme; dark: Theme }
}

let highlightsPromise: Promise<Highlights> | undefined

/** Load the tokenizer and its two themes when the first block needs them; share
 *  them across mounted tabs. The module compiles its WebAssembly on import. A
 *  browser without WebAssembly SIMD (Safari before 16.4) rejects that import,
 *  and every block keeps escaped plain code. */
function loadHighlights(): Promise<Highlights> {
  highlightsPromise ??= Promise.all([
    import('@pierre/highlights'),
    import('@pierre/highlights/themes/github-light'),
    import('@pierre/highlights/themes/github-dark'),
  ]).then(([module, light, dark]) => ({
    codeToTokens: module.codeToTokens,
    isSupportedLanguage: module.isSupportedLanguage,
    themes: { light: light.default, dark: dark.default },
  })).catch(error => {
    highlightsPromise = undefined
    throw error
  })
  return highlightsPromise
}

/** Plain text has a lexer too, but a plain block keeps the escaped source
 *  without a span per line, as it did before. */
const PLAIN_LANGUAGES = new Set(['plain', 'plaintext', 'text', 'txt'])

/** A line this long or longer is one span: a pasted minified file must not
 *  cost thousands of spans. The lexer still reads the line, so later lines
 *  keep their colours. */
const MAX_TOKENIZED_LINE_LENGTH = 1000

/** A highlighter for the language, or `null` when no built-in lexer knows it:
 *  the block then keeps escaped plain code. Every call tokenizes the whole
 *  block; the lexer is fast enough that a streamed block needs no grammar
 *  state between calls, and a line whose text did not change gives the same
 *  markup, so the block keeps that line's DOM. */
export async function loadCodeHighlighter(language: string): Promise<CodeHighlighter | null> {
  const { codeToTokens, isSupportedLanguage, themes } = await loadHighlights()
  const lang = language.toLowerCase().trim()
  if (PLAIN_LANGUAGES.has(lang) || !isSupportedLanguage(lang)) return null
  // Both themes as custom properties on each span; workspace.css picks one.
  const options = { lang, themes, defaultColor: false, tokenizeMaxLineLength: MAX_TOKENIZED_LINE_LENGTH } as const
  return code => codeToTokens(code, options).tokens.map(lineHtml)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Equal runs share one `htmlStyle` map, so its declarations are built once.
const declarationsOf = new WeakMap<NonNullable<ThemedToken['htmlStyle']>, string>()

function lineHtml(tokens: ThemedToken[]): string {
  let html = ''
  for (const token of tokens) {
    const text = escapeHtml(token.content)
    const style = token.htmlStyle
    if (!style) {
      html += text
      continue
    }
    let declarations = declarationsOf.get(style)
    if (declarations === undefined) {
      declarations = Object.entries(style).map(([property, value]) => `${property}:${value}`).join(';')
      declarationsOf.set(style, declarations)
    }
    html += `<span style="${declarations}">${text}</span>`
  }
  return html
}

export function plainCodeLines(code: string): string[] {
  return code.split('\n').map(escapeHtml)
}

/** Highlighting a block that mounted with its text waits for the frame to
 *  paint, then runs block by block in slices that leave room for input. A
 *  transcript that mounts many code blocks paints plain code first; colours
 *  follow without a long task. */
const SLICE_MS = 8
const waiting: Array<() => void> = []
let isScheduled = false

export function highlightAfterPaint(task: () => void): () => void {
  waiting.push(task)
  if (!isScheduled) {
    isScheduled = true
    requestAnimationFrame(() => setTimeout(runSlice, 0))
  }
  return () => {
    const index = waiting.indexOf(task)
    if (index !== -1) waiting.splice(index, 1)
  }
}

function runSlice(): void {
  const until = performance.now() + SLICE_MS
  while (waiting.length && performance.now() < until) waiting.shift()!()
  if (waiting.length) setTimeout(runSlice, 0)
  else isScheduled = false
}
