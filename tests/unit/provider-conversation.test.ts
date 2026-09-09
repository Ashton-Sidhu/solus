import { expect, test } from 'bun:test'
const { providerConversationFor } = await import('@solus/server/agents/run-input')

test('provider actions keep a fork source separate from a resumed thread', () => {
  expect(providerConversationFor({ agentSessionId: null, forked: false })).toEqual({ kind: 'start' })
  expect(providerConversationFor({ agentSessionId: 'source', forked: true, forkExcludeLatestTurn: true }))
    .toEqual({ kind: 'fork', sourceThreadId: 'source', excludeLatestTurn: true })
  expect(providerConversationFor({ agentSessionId: 'thread', forked: false })).toEqual({ kind: 'resume', threadId: 'thread' })
})
