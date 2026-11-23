// Solus appends reference, work, host, and task context after the user's typed text.
// Older task-backed sessions can also have a full task packet before that text.
// Keep this pure helper in contracts so both session readers and clients can
// present the user's prompt without exposing Solus's transport context.
export const REVIEW_GUIDE_CONTEXT = '\n\n[Session review guide instructions]\n'

const INJECTED_CONTEXT_REGEX = /\[Referenced Plan:|\[Referenced Work:|\[Referenced Host:|\[Working On /
const SESSION_REFERENCE_BLOCK = /(?:^|\r?\n\r?\n)\[Referenced Session: "(?:(?!\r?\n\r?\n\[Referenced Session: )[\s\S])*?" \(session_id: ([^,\r\n]+), provider: [\w-]+\)\]\r?\nCall read_session with session_id "\1" to read its transcript before responding\.(?=\r?\n\r?\n|$)/g
const PREPENDED_TASK_PACKET =
  /^\[Working On Task [\s\S]*?\nCall read_task with task_id "[^"]*" to refresh this packet[^\n]*\n+/

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

/** Also used when a client reads a history page saved before the host stripped these blocks. */
export function stripSessionReferenceContext(text: string): string {
  return text.replace(SESSION_REFERENCE_BLOCK, '')
}

export function stripInjectedContext(text: string): string {
  const withoutTask = text.replace(PREPENDED_TASK_PACKET, '')
  const boundary = /^\s*\/review-guide(?:\s|$)/.test(withoutTask) ? withoutTask.lastIndexOf(REVIEW_GUIDE_CONTEXT) : -1
  const typed = stripSessionReferenceContext(boundary < 0 ? withoutTask : withoutTask.slice(0, boundary))
  const injectedContextIndex = typed.search(INJECTED_CONTEXT_REGEX)
  return injectedContextIndex === -1
    ? typed
    : typed.slice(0, injectedContextIndex).trimEnd()
}
