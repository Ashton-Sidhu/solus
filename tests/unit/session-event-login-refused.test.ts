import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'

// A turn the provider failed because it refused the login is fixed by signing
// in again, not by retrying. The reducer keeps the failure in the transcript
// and asks for the sign-in card in that conversation; the card's panel chooses
// Solus Cloud's connections or the host's CLI login by the host it names.

function fixture(provider: string) {
  const refused: string[] = []
  const session = {
    status: 'running', run: { serverId: 'host-1', provider }, messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }],
    outboundPrompts: [], currentTurnStartedAt: 1, permissionQueue: [], questionQueue: [], rateLimitInfo: null,
  } as unknown as Session
  const reducer = new SessionEventReducer({
    registry: { tabIdsBySession: new Map() },
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    workStreamTracker: { sweep: () => {} },
    isSessionVisible: () => true,
    publishSessionViewed: () => {},
    playNotificationIfHidden: () => {},
    onLoginRefused: (sessionId: string) => { refused.push(sessionId) },
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  return { session, reducer, refused }
}

describe('a refused provider login', () => {
  test('asks for the sign-in card in that conversation and keeps the failure in the transcript', () => {
    const { session, reducer, refused } = fixture('codex')
    reducer.apply('session', { type: 'error', message: 'unexpected status 401 Unauthorized', isError: true, kind: 'auth' })

    expect(refused).toEqual(['session'])
    expect(session.messages.at(-1)).toMatchObject({ role: 'system', content: 'Error: unexpected status 401 Unauthorized' })
  })

  test('an ordinary failure shows no card', () => {
    const { reducer, refused } = fixture('claude-code')
    reducer.apply('session', { type: 'error', message: 'API Error: 500', isError: true })
    expect(refused).toEqual([])
  })
})
