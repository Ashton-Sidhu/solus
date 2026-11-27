// Solus appends reference, work, and host context after the user's typed text.
// Keep this pure helper in contracts so both session readers and clients can
// present the user's prompt without exposing Solus's transport context.
export const REVIEW_GUIDE_CONTEXT = '\n\n[Session review guide instructions]\n'

const INJECTED_CONTEXT_REGEX = /\[Referenced Plan:|\[Referenced Work:|\[Referenced Host:/
const DRAFT_REFERENCE_BLOCK = /(?:^|\r?\n\r?\n)\[Referenced Draft\] \{[^\r\n]*\}(?=\r?\n\r?\n|$)/g
const SESSION_REFERENCE_BLOCK = /(?:^|\r?\n\r?\n)\[Referenced Session: "(?:(?!\r?\n\r?\n\[Referenced Session: )[\s\S])*?" \(session_id: ([^,\r\n]+), provider: [\w-]+\)\]\r?\nCall read_session with session_id "\1" to read its transcript before responding\.(?=\r?\n\r?\n|$)/g

/** The `[Attached file: <path>]` block the composer puts before the typed text. */
const LEADING_ATTACHED_FILES = /^(?:\[Attached file: [^\n]+\]\n)+\n/

/**
 * The typed text without the composer's attached-file lines, for a title or a
 * preview. The transcript keeps the lines: a reloaded bubble rebuilds its file
 * chips from them.
 */
export function stripAttachedFileLines(text: string): string {
  return text.replace(LEADING_ATTACHED_FILES, '')
}

/** The composer puts one attachment path per line before a blank line and the prompt. */
export function splitPromptFiles(content: string) {
  const paths: string[] = []
  if (!content.startsWith('[Attached file: ')) return { text: content, paths }
  const lines = content.split('\n')
  for (const line of lines) {
    const path = /^\[Attached file: (.+)\]$/.exec(line)?.[1]
    if (!path) break
    paths.push(path)
  }
  if (!paths.length || (paths.length < lines.length && lines[paths.length] !== '')) return { text: content, paths: [] }
  return { text: lines.slice(paths.length).join('\n').replace(/^\n+/, ''), paths }
}

/** Also used when a client reads a history page saved before the host stripped these blocks. */
export function stripSessionReferenceContext(text: string): string {
  return text.replace(DRAFT_REFERENCE_BLOCK, '').replace(SESSION_REFERENCE_BLOCK, '')
}

export function stripInjectedContext(text: string): string {
  const boundary = /^\s*\/review-guide(?:\s|$)/.test(text) ? text.lastIndexOf(REVIEW_GUIDE_CONTEXT) : -1
  const typed = stripSessionReferenceContext(boundary < 0 ? text : text.slice(0, boundary))
  const injectedContextIndex = typed.search(INJECTED_CONTEXT_REGEX)
  return injectedContextIndex === -1
    ? typed
    : typed.slice(0, injectedContextIndex).trimEnd()
}
