/**
 * The markup of a `render_artifact` call that is still being written.
 *
 * The tool input arrives as a growing fragment of JSON, so the `html` argument
 * cannot be read with `JSON.parse` until the call closes — by which point the
 * whole document is already on screen at once. Reading the value out of the
 * partial text is what lets the render appear as the model writes it.
 */

const HTML_ARGUMENT = /"html"\s*:\s*"/

const ESCAPES = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
} as const

/** JSON's own rule: an unrecognised escape stands for the character itself. */
function unescape(char: string): string {
  // SAFETY: the `in` check is the narrowing — the key is a property of ESCAPES.
  return char in ESCAPES ? ESCAPES[char as keyof typeof ESCAPES] : char
}

/** The `html` argument so far, or null when the call has not written one yet.
 *  A truncated escape at the tail is dropped rather than guessed: the next
 *  chunk brings it, and half an escape on screen is worse than one frame of
 *  missing character. */
export function partialArtifactHtml(toolInput: string): string | null {
  const start = HTML_ARGUMENT.exec(toolInput)
  if (!start) return null

  let html = ''
  for (let i = start.index + start[0].length; i < toolInput.length; i++) {
    const char = toolInput[i]
    if (char === '"') break
    if (char !== '\\') {
      html += char
      continue
    }
    const escaped = toolInput[i + 1]
    if (escaped === undefined) break
    if (escaped === 'u') {
      const hex = toolInput.slice(i + 2, i + 6)
      if (hex.length < 4) break
      html += String.fromCharCode(Number.parseInt(hex, 16))
      i += 5
      continue
    }
    html += unescape(escaped)
    i += 1
  }
  return html
}

/** Whether there is enough of a document to be worth rendering. A `<head>`
 *  alone paints nothing, so the frame would flash empty and then fill; waiting
 *  for the body means the first thing the reader sees is content. */
export function artifactHasBody(html: string): boolean {
  return /<body[\s>]/i.test(html)
}
