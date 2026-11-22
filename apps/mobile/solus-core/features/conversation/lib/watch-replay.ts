import type { WireNormalizedEvent } from '@solus/contracts/types'
import type { TranscriptModel } from './transcript-model'

/** A watch can replay the current turn after the history page already showed it.
 * A shared tool id identifies the overlap even if the host truncated its turn log.
 * Keep live state, tool results and any prose missing from the saved turn. */
export function reconcileWatchReplay(model: TranscriptModel, events: WireNormalizedEvent[]): WireNormalizedEvent[] {
  if (!events.length) return events
  const tools = new Set<string>()
  const prose = new Map<string, number>()
  for (let i = model.order.length - 1; i >= 0; i--) {
    const item = model.items.get(model.order[i]!)
    if (item?.kind === 'user') break
    if (item?.kind === 'tool') tools.add(item.toolId)
    if (item?.kind === 'assistant') prose.set(item.text, (prose.get(item.text) ?? 0) + 1)
  }
  const lastMatch = events.findLastIndex(event => event.type === 'tool_call' && !event.parentToolUseId && tools.has(event.toolId))
  if (lastMatch < 0) return events

  const result: WireNormalizedEvent[] = []
  let chunks: Extract<WireNormalizedEvent, { type: 'text_chunk' }>[] = []
  let matchedText: string | null = null
  const consume = (text: string) => {
    const count = prose.get(text) ?? 0
    if (count < 1) return false
    prose.set(text, count - 1)
    return true
  }
  const flush = () => {
    if (!chunks.length) return
    const text = chunks.map(chunk => chunk.text).join('')
    matchedText = consume(text) ? text : null
    if (matchedText === null) for (const chunk of chunks) result.push(chunk)
    chunks = []
  }
  for (const [i, event] of events.entries()) {
    if (i > lastMatch) { result.push(event); continue }
    if (event.type === 'text_chunk' && !event.parentToolUseId) { chunks.push(event); continue }
    flush()
    if (event.type === 'assistant_message' && !event.parentToolUseId && (event.text === matchedText || consume(event.text))) {
      matchedText = null
      continue
    }
    matchedText = null
    if (event.type !== 'tool_call' || event.parentToolUseId || !tools.has(event.toolId)) result.push(event)
  }
  return result
}
