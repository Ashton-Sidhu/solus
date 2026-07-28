import { afterEach, describe, expect, test } from 'bun:test'
import type { Plan, Session, Tab } from '../../src/shared/types'
import { approvePlanWithModel } from '../../src/renderer/contexts/workspace/session-plan-operations'

const previousWindow = globalThis.window

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
})

function approvalContext() {
  const plan = {
    id: 'plan-1',
    sessionId: 'agent-session-1',
    planToolUseId: 'plan-tool-1',
    title: 'Keep context',
    status: 'pending',
    comments: [],
    cwd: '/repo',
  } as unknown as Plan
  const session = {
    agentSessionId: 'agent-session-1',
    status: 'completed',
    provider: 'codex',
    modelConfig: { modelId: 'gpt-5', reasoningEffort: 'high' },
    permissionMode: 'ask',
  } as unknown as Session
  const tab = {
    sessionId: 'renderer-session-1',
    input: { planRefs: [], workRefs: [] },
  } as unknown as Tab
  let resetCount = 0

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  })

  const ctx = {
    activeTabId: 'tab-1',
    tabs: { 'tab-1': tab },
    sessions: { 'renderer-session-1': session },
    tabOrder: ['tab-1'],
    planStore: {
      previewDescriptor: null,
      plans: { 'plan-1': plan },
      setStatus: (_planId: string, status: Plan['status']) => { plan.status = status },
    },
    panes: { activePlanId: null, close: () => {} },
    sessionFor: () => session,
    apiFor: () => ({
      resetTabSession: () => { resetCount++ },
    }),
    ctxFor: () => ({}),
    settings: { update: () => {} },
    sendMessage: () => {},
  }

  return { ctx, session, resetCount: () => resetCount }
}

describe('plan approval session choice', () => {
  test('starts a new agent session by default', async () => {
    const { ctx, session, resetCount } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto')

    expect(resetCount()).toBe(1)
    expect(session.agentSessionId).toBeNull()
  })

  test('retains the plan session when starting a new session is disabled', async () => {
    const { ctx, session, resetCount } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', { startNewSession: false })

    expect(resetCount()).toBe(0)
    expect(session.agentSessionId).toBe('agent-session-1')
  })
})
