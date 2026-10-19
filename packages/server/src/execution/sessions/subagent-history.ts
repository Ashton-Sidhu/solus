import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

const childIdentitySchema = z.object({ agent_thread_id: z.string().min(1).max(200) })

interface SubagentHistorySelection {
  /** The child rows the parent transcript embeds, without their parent link. */
  messages: SessionLoadMessage[]
  provider: AgentId
  /** A Codex child kept as its own thread, to read page by page. */
  threadId?: string
}

/**
 * The history of one subagent call in an authorized parent transcript. Only a
 * call the transcript records can resolve, and only to the child it names.
 */
export function selectSubagentHistory(messages: SessionLoadMessage[], toolId: string, provider: AgentId): SubagentHistorySelection {
  const call = messages.find((message) => message.role === 'tool'
    && message.toolId === toolId
    && (message.isSubagent || message.toolName === 'Task' || message.toolName === 'Agent'))
  if (!call) throw new Error('This subagent does not belong to this session.')
  const children = messages
    .filter((message) => message.parentToolUseId === toolId)
    .map(({ parentToolUseId: _parent, ...child }) => child)
  const sourceProvider = call.sourceProvider ?? provider
  const mayHaveChildThread = sourceProvider === 'codex' && call.subagentType === 'codex' && !!call.toolInput
  if (children.length || !mayHaveChildThread) return { messages: children, provider: sourceProvider }
  try {
    const input = childIdentitySchema.safeParse(JSON.parse(call.toolInput!))
    if (input.success) return { messages: [], provider: 'codex', threadId: input.data.agent_thread_id }
  } catch {
    // A legacy call may have no separate child identity.
  }
  return { messages: [], provider: sourceProvider }
}
