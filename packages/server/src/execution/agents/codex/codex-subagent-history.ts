import { z } from 'zod'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { isInterruptedTurnStatus } from './codex-utils'

const childInputSchema = z.object({ agent_thread_id: z.string().min(1) })
const turnErrorSchema = z.union([z.string().transform((message) => ({ message })), z.object({ message: z.string() })])

interface CodexSubagentTurn {
  status?: string | null
  error?: unknown
  items?: Array<{ type?: string; text?: string }>
}

/** The same terminal state must settle live cards and restored cards. */
export function codexSubagentTurnResult(turn: CodexSubagentTurn): { status: 'completed' | 'error'; text: string } | null {
  if (turn.status === 'failed') {
    const error = turnErrorSchema.safeParse(turn.error)
    return {
      status: 'error',
      text: error.success ? error.data.message : 'Codex subagent failed',
    }
  }
  if (isInterruptedTurnStatus(turn.status)) return { status: 'error', text: 'Interrupted' }
  if (turn.status !== 'completed') return null
  return {
    status: 'completed',
    text: turn.items?.findLast((item) => item.type === 'agentMessage' && item.text)?.text || 'Done',
  }
}

/** A spawn record says when an agent began, not whether its latest turn ended.
 * Read child summaries only for the cards in the requested history window. */
export async function reconcileCodexSubagentHistory(
  messages: SessionLoadMessage[],
  readTurns: (threadId: string) => Promise<CodexSubagentTurn[]>,
): Promise<void> {
  const children = new Map<string, SessionLoadMessage[]>()
  for (const message of messages) {
    if (!message.isSubagent || message.subagentType !== 'codex' || !message.toolInput) continue
    try {
      const input = childInputSchema.safeParse(JSON.parse(message.toolInput))
      if (!input.success) continue
      const cards = children.get(input.data.agent_thread_id) ?? []
      cards.push(message)
      children.set(input.data.agent_thread_id, cards)
    } catch {
      // Older tool inputs need not contain structured child identity.
    }
  }

  const pending = [...children.entries()]
  // Bound provider traffic even when a session has a large agent history.
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      const [threadId, cards] = entry
      let turns: CodexSubagentTurn[]
      try {
        turns = await readTurns(threadId)
      } catch {
        // An unavailable child must not prevent opening the parent transcript.
        continue
      }
      const turn = turns.at(-1)
      if (!turn) continue
      const result = codexSubagentTurnResult(turn)
      if (!result && turn.status !== 'inProgress') continue
      for (const card of cards) {
        card.toolStatus = result?.status ?? 'running'
        if (result) card.content = result.text
      }
    }
  }))
}
