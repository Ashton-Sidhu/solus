import { afterAll, describe, expect, test } from 'bun:test'
import type { AgentConversationUpdate } from '@solus/contracts/types'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: a card on screen must say how its exchange ended. A live transcript is
// `$state`, and the screen reads each card through that proxy. An update that
// changes the plain object behind it never reaches the screen: a child that
// failed or finished stayed "Queued", and a started session stayed "Starting".
// These run on Svelte's real proxies, which plain arrays cannot reproduce.

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const { cardsSeen } = await import(runes.module('agent-conversation-live-state', `
  import { AgentConversationCards } from 'cards'
  import { agentConversationCardState, isPendingAgent } from 'card-lib'

  /** Applies each update to a $state transcript and reads the card the way
   *  the screen does, after every update. */
  export function cardsSeen(updates) {
    const session = $state({ messages: [] })
    const cards = new AgentConversationCards()
    return updates.map((update) => {
      cards.apply(session, update)
      const ref = session.messages.find((message) => message.agentConversationRef)?.agentConversationRef
      return { state: agentConversationCardState(ref), pending: isPendingAgent(ref) }
    })
  }
`, {
  cards: SvelteRunes.file('packages/workspace-ui/src/contexts/workspace/agent-conversation-cards.ts'),
  'card-lib': SvelteRunes.file('packages/workspace-ui/src/components/conversation/agent-conversation/lib/agent-conversation.ts'),
}))

const child = '11111111-1111-4111-8111-111111111111'
const exchangeId = 'exchange-1'

describe('a card on screen follows its exchange', () => {
  test('a message whose run fails reads failed, not queued', () => {
    const updates: AgentConversationUpdate[] = [
      { phase: 'dispatched', agentSessionId: child, messageId: exchangeId, origin: 'prompted', prompt: 'fix it', provider: 'claude-code', title: 'Fix', cwd: '/repo', dispatchedAt: 1 },
      { phase: 'accepted', agentSessionId: child, messageId: exchangeId, state: 'running' },
      { phase: 'settled', agentSessionId: child, messageId: exchangeId, status: 'failed', replyText: 'The worktree was removed.', settledAt: 2 },
    ]
    expect(cardsSeen(updates).map((seen: { state: string }) => seen.state)).toEqual(['dispatching', 'replying', 'failed'])
  })

  test('a created session that starts and finishes reads started and completed', () => {
    const pendingId = `pending:${exchangeId}`
    const updates: AgentConversationUpdate[] = [
      { phase: 'dispatched', agentSessionId: pendingId, messageId: exchangeId, origin: 'created', prompt: 'fix it', provider: 'claude-code', title: 'Fix', cwd: '/repo', dispatchedAt: 1 },
      { phase: 'accepted', agentSessionId: pendingId, messageId: exchangeId, state: 'running' },
      { phase: 'attached', agentSessionId: child, messageId: exchangeId },
      { phase: 'settled', agentSessionId: child, messageId: exchangeId, status: 'completed', replyText: 'done', settledAt: 2 },
    ]
    expect(cardsSeen(updates)).toEqual([
      { state: 'dispatching', pending: true },
      { state: 'replying', pending: true },
      { state: 'replying', pending: false },
      { state: 'replied', pending: false },
    ])
  })
})
