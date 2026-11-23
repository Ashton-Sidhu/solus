import { z } from 'zod'
import type { SessionHistoryPageRequest, ProviderHistoryPage } from '@solus/contracts/session-history'
import type { AgentId, SessionRecord } from '@solus/contracts/types'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { SessionRuntime } from '../session-runtime'

const cursorSchema = z.object({ fork: z.string(), before: z.string() })

export function savedResponseFork(record: SessionRecord | null | undefined) {
  return record?.startedBy?.kind === 'person' ? record.startedBy.fork : undefined
}

export function needsResponseFork(sessionId: string): boolean {
  return !resolveSessionLineageById(sessionId)?.active.providerSessionId
}

/** Search backward in bounded provider pages. Only saved assistant rows that
 * name a provider checkpoint can set the boundary. */
export async function readResponseForkPage(
  runtime: SessionRuntime,
  input: {
    sessionId: string
    sourceThreadId: string
    provider: AgentId
    cwd: string | null
    pointId: string
    throughPointId?: string
    turnLimit: number
    before?: string
  },
): Promise<ProviderHistoryPage> {
  const backend = runtime.backendFor(input.provider)
  if (!backend.loadSessionPage) throw new Error('This provider cannot fork from a response.')
  const cursor = input.before ? cursorSchema.parse(JSON.parse(input.before)) : null
  if (cursor && cursor.fork !== input.sessionId) throw new Error('Invalid fork history cursor.')
  let before = cursor?.before
  let throughPointId = input.throughPointId
  for (;;) {
    const page = await backend.loadSessionPage(input.sourceThreadId, input.cwd ?? undefined, input.turnLimit, before, true)
    const boundary = (pointId: string) => page.messages.findLastIndex(
      (message) => message.role === 'assistant' && !message.parentToolUseId && message.forkPointId === pointId,
    )
    const last = throughPointId ? boundary(throughPointId) : page.messages.length - 1
    if (last >= 0) throughPointId = undefined
    const checkpoint = cursor ? last : page.messages.slice(0, last + 1).findLastIndex(
      (message) => message.role === 'assistant' && !message.parentToolUseId && message.forkPointId === input.pointId,
    )
    if (cursor || checkpoint >= 0) {
      return {
        messages: page.messages.slice(0, checkpoint + 1).map((message) => ({
          ...message,
          sourceSessionId: input.sourceThreadId,
          sourceProvider: input.provider,
        })),
        before: page.before === null ? null : JSON.stringify({ fork: input.sessionId, before: page.before }),
      }
    }
    if (page.before === null) throw new Error('The selected response is no longer available to fork.')
    if (page.before === before) throw new Error('The provider repeated a history cursor.')
    before = page.before
  }
}

export function isResponseForkCursor(before: SessionHistoryPageRequest['before']): boolean {
  return before?.startsWith('{"fork":') ?? false
}
