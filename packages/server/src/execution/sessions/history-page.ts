import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import { startsHistoryTurn, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'

export interface HistorySegment {
  provider: AgentId
  sessionId: string | null
  projectPath?: string
  divider?: SessionLoadMessage
}

const cursorSchema = z.object({
  scope: z.string(),
  segment: z.number().int().nonnegative(),
  prefix: z.string(),
  before: z.string().optional(),
})

/** Walk lineage from newest to oldest, `turnLimit` user turns at a time. A
 * cursor is tied to the resolved lineage, so it cannot silently page another
 * session or a rewritten chain. */
export async function loadHistoryPage(
  scope: string,
  segments: HistorySegment[],
  turnLimit: number,
  before: string | undefined,
  read: (segment: HistorySegment, turnLimit: number, before?: string) => Promise<ProviderHistoryPage>,
): Promise<ProviderHistoryPage> {
  const cursor = before ? cursorSchema.parse(JSON.parse(before)) : null
  const prefix = (index: number) => JSON.stringify(segments.slice(0, index + 1).map((segment) => [segment.provider, segment.sessionId]))
  if (cursor && (cursor.scope !== scope || cursor.segment >= segments.length || cursor.prefix !== prefix(cursor.segment))) {
    throw new Error('Session history changed. Reopen the session to load earlier messages.')
  }
  let index = cursor?.segment ?? segments.length - 1
  let providerCursor = cursor?.before
  let messages: SessionLoadMessage[] = []
  let turns = 0
  while (index >= 0) {
    const segment = segments[index]
    const page = segment.sessionId
      ? await read(segment, Math.max(1, turnLimit - turns), providerCursor)
      : { messages: [], before: null }
    messages = page.messages.concat(messages)
    turns += page.messages.filter(startsHistoryTurn).length
    if (page.before !== null) {
      return { messages, before: JSON.stringify({ scope, segment: index, prefix: prefix(index), before: page.before }) }
    }
    if (segment.divider) messages.unshift(segment.divider)
    index--
    providerCursor = undefined
    if (turns >= turnLimit && index >= 0) {
      return { messages, before: JSON.stringify({ scope, segment: index, prefix: prefix(index) }) }
    }
  }
  return { messages, before: null }
}
