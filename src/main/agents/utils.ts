
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

export function stripInjectedContext(text: string): string {
  const idx = text.search(INJECTED_CONTEXT_REGEX)
  return idx !== -1 ? text.slice(0, idx).trimEnd() : text
}
