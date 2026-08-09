import { afterEach, describe, expect, test } from 'bun:test'
import type { Plan, RunConfig, Session, Tab } from '../../src/shared/types'
import { approvePlanWithModel, rejectPlan } from '../../src/renderer/contexts/workspace/session-plan-operations'

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
    run: {
      provider: 'claude-code',
      modelConfig: { modelId: 'claude-opus-4-6', reasoningEffort: 'high' },
      permissionMode: 'ask',
    } as Session['run'],
    messages: [],
  } as unknown as Session
  const tab = {
    sessionId: 'renderer-session-1',
    input: { planRefs: [], workRefs: [] },
  } as unknown as Tab
  let resetCount = 0
  const handoffs: Array<{ provider: string; tabId: string }> = []
  const notices: Array<boolean | undefined> = []

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
    router: { params: () => null, close: () => {} },
    sessionFor: () => session,
    apiFor: () => ({
      resetSession: () => { resetCount++ },
      stopSession: async () => true,
    }),
    ctxFor: () => ({ session: { sessionId: session.id } }),
    interruptTabSession: (_tabId: string, opts: { notice?: boolean } = {}) => { notices.push(opts.notice) },
    settings: { update: () => {} },
    switchActiveAgent: async (provider: string, tabId: string) => {
      handoffs.push({ provider, tabId })
      const fromProvider = session.run.provider!
      const fromSessionId = session.agentSessionId!
      const agentChangedTo = provider === 'claude-code' ? 'Claude Code' : 'Codex'
      session.run.provider = provider as RunConfig['provider']
      session.agentSessionId = null
      session.handoffFrom = { provider: fromProvider, sessionId: fromSessionId }
      session.messages.push({
        id: 'agent-change-1',
        role: 'system',
        content: `Switched to ${agentChangedTo}`,
        timestamp: Date.now(),
        agentChangedTo,
      })
    },
    sendMessage: () => {},
  }

  return { ctx, session, handoffs, notices, resetCount: () => resetCount }
}

function revisionContext(status: Session['status']) {
  const plan = {
    id: 'plan-1',
    sessionId: 'agent-session-1',
    planToolUseId: 'plan-tool-1',
    title: 'Keep context',
    status: 'pending',
    comments: [],
    cwd: '/repo',
    questionId: 'question-1',
    options: [
      { id: 'opt-allow', label: 'Yes', kind: 'allow' },
      { id: 'opt-deny', label: 'No, keep planning', kind: 'deny' },
    ],
  } as unknown as Plan
  const session = { status, run: { provider: 'claude-code' }, messages: [] } as unknown as Session
  const tab = { sessionId: 'renderer-session-1', input: { planRefs: [], workRefs: [] } } as unknown as Tab

  const calls = {
    denied: [] as string[],
    stops: 0,
    interrupts: 0,
    prompts: [] as string[],
    permissionModeTabIds: [] as Array<string | undefined>,
    promptTabIds: [] as Array<string | undefined>,
  }

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
      setStatus: (_planId: string, next: Plan['status']) => { plan.status = next },
    },
    router: { params: () => null, close: () => {} },
    sessionFor: () => session,
    apiFor: () => ({
      respondPermission: async (_c: unknown, _q: string, optionId: string) => { calls.denied.push(optionId) },
      stopSession: async () => { calls.stops++ },
    }),
    ctxFor: () => ({ session: { sessionId: session.id } }),
    interruptTabSession: () => { calls.interrupts++ },
    setPermissionMode: (_mode: string, tabId?: string) => { calls.permissionModeTabIds.push(tabId) },
    sendMessage: (text: string, _projectPath?: string, tabId?: string) => {
      calls.prompts.push(text)
      calls.promptTabIds.push(tabId)
    },
  }

  return { ctx, plan, calls }
}

