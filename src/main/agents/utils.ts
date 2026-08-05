
// Canonical home is shared/types.ts so renderer and main share one encoder.
// Re-exported here to keep existing `../utils` import sites stable.
export { encodePathAsFolder } from '../../shared/types'

// Solus appends context blocks (referenced plans/works, the bound "Working On"
// work, the "[Working On Task — …]" ticket) after the user's typed text before
// sending to the agent. In a live session the stored message keeps only the typed
// text; on resume we read the raw agent prompt, so strip everything from the first
// injected marker onward. `\[Working On ` matches both the bound-work block
// (`[Working On - …]`) and the task block (`[Working On Task — …]`).
const INJECTED_CONTEXT_REGEX = /\[Referenced Plan:|\[Referenced Work:|\[Working On /
// The task packet now rides the system prompt, but sessions started before that
// have it prepended to their first prompt on disk. It is the one block that goes
// *before* the typed text, so stripping from its marker onward like the trailing
// blocks would delete the whole message, leaving those sessions with no user turn
// at all — and, with no turn to lead it, the entire transcript folds into one
// headless activity row. The packet always closes with its read_task line
// (formatTaskContext), so cut through that.
const PREPENDED_TASK_PACKET =
  /^\[Working On Task [\s\S]*?\nCall read_task with task_id "[^"]*" to refresh this packet[^\n]*\n+/

export function stripInjectedContext(text: string): string {
  const typed = text.replace(PREPENDED_TASK_PACKET, '')
  const idx = typed.search(INJECTED_CONTEXT_REGEX)
  return idx !== -1 ? typed.slice(0, idx).trimEnd() : typed
}
