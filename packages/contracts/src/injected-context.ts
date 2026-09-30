// Solus appends reference, work, and task context after the user's typed text.
// Older task-backed sessions can also have a full task packet before that text.
// Keep this pure helper in contracts so both session readers and clients can
// present the user's prompt without exposing Solus's transport context.
const INJECTED_CONTEXT_REGEX = /\[Referenced Plan:|\[Referenced Work:|\[Working On /
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

export function stripInjectedContext(text: string): string {
  const typed = text.replace(PREPENDED_TASK_PACKET, '')
  const injectedContextIndex = typed.search(INJECTED_CONTEXT_REGEX)
  return injectedContextIndex === -1
    ? typed
    : typed.slice(0, injectedContextIndex).trimEnd()
}