describe('plan revision', () => {
  test('answers the plan permission instead of killing the run', async () => {
    const { ctx, plan, calls } = revisionContext('awaiting_plan')

    await rejectPlan(ctx as any, 'plan-1', 'drop the session report idea')

    // WHY: a run holding a plan up for review reports `awaiting_plan`, never
    // 'running'. Treating that as a dead session aborted the turn, which stamped
    // "Stopped by you" across the transcript and folded the planning work away —
    // the revise note then read as a thread that had forgotten everything.
    expect(calls.denied).toEqual(['opt-deny'])
    expect(calls.stops).toBe(0)
    expect(calls.interrupts).toBe(0)
    expect(plan.status).toBe('rejected')
    expect(calls.prompts).toHaveLength(1)
    expect(calls.permissionModeTabIds).toEqual(['tab-1'])
    expect(calls.promptTabIds).toEqual(['tab-1'])
  })

  test('stops the run when there is no pending permission left to answer', async () => {
    const { ctx, calls } = revisionContext('completed')

    await rejectPlan(ctx as any, 'plan-1', 'drop the session report idea')

    // WHY: revising a plan whose run has already exited has nothing to answer,
    // so the stop is the only way to clear whatever the tab is still holding.
    expect(calls.denied).toEqual([])
    expect(calls.stops).toBe(1)
    expect(calls.interrupts).toBe(1)
  })
})

describe('plan approval session choice', () => {
  test('starts a new agent session by default', async () => {
    const { ctx, session, resetCount } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto')

    expect(resetCount()).toBe(1)
    expect(session.agentSessionId).toBeNull()
    // WHY: the implementation run carries the plan and nothing else. Without a
    // divider saying so, a deliberate restart is indistinguishable from the
    // conversation silently losing its context.
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      newSessionForPlanId: 'plan-1',
    })
  })

  test('adds no session boundary when the plan session is kept', async () => {
    const { ctx, session } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', { startNewSession: false })

    expect(session.messages.some((m) => m.newSessionForPlanId)).toBe(false)
  })

  test('never reports the accepted plan run as stopped by the reader', async () => {
    const { ctx, session, notices } = approvalContext()
    session.status = 'awaiting_plan'

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', {
      provider: 'codex',
      modelId: 'gpt-5.5',
    })

    // WHY: accepting ends the planning run so the implementation can start on a
    // fresh session — a consequence of the approval, not a stop. Announcing it as
    // one printed "Stopped by you" across every accepted plan, which reads as the
    // thread having been cut short rather than handed on.
    expect(notices).toEqual([false])
  })

  test('retains the plan session when starting a new session is disabled', async () => {
    const { ctx, session, resetCount } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', { startNewSession: false })

    expect(resetCount()).toBe(0)
    expect(session.agentSessionId).toBe('agent-session-1')
  })

  test('uses the normal handoff path when the implementation provider changes', async () => {
    const { ctx, session, handoffs, resetCount } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', {
      provider: 'codex',
      modelId: 'gpt-5.5',
    })

    // WHY: a provider change at plan approval is still a continuation of this
    // conversation, so it must retain handoff lineage and the same UI boundary
    // as a provider change made from the session picker.
    expect(handoffs).toEqual([{ provider: 'codex', tabId: 'tab-1' }])
    expect(resetCount()).toBe(0)
    expect(session.handoffFrom).toEqual({
      provider: 'claude-code',
      sessionId: 'agent-session-1',
    })
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      agentChangedTo: 'Codex',
    })
    expect(session.run.modelConfig.modelId).toBe('gpt-5.5')
  })

  test('hands a Codex-authored plan to Claude through the same path', async () => {
    const { ctx, session, handoffs, resetCount } = approvalContext()
    session.run.provider = 'codex'
    session.run.modelConfig.modelId = 'gpt-5.5'

    await approvePlanWithModel(ctx as any, 'plan-1', 'auto', {
      provider: 'claude-code',
      modelId: 'claude-opus-4-6',
    })

    expect(handoffs).toEqual([{ provider: 'claude-code', tabId: 'tab-1' }])
    expect(resetCount()).toBe(0)
    expect(session.handoffFrom).toEqual({
      provider: 'codex',
      sessionId: 'agent-session-1',
    })
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      agentChangedTo: 'Claude Code',
    })
    expect(session.run.modelConfig.modelId).toBe('claude-opus-4-6')
  })
})
