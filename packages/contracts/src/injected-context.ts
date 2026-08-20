// Solus appends reference, work, and task context after the user's typed text.
// Older task-backed sessions can also have a full task packet before that text.
// Keep this pure helper in contracts so both session readers and clients can
// present the user's prompt without exposing Solus's transport context.
const INJECTED_CONTEXT_REGEX = /\[Referenced Plan:|\[Referenced Work:|\[Working On /
const PREPENDED_TASK_PACKET =
  /^\[Working On Task [\s\S]*?\nCall read_task with task_id "[^"]*" to refresh this packet[^\n]*\n+/

export function stripInjectedContext(text: string): string {
  const typed = text.replace(PREPENDED_TASK_PACKET, '')
  const injectedContextIndex = typed.search(INJECTED_CONTEXT_REGEX)
  return injectedContextIndex === -1
    ? typed
    : typed.slice(0, injectedContextIndex).trimEnd()
}
