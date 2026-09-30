import { afterEach, describe, expect, test } from 'bun:test'
import type { AcceptPlanRequest, AcceptPlanResult, PermissionMode, Plan, RunConfig, Session, Tab } from '@solus/contracts/types'
import { approvePlanWithModel, rejectPlan } from '@solus/workspace-ui/contexts/workspace/session-plan-operations'

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
      permissionMode: 'supervised',
    } as Session['run'],
    messages: [],
  } as unknown as Session
  const tab = {
    sessionId: 'renderer-session-1',
    input: { planRefs: [], workRefs: [] },
  } as unknown as Tab
  const accepts: AcceptPlanRequest[] = []
  const handoffs: Array<{ provider: string; tabId: string }> = []
  const notices: Array<boolean | undefined> = []

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  })

  const ctx = {
    activeTabId: 'tab-1',
    tabs: { 'tab-1': tab },
    sessions: { byId: { 'renderer-session-1': session } },
    tabOrder: ['tab-1'],
    planStore: {
      previewDescriptor: null,
      plans: { 'plan-1': plan },
      setStatus: (_planId: string, status: Plan['status']) => { plan.status = status },
    },
    router: { params: () => null, close: () => {} },
    sessionFor: () => session,
    apiFor: () => ({
      // The host stops, hands over or resets, and records the decision in one call.
      acceptPlan: async (_ipc: unknown, request: AcceptPlanRequest): Promise<AcceptPlanResult> => {
        accepts.push(request)
        if (!request.provider) return {}
        return { handoff: { fromProvider: session.run.provider!, fromSessionId: session.agentSessionId!, handoffId: 'handoff-1', taskSessionMove: { sourceSessionId: 'a', targetSessionId: 'b' } } }
      },
    }),
    ctxFor: () => ({ session: { sessionId: session.id } }),
    controls: { interruptTabSession: (_tabId: string, opts: { notice?: boolean } = {}) => { notices.push(opts.notice) } },
    settings: { update: () => {}, defaultPermissionMode: 'accept-edits' as PermissionMode },
    config: {
      switchActiveAgent: async () => { throw new Error('a session with a provider thread is handed over by the host') },
      adoptHandoff: (target: Session, provider: string, _result: AcceptPlanResult['handoff'], tabId: string) => {
        handoffs.push({ provider, tabId })
        target.run.provider = provider as RunConfig['provider']
        target.agentSessionId = null
      },
      followActiveSessionAgent: () => {},
      handoffFailed: () => {},
    },
    notifySessionUnavailable: () => {},
    dispatch: { sendMessage: () => {} },
  }

  return { ctx, session, handoffs, notices, accepts }
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
    answeredFor: [] as string[],
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  })

  const ctx = {
    activeTabId: 'tab-1',
    tabs: { 'tab-1': tab },
    sessions: { byId: { 'renderer-session-1': session } },
    tabOrder: ['tab-1'],
    planStore: {
      previewDescriptor: null,
      plans: { 'plan-1': plan },
      setStatus: (_planId: string, next: Plan['status']) => { plan.status = next },
    },
    router: { params: () => null, close: () => {} },
    sessionFor: () => session,
    apiFor: () => ({
      respondPermission: async (_c: unknown, askingSessionId: string, _q: string, optionId: string) => {
        calls.denied.push(optionId)
        calls.answeredFor.push(askingSessionId)
      },
      stopSession: async () => { calls.stops++ },
    }),
    ctxFor: () => ({ session: { sessionId: 'renderer-session-1' } }),
    controls: { interruptTabSession: () => { calls.interrupts++ } },
    setPermissionMode: (_mode: string, tabId?: string) => { calls.permissionModeTabIds.push(tabId) },
    dispatch: { sendMessage: (text: string, _projectPath?: string, tabId?: string) => {
      calls.prompts.push(text)
      calls.promptTabIds.push(tabId)
    } },
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
    // The tab answers its own session's plan, never another session's.
    expect(calls.answeredFor).toEqual(['renderer-session-1'])
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
  test('does not approve into another tab when the saved plan session is gone', async () => {
    const { ctx, session, accepts } = approvalContext()
    Object.assign(ctx.planStore, { previewDescriptor: {
      provider: 'claude-code',
      sessionId: 'agent-session-1',
      sessionAvailable: false,
    } })

    await approvePlanWithModel(ctx as any, 'plan-1', 'default')

    // WHY: a missing source session used to leave resume on the current tab;
    // approval then submitted the saved plan into that unrelated conversation.
    expect(accepts).toEqual([])
    expect(session.agentSessionId).toBe('agent-session-1')
    expect(ctx.planStore.plans['plan-1'].status).toBe('pending')
  })

  test('asks the host for a new agent session by default, in one call', async () => {
    const { ctx, session, accepts } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'default')

    // WHY: the host stops, resets and records the decision (plans/012 §5); the
    // divider is its `plan_decided` activity, so the client writes none.
    expect(accepts).toEqual([{ planId: 'plan-1', provider: undefined, startNewSession: true }])
    expect(session.agentSessionId).toBeNull()
    expect(session.messages).toEqual([])
  })

  test('keeps the plan session when starting a new session is disabled', async () => {
    const { ctx, session, accepts } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'default', { startNewSession: false })

    expect(accepts).toEqual([{ planId: 'plan-1', provider: undefined, startNewSession: false }])
    expect(session.agentSessionId).toBe('agent-session-1')
  })

  test('never reports the accepted plan run as stopped by the reader', async () => {
    const { ctx, session, notices } = approvalContext()
    session.status = 'awaiting_plan'

    await approvePlanWithModel(ctx as any, 'plan-1', 'default', {
      provider: 'codex',
      modelId: 'gpt-5.5',
    })

    // WHY: accepting ends the planning run so the implementation can start on a
    // fresh session — a consequence of the approval, not a stop. Announcing it as
    // one printed "Stopped by you" across every accepted plan, which reads as the
    // thread having been cut short rather than handed on.
    expect(notices).toEqual([false])
  })

  test('hands the session over through the host when the implementation provider changes', async () => {
    const { ctx, session, handoffs, accepts } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'default', {
      provider: 'codex',
      modelId: 'gpt-5.5',
    })

    // WHY: a provider change at plan approval is still a continuation of this
    // conversation, so it keeps handoff lineage (no reset) and takes on the
    // switch the host made, like a switch from the agent picker.
    expect(accepts).toEqual([{ planId: 'plan-1', provider: 'codex', startNewSession: false }])
    expect(handoffs).toEqual([{ provider: 'codex', tabId: 'tab-1' }])
    expect(session.run.modelConfig.modelId).toBe('gpt-5.5')
  })

  test('hands a Codex-authored plan to Claude through the same path', async () => {
    const { ctx, session, handoffs, accepts } = approvalContext()
    session.run.provider = 'codex'
    session.run.modelConfig.modelId = 'gpt-5.5'

    await approvePlanWithModel(ctx as any, 'plan-1', 'default', {
      provider: 'claude-code',
      modelId: 'claude-opus-4-6',
    })

    expect(accepts).toEqual([{ planId: 'plan-1', provider: 'claude-code', startNewSession: false }])
    expect(handoffs).toEqual([{ provider: 'claude-code', tabId: 'tab-1' }])
    expect(session.run.modelConfig.modelId).toBe('claude-opus-4-6')
  })

  test('a failed handoff leaves the plan pending and sends nothing', async () => {
    const { ctx } = approvalContext()
    const sent: string[] = []
    ctx.dispatch.sendMessage = ((text: string) => { sent.push(text) }) as typeof ctx.dispatch.sendMessage
    ctx.apiFor = () => ({ acceptPlan: async () => { throw new Error('queued prompts') } }) as unknown as ReturnType<typeof ctx.apiFor>

    await approvePlanWithModel(ctx as any, 'plan-1', 'default', { provider: 'codex', modelId: 'gpt-5.5' })

    // WHY: the original provider is still in place; the approved work must not go to it.
    expect(ctx.planStore.plans['plan-1'].status).toBe('pending')
    expect(sent).toEqual([])
  })
})

describe('plan approval permission mode', () => {
  test('approve runs the plan in the default mode from Settings', async () => {
    const { ctx, session } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'default')

    // WHY: the plan is only the planning step; the work runs with the
    // permissions the user chose for new sessions, not with one Solus picks.
    expect(session.run.permissionMode).toBe('accept-edits')
  })

  test('a default of plan implements in full access, never in plan again', async () => {
    const { ctx, session } = approvalContext()
    ctx.settings.defaultPermissionMode = 'plan'

    await approvePlanWithModel(ctx as any, 'plan-1', 'default')

    // WHY: implementing in plan mode would only produce another plan.
    expect(session.run.permissionMode).toBe('full-access')
  })

  test('approve with ask-each-step runs supervised', async () => {
    const { ctx, session } = approvalContext()

    await approvePlanWithModel(ctx as any, 'plan-1', 'supervised')

    expect(session.run.permissionMode).toBe('supervised')
  })
})
