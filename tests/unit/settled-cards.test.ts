import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Session, StatusCardState } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

/**
 * The cards at the tail of a transcript answer the send before this one. A
 * follow-up prompt replaces them; only work still in progress stays.
 */

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: singleHostServerConnections(),
}))

type TestGlobal = typeof globalThis & { $state?: unknown }
// SAFETY: This test installs the Svelte rune shim on the test process global and restores it after all cases.
const testGlobal = globalThis as TestGlobal
const previousState = testGlobal.$state

let clearSettledCards: typeof import('@solus/workspace-ui/contexts/workspace/settled-cards')['clearSettledCards']
let connectRequestStore: typeof import('@solus/workspace-ui/contexts/connections/connect-request.store.svelte')['connectRequestStore']
let turnRefusalStore: typeof import('@solus/workspace-ui/contexts/connections/turn-refusal.store.svelte')['turnRefusalStore']
let seatsStore: typeof import('@solus/workspace-ui/contexts/seats/seats.store.svelte')['seatsStore']
let agentAuthStore: typeof import('@solus/workspace-ui/contexts/seats/agent-auth.store.svelte')['agentAuthStore']

beforeAll(async () => {
  testGlobal.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
  ;({ clearSettledCards } = await import('@solus/workspace-ui/contexts/workspace/settled-cards'))
  ;({ connectRequestStore } = await import('@solus/workspace-ui/contexts/connections/connect-request.store.svelte'))
  ;({ turnRefusalStore } = await import('@solus/workspace-ui/contexts/connections/turn-refusal.store.svelte'))
  ;({ seatsStore } = await import('@solus/workspace-ui/contexts/seats/seats.store.svelte'))
  ;({ agentAuthStore } = await import('@solus/workspace-ui/contexts/seats/agent-auth.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
})

beforeEach(() => {
  connectRequestStore.dismiss()
  turnRefusalStore.dismiss()
  seatsStore.dismiss()
  agentAuthStore.dismiss()
})

function card(status: StatusCardState['status']): StatusCardState {
  return { id: 'worktree-1', title: 'Setting up worktree', status, steps: [] }
}

function sessionWith(statusCard: StatusCardState | null, id = 'session-1'): Session {
  return { id, statusCard, run: { serverId: 'studio' } } as Session
}

describe('a follow-up send clears the cards that answered the last one', () => {
  test('a finished or failed setup card leaves; a running one stays', () => {
    // WHY: a done or failed setup card under a new turn reports a setup that is
    // over. An active one is the setup this send waits on.
    for (const status of ['done', 'error'] as const) {
      const session = sessionWith(card(status))
      clearSettledCards(session)
      expect(session.statusCard).toBeNull()
    }
    const running = sessionWith(card('active'))
    clearSettledCards(running)
    expect(running.statusCard?.status).toBe('active')
  })

  test('the connect, refusal, seat, and finished sign-in cards of this conversation leave', () => {
    const session = sessionWith(null)
    connectRequestStore.request = { serverId: 'studio', sessionId: 'session-1', provider: 'atlassian', reason: 'jira' }
    turnRefusalStore.note({ serverId: 'studio', sessionId: 'session-1', code: 'ORGANIZATION_REQUIRED', message: 'no' })
    seatsStore.required = { serverId: 'studio', sessionId: 'session-1', provider: 'codex' }
    agentAuthStore.flow = { serverId: 'studio', sessionId: 'session-1', title: 'Claude Design', phase: 'done' }

    clearSettledCards(session)

    expect(connectRequestStore.request).toBeNull()
    expect(turnRefusalStore.refused).toBeNull()
    expect(seatsStore.required).toBeNull()
    expect(agentAuthStore.flow).toBeNull()
  })

  test('a sign-in that still waits on the browser stays', () => {
    // WHY: closing it would end a sign-in the person is in the middle of.
    agentAuthStore.flow = { serverId: 'studio', sessionId: 'session-1', title: 'sentry', phase: 'waiting', flowId: 'flow-1' }
    clearSettledCards(sessionWith(null))
    expect(agentAuthStore.flow?.phase).toBe('waiting')
  })

  test('a card of another conversation stays', () => {
    // WHY: a send in one tab must not dismiss what a different session asks for.
    connectRequestStore.request = { serverId: 'studio', sessionId: 'session-2', provider: 'atlassian', reason: 'jira' }
    seatsStore.required = { serverId: 'studio', sessionId: 'session-2', provider: 'codex' }
    clearSettledCards(sessionWith(null))
    expect(connectRequestStore.request?.sessionId).toBe('session-2')
    expect(seatsStore.required?.sessionId).toBe('session-2')
  })
})
