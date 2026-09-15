import type { ResponseStreamingMode } from '@solus/contracts/host-config'
import type { NormalizedEvent } from '@solus/contracts/types'

const DELIVERY_INTERVAL_MS = 400
const MAX_BUFFERED_CHARS = 24_000

/** Only terminated lines count. Blank lines inside a fence belong to its code. */
export function splitResponseText(text: string) {
  let fence: { marker: string; indent: number } | undefined
  let boundary = 0
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    if (end < 0) break
    const line = text.slice(start, end).replace(/[ \t\r]+$/, '')
    const match = /^( *)(`{3,}|~{3,})/.exec(line)
    if (match) {
      const indent = match[1].length
      const marker = match[2]
      if (!fence) fence = { marker, indent }
      else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length &&
        indent <= fence.indent + 3 && line.length === indent + marker.length) {
        fence = undefined
        boundary = end + 1
      }
    } else if (!fence && /^[ \t]*$/.test(line) && start > 0) {
      boundary = end + 1
    }
    start = end + 1
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) }
}

type TextChunk = Extract<NormalizedEvent, { type: 'text_chunk' }>
interface BufferedResponse {
  text: string
  mode: ResponseStreamingMode
  lastDeliveredAt?: number
  parentToolUseId?: string
}

/** Delivery state is owned by the host, independently of which clients watch it.
 * A mode change takes effect at the next response segment. */
export class ResponseTextBuffer {
  private sessions = new Map<string, Map<string, BufferedResponse>>()

  append(sessionId: string, event: TextChunk, mode: ResponseStreamingMode, now: number): NormalizedEvent[] {
    // Buffered mode preserves the existing child-agent stream.
    if (mode === 'buffered' && event.parentToolUseId && !this.sessions.get(sessionId)?.has(event.parentToolUseId)) return [event]
    let entries = this.sessions.get(sessionId)
    if (!entries) this.sessions.set(sessionId, entries = new Map())
    const key = event.parentToolUseId ?? ''
    let entry = entries.get(key)
    const output: NormalizedEvent[] = []
    if (!entry) {
      entry = { text: '', mode }
      if (event.parentToolUseId) entry.parentToolUseId = event.parentToolUseId
      entries.set(key, entry)
      if (!event.parentToolUseId) output.push({ type: 'text_pending' })
    }
    entry.text += event.text
    if (entry.mode === 'buffered') return output
    const { ready, rest } = splitResponseText(entry.text)
    if (ready.trim() && (entry.lastDeliveredAt === undefined || now - entry.lastDeliveredAt >= DELIVERY_INTERVAL_MS) && rest.length <= MAX_BUFFERED_CHARS) {
      entry.text = rest
      entry.lastDeliveredAt = now
      output.push(this.chunk(entry, ready, true))
    } else if (entry.text.length > MAX_BUFFERED_CHARS) {
      output.push(this.chunk(entry, entry.text, true))
      entry.text = ''
    }
    return output
  }

  beforeEvent(sessionId: string, event: NormalizedEvent): NormalizedEvent[] {
    if (event.type === 'text_chunk' || event.type === 'text_pending') return []
    const entries = this.sessions.get(sessionId)
    if (!entries) return []
    const terminal = (event.type === 'status_change' && event.status !== 'running' && event.status !== 'connecting') || ['task_complete', 'turn_settled', 'error', 'session_dead', 'permission_request', 'question_request', 'plan'].includes(event.type)
    const boundary = terminal || ['assistant_message', 'tool_call', 'tool_result', 'user_message', 'context_compaction'].includes(event.type)
    const parent = 'parentToolUseId' in event ? event.parentToolUseId : undefined
    const output: NormalizedEvent[] = []
    for (const [key, entry] of entries) {
      if (terminal || entry.mode === 'buffered' || (boundary && key === (parent ?? ''))) {
        output.push(this.chunk(entry, entry.text, false))
        entries.delete(key)
      }
    }
    if (!entries.size) this.sessions.delete(sessionId)
    return output
  }

  flush(sessionId: string, bufferedOnly = false): NormalizedEvent[] {
    const entries = this.sessions.get(sessionId)
    if (!entries) return []
    const output: NormalizedEvent[] = []
    for (const [key, entry] of entries) {
      if (bufferedOnly && entry.mode !== 'buffered') continue
      output.push(this.chunk(entry, entry.text, false))
      entries.delete(key)
    }
    if (!entries.size) this.sessions.delete(sessionId)
    return output
  }

  private chunk(entry: BufferedResponse, text: string, streaming: boolean): TextChunk {
    const event: TextChunk = { type: 'text_chunk', text }
    if (entry.mode === 'paragraph') event.streaming = streaming
    if (entry.parentToolUseId) event.parentToolUseId = entry.parentToolUseId
    return event
  }
}
