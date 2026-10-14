import { describe, expect, test } from 'bun:test'
import type { Activity, ActivityKind } from '@solus/contracts/activity'
import type { Session, SessionMeta } from '@solus/contracts/types'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { makeSession } from '@solus/workspace-ui/contexts/workspace/session.factories'
import { applyRestoredSessionMeta } from '@solus/workspace-ui/contexts/workspace/session-bootstrap'
import { applyRuntimeConfig } from '@solus/workspace-ui/contexts/workspace/session.utils'
import { pendingHandoffProvider } from '@solus/workspace-ui/components/conversation/lib/pending-handoff'
import { parseUserKey } from '@solus/contracts/user'

// plans/021: a provider pick is composer state. The host hands the thread over
// only when a prompt carries the picked provider, and reports it with one
// `agent_switched` activity. Until then the transcript shows a pending handoff.

function threadSession(): Session {
  const session = makeSession({ rateLimitBehavior: 'ask' } as never, {
    id: 'session',
    agentSessionId: 'claude-thread',
    status: 'idle',
    run: {
      provider: 'claude-code',
      serverId: 'host-1',
      workingDirectory: '/repo',
      modelConfig: { modelId: 'claude-opus-5', reasoningEffort: 'high', contextWindow: 200_000, fastMode: false },
    },
  })
  session.threadProvider = 'claude-code'
  return session
}

let nextId = 0
function switched(kind: Extract<ActivityKind, { kind: 'agent_switched' }>): Activity {
  return { ...kind, id: `a${++nextId}`, subject: { kind: 'session', id: 'session' }, at: 5, by: { kind: 'system' } }
}

function reducerFor(session: Session) {
  return new SessionEventReducer({
    registry: {},
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask', modelOptionsByProvider: {} },
    planStore: { plans: {}, setStatus: () => {} },
    currentUserId: () => parseUserKey('alice'),
    playNotificationIfHidden: () => {},
    closePlanModal: () => {},
    log: () => {},
  } as unknown as SessionEventReducerDeps)
}

describe('pending handoff row', () => {
  test('shows while the picked provider differs from the thread provider, and goes on a pick back', () => {
    const session = threadSession()
    expect(pendingHandoffProvider(session)).toBeNull()

    session.run.provider = 'codex'
    expect(pendingHandoffProvider(session)).toBe('codex')

    session.run.provider = 'claude-code'
    expect(pendingHandoffProvider(session)).toBeNull()
  })

  test('a session with no thread has nothing to hand over', () => {
    const session = threadSession()
    session.threadProvider = null
    session.run.provider = 'codex'
    expect(pendingHandoffProvider(session)).toBeNull()
  })
})

describe('thread provider after a send', () => {
  test('the host’s handoff replaces the pending row with its divider and keeps the pick', () => {
    const session = threadSession()
    session.run.provider = 'codex'
    session.run.modelConfig = { modelId: 'gpt-5.4', reasoningEffort: 'max', contextWindow: null, fastMode: false }

    reducerFor(session).apply('session', { type: 'activity', activity: switched({ kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code', model: 'gpt-5.4' }) })

    expect(session.threadProvider).toBe('codex')
    expect(pendingHandoffProvider(session)).toBeNull()
    expect(session.run.modelConfig.reasoningEffort).toBe('max')
    expect(session.messages.at(-1)?.activity?.kind).toBe('agent_switched')
  })

  test('a composer with no open pick follows another client’s handoff to its model', () => {
    // WHY: the host takes the provider each prompt carries. A composer left on
    // the old provider would hand the thread back on its next send.
    const session = threadSession()

    reducerFor(session).apply('session', { type: 'activity', activity: switched({ kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code', model: 'gpt-5.4' }) })

    expect(session.threadProvider).toBe('codex')
    expect(session.run.provider).toBe('codex')
    expect(session.run.modelConfig.modelId).toBe('gpt-5.4')
  })

  test('an open pick to a third provider stays when another client hands off', () => {
    const session = threadSession()
    session.run.provider = 'opencode'

    reducerFor(session).apply('session', { type: 'activity', activity: switched({ kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code' }) })

    expect(session.threadProvider).toBe('codex')
    expect(session.run.provider).toBe('opencode')
  })

  test('a replayed handoff the transcript already holds does not move the thread back', () => {
    const session = threadSession()
    const reducer = reducerFor(session)
    const toCodex = switched({ kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code' })
    reducer.apply('session', { type: 'activity', activity: toCodex })
    reducer.apply('session', { type: 'activity', activity: switched({ kind: 'agent_switched', provider: 'claude-code', fromProvider: 'codex' }) })

    reducer.apply('session', { type: 'activity', activity: toCodex })

    expect(session.threadProvider).toBe('claude-code')
  })
})

describe('host state that arrives with an open pick', () => {
  test('a restored record names the thread provider but leaves the picked provider and model', () => {
    const session = threadSession()
    session.run.provider = 'codex'
    session.run.modelConfig.modelId = 'gpt-5.4'

    applyRestoredSessionMeta(session, { provider: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'low' } as SessionMeta)

    expect(session.threadProvider).toBe('claude-code')
    expect(session.run.provider).toBe('codex')
    expect(session.run.modelConfig.modelId).toBe('gpt-5.4')
  })

  test('a restored record with no pick follows the host', () => {
    const session = threadSession()
    session.threadProvider = undefined

    applyRestoredSessionMeta(session, { provider: 'codex', model: 'gpt-5.4' } as SessionMeta)

    expect(session.threadProvider).toBe('codex')
    expect(session.run.provider).toBe('codex')
    expect(session.run.modelConfig.modelId).toBe('gpt-5.4')
  })

  test('the live runtime’s model does not replace the picked model', () => {
    const session = threadSession()
    session.run.provider = 'codex'
    session.run.modelConfig.modelId = 'gpt-5.4'

    applyRuntimeConfig(session, { modelConfig: { modelId: 'claude-opus-5', reasoningEffort: 'high', contextWindow: 200_000, fastMode: false } } as Parameters<typeof applyRuntimeConfig>[1])

    expect(session.run.modelConfig.modelId).toBe('gpt-5.4')
  })
})
