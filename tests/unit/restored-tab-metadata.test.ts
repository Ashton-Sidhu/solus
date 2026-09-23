import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { getAttentionState } from '@solus/workspace-ui/lib/sessionUtils'
import { makeSession, makeTab } from '@solus/workspace-ui/contexts/workspace/session.factories'
import { applyRestoredSessionMeta } from '@solus/workspace-ui/contexts/workspace/session-bootstrap'
import { snapshotPersistedTabs } from '@solus/workspace-ui/contexts/workspace/tab-snapshot'

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
    // SAFETY: This fixture supplies every WorkspaceContext member read by snapshotPersistedTabs.
    const snapshot = snapshotPersistedTabs({
      tabOrder: [tab.id],
      tabs: { [tab.id]: tab },
      sessionFor: () => session,
    } as never)

    expect(snapshot[0]).toMatchObject({
      tabId: 'tab-1',
      sessionId: 'renderer-session',
      provider: 'claude-code',
      status: 'running',
      currentTurnStartedAt: 1_700_000_000_000,
    })
  })

  test('does not persist rate-limited status beyond the server lifetime', () => {
    const session = restoredSession()
    session.status = 'rate_limited'
    session.rateLimitInfo = {
      status: 'limited',
      resetsAt: 1_800_000_000,
      rateLimitType: 'Claude',
      isUsingOverage: false,
    }
    const tab = makeTab(session.id, { id: 'tab-1' })
    // SAFETY: This fixture supplies every WorkspaceContext member read by snapshotPersistedTabs.
    const snapshot = snapshotPersistedTabs({
      tabOrder: [tab.id],
      tabs: { [tab.id]: tab },
      sessionFor: () => session,
    } as never)

    expect(snapshot[0]?.status).toBe('idle')
    expect(snapshot[0]).not.toHaveProperty('rateLimitInfo')
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

  test('does not replace a persisted Auto preference with the resolved model', () => {
    const session = restoredSession()
    session.run.modelConfig.modelId = AUTO_MODEL_ID

    applyRestoredSessionMeta(session, meta({ model: 'gpt-5.6-sol' }))

    expect(session.run.modelConfig.modelId).toBe(AUTO_MODEL_ID)
  })

  test('restores terminal status icons and clears a stale running timer', () => {
    const session = restoredSession()

    applyRestoredSessionMeta(session, meta({ status: 'failed', currentTurnStartedAt: undefined }))

    expect(session.status).toBe('failed')
    expect(session.currentTurnStartedAt).toBeNull()
    // The failure is a notification, like the finished check: it marks the tab
    // unread, and a tab restored already-read has had its error read too.
    expect(getAttentionState(session, makeTab(session.id, { hasUnread: true }))).toBe('error')
    expect(getAttentionState(session, makeTab(session.id))).toBeNull()
  })

  test('a finished turn with a background task reads as finished first, then as background', () => {
    const session = restoredSession()

    applyRestoredSessionMeta(session, meta({ status: 'background', currentTurnStartedAt: 1_000 }))

    // The turn is over, so no turn clock runs while the task does.
    expect(session.currentTurnStartedAt).toBeNull()
    expect(getAttentionState(session, makeTab(session.id, { hasUnread: true }))).toBe('unread')
    // Once read, the tab still says that work goes on, instead of nothing.
    expect(getAttentionState(session, makeTab(session.id))).toBe('background')
  })
})
