/**
 * How a search snippet says which of its words matched.
 *
 * The full-text index stems and tokenises, so a client cannot re-find the
 * matched words by spelling: "running" finds a message that only says "runs".
 * The index therefore wraps each matched token in these two private-use
 * characters, and every reader either splits on them or strips them. Nothing
 * else in a transcript uses them, so the wrap cannot be confused with text.
 */
export const SNIPPET_HIT_OPEN = '\u0001'
export const SNIPPET_HIT_CLOSE = '\u0002'

/** One run of a snippet: what it says and whether the index matched it. */
export interface SnippetRun {
  text: string
  hit: boolean
}

/** The snippet as prose, for readers that cannot mark it. */
export function plainSnippet(snippet: string): string {
  return snippet.replaceAll(SNIPPET_HIT_OPEN, '').replaceAll(SNIPPET_HIT_CLOSE, '')
}

/** The snippet split into runs, in order, with the markers consumed. An
 *  unmarked snippet is one unhighlighted run, so callers never branch. */
export function snippetRuns(snippet: string): SnippetRun[] {
  const runs: SnippetRun[] = []
  let from = 0
  for (;;) {
    const open = snippet.indexOf(SNIPPET_HIT_OPEN, from)
    if (open < 0) break
    const close = snippet.indexOf(SNIPPET_HIT_CLOSE, open + 1)
    if (close < 0) break
    if (open > from) runs.push({ text: snippet.slice(from, open), hit: false })
    runs.push({ text: snippet.slice(open + 1, close), hit: true })
    from = close + 1
  }
  if (from < snippet.length) runs.push({ text: plainSnippet(snippet.slice(from)), hit: false })
  return runs.length ? runs : [{ text: '', hit: false }]
}

/**
 * The passage of a marked snippet around its first hit, whitespace collapsed,
 * with ellipses where it was cut, still marked. A row shows one line of a
 * snippet, and the index cuts its snippet to a window of tokens the hit can
 * sit anywhere in — so the row cuts again, around the hit, or the marked word
 * falls off the end of the line. Markers do not count toward the length.
 */
export function snippetWindow(snippet: string, before = 32, after = 72): string {
  const runs = snippetRuns(snippet.replace(/\s+/g, ' ').trim())
  let plainLength = 0
  let firstHitAt = -1
  for (const run of runs) {
    if (run.hit && firstHitAt < 0) firstHitAt = plainLength
    plainLength += run.text.length
  }
  if (firstHitAt < 0) return runs.map((run) => run.text).join('').slice(0, before + after)
  const start = Math.max(0, firstHitAt - before)
  const end = Math.min(plainLength, firstHitAt + after)
  let out = ''
  let at = 0
  for (const run of runs) {
    const runStart = Math.max(at, start)
    const runEnd = Math.min(at + run.text.length, end)
    if (runEnd > runStart) {
      const piece = run.text.slice(runStart - at, runEnd - at)
      out += run.hit ? `${SNIPPET_HIT_OPEN}${piece}${SNIPPET_HIT_CLOSE}` : piece
    }
    at += run.text.length
  }
  // A cut that lands on a space leaves a stray gap before the ellipsis.
  return `${start > 0 ? '…' : ''}${out.trim()}${end < plainLength ? '…' : ''}`
}
