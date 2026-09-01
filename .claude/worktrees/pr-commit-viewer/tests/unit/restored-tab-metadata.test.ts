import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '../../src/shared/types'
import { getAttentionState } from '../../src/renderer/lib/sessionUtils'
import { makeSession, makeTab } from '../../src/renderer/contexts/workspace/session.factories'
import { applyRestoredSessionMeta } from '../../src/renderer/contexts/workspace/session-bootstrap'
import { snapshotPersistedTabs } from '../../src/renderer/contexts/workspace/tab-snapshot'

function restoredSession() {
  return makeSession({ rateLimitBehavior: 'ask' } as never, {
    id: 'renderer-session',
    agentSessionId: 'provider-session',
    status: 'running',
    currentTurnStartedAt: 1_700_000_000_000,
    run: {
      provider: 'claude-code',
      workingDirectory: '/repo',
      modelConfig: {
        modelId: 'claude-sonnet-5',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        fastMode: false,
      },
    },
  })
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    provider: 'codex',
    sessionId: 'provider-session',
    slug: null,
    firstMessage: 'Fix reload',
    lastTimestamp: new Date().toISOString(),
    size: 1,
    cwd: '/repo',
    projectPath: '-repo',
    status: 'running',
    currentTurnStartedAt: 1_700_000_001_000,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    ...overrides,
  }
}

describe('restored tab metadata', () => {
  test('persists sidebar-visible status and timer with every open tab', () => {
    const session = restoredSession()
    const tab = makeTab(session.id, { id: 'tab-1' })
    const snapshot = snapshotPersistedTabs({
      tabOrder: [tab.id],
      tabs: { [tab.id]: tab },
      sessionFor: () => session,
      globalDefaults: {
        workingDirectory: '/repo',
        modelConfig: session.run.modelConfig,
        permissionMode: 'ask',
      },
    } as never)

    expect(snapshot[0]).toMatchObject({
      tabId: 'tab-1',
      sessionId: 'renderer-session',
      provider: 'claude-code',
      status: 'running',
      currentTurnStartedAt: 1_700_000_000_000,
    })
  })

  test('applies live status, timer, provider, and model without selecting the tab', () => {
    const session = restoredSession()

    applyRestoredSessionMeta(session, meta())

    expect(session.status).toBe('running')
    expect(session.currentTurnStartedAt).toBe(1_700_000_001_000)
    expect(session.run.provider).toBe('codex')
    expect(session.run.modelConfig.modelId).toBe('gpt-5.6-sol')
    expect(session.run.modelConfig.reasoningEffort).toBe('xhigh')
    expect(getAttentionState(session, makeTab(session.id))).toBe('running')
  })

  test('restores terminal status icons and clears a stale running timer', () => {
    const session = restoredSession()

    applyRestoredSessionMeta(session, meta({ status: 'failed', currentTurnStartedAt: undefined }))

    expect(session.status).toBe('failed')
    expect(session.currentTurnStartedAt).toBeNull()
    expect(getAttentionState(session, makeTab(session.id))).toBe('error')
  })
})
