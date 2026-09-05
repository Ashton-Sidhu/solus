import { afterEach, describe, expect, test } from 'bun:test'
import type { IpcContext, Session, SessionProviderSwitchResult } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function makeSettings(defaultModels: Record<string, string>, activeAgent = 'claude-code') {
  return {
    activeAgent,
    defaultModels,
    tabGroupMode: 'flat',
    update(patch: { activeAgent?: string; defaultModels?: Record<string, string> }) {
      if (patch.activeAgent) this.activeAgent = patch.activeAgent
      if (patch.defaultModels) this.defaultModels = patch.defaultModels
    },
  }
}

/** A prompt being written that has no session and no tab — the only composer a
 *  phone has before Send, and the one the mobile session sheet addresses. */
function makeDraft() {
  return {
    id: 'draft-1',
    run: {
      provider: 'claude-code',
      permissionMode: 'auto',
      workingDirectory: '/repo',
      modelConfig: {
        modelId: 'claude-opus-5',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        fastMode: false,
      },
    },
  }
}

async function makeController(
  settings: ReturnType<typeof makeSettings>,
  session: Session | null = null,
  switchResult?: SessionProviderSwitchResult,
  draft?: ReturnType<typeof makeDraft>,
  worktreeHarness?: {
    openSessionDraft?: (cwd?: string, freshTask?: boolean, gitContext?: unknown) => void
    apiForRun?: () => unknown
  },
) {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  const { SessionConfigController } = await import('@solus/workspace-ui/contexts/workspace/session-config.svelte')
  return new SessionConfigController({
    settings: settings as any,
    registry: { activeTabId: session ? 'tab-1' : null, activeSession: session, sessionFor: () => session } as any,
    statusBar: { ctx: { workingDirectory: '/repo' } } as any,
    setPluginCommands: () => {},
    openSessionDraft: worktreeHarness?.openSessionDraft ?? (() => {}),
    draftFor: (sourceId: string) => (draft && sourceId === draft.id ? draft : undefined),
    ctx: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
    ctxForDirectory: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
    apiFor: () => ({ switchSessionAgent: async () => switchResult }) as any,
    apiForRun: (worktreeHarness?.apiForRun ?? (() => ({}))) as any,
    refreshPluginCommands: () => {},
    rekeyTaskSessionBinding: () => {},
    refreshGitRefs: () => {},
    refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
  })
}

describe('worktree selection', () => {
  test('keeps the draft project at the repository root for an external worktree', async () => {
    const session = {
      id: 'stable-session',
      agentSessionId: 'provider-session',
      run: {
        workingDirectory: '/projects/solus',
        gitContext: {
          repoRoot: '/projects/solus',
          branch: 'main',
          targetBranch: 'main',
        },
      },
    } as Session
    let openedDraft: { cwd?: string; gitContext?: unknown } | null = null
    const checkout = {
      repoRoot: '/projects/solus',
      worktreePath: '/tmp/review-worktree',
      branch: 'review',
      targetBranch: 'review',
    }
    const controller = await makeController(makeSettings({}), session, undefined, undefined, {
      openSessionDraft: (cwd, _freshTask, gitContext) => { openedDraft = { cwd, gitContext } },
      apiForRun: () => ({ gitRefreshState: async () => checkout }),
    })

    await controller.switchToWorktree('/tmp/review-worktree')

    // WHY: selecting a worktree changes the Git destination, not the project
    // identity shown in the input bar or used by project-scoped features.
    expect(openedDraft).toEqual({ cwd: '/projects/solus', gitContext: checkout })
  })
})

describe('default model preference', () => {
  test('starts new sessions on the model chosen in settings', async () => {
    const controller = await makeController(makeSettings({ 'claude-code': 'claude-haiku-4-5-20251001' }))

    // WHY: the settings choice is the whole point — without it the agent's
    // built-in default (Opus 5) would silently win on every new session.
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-haiku-4-5-20251001')
    expect(controller.globalDefaults.modelConfig.reasoningEffort).toBe('medium')
    expect(controller.globalDefaults.modelConfig.contextWindow).toBe(200000)
  })

  test('falls back to the agent default when no model is chosen', async () => {
    const controller = await makeController(makeSettings({}))

    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('ignores a stored model that belongs to another agent', async () => {
    // WHY: a cross-provider id would otherwise be handed to the backend, which
    // has no such model and would fail or silently substitute its own.
    const controller = await makeController(makeSettings({ codex: 'claude-opus-5' }, 'codex'))

    expect(controller.globalDefaults.modelConfig.modelId).toBe('gpt-6-astra')
    expect(controller.globalDefaults.modelConfig.reasoningEffort).toBe('medium')
    expect(controller.globalDefaults.modelConfig.contextWindow).toBe(1050000)
  })

  test('keeps one choice per agent across a default agent switch', async () => {
    const settings = makeSettings({})
    const controller = await makeController(settings)

    controller.setDefaultModel('claude-code', 'claude-sonnet-5')
    controller.setDefaultModel('codex', 'gpt-5.4')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-sonnet-5')

    await controller.switchActiveAgent('codex')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('gpt-5.4')

    await controller.switchActiveAgent('claude-code')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-sonnet-5')
  })

  test('records the source and target models on a handoff divider', async () => {
    const settings = makeSettings({ codex: 'gpt-5.4' })
    const session = {
      id: 'stable-session',
      agentSessionId: 'claude-session',
      status: 'idle',
      sessionModel: 'claude-opus-5[1m]',
      messages: [],
      run: {
        provider: 'claude-code',
        modelConfig: {
          modelId: 'claude-opus-5',
          reasoningEffort: 'high',
          contextWindow: 200_000,
          fastMode: false,
        },
        workingDirectory: '/repo',
      },
    } as Session
    const controller = await makeController(settings, session, {
      fromProvider: 'claude-code',
      fromSessionId: 'claude-session',
      handoffId: 'stable-session',
      taskSessionMove: {
        sourceSessionId: 'claude-session',
        targetSessionId: 'stable-session',
      },
    })

    await controller.switchActiveAgent('codex')

    // WHY: a handoff boundary must name the model that ended and the model that
    // will continue, not only the destination provider.
    expect(session.messages.at(-1)).toMatchObject({
      agentChangedTo: 'Codex',
      agentChangedFromModel: 'Opus 5',
      agentChangedToModel: 'Gpt 5.4',
      agentChangedFromProvider: 'claude-code',
      agentChangedToProvider: 'codex',
    })

    session.agentSessionId = 'codex-session'
    controller.updateModelConfig({ modelId: 'gpt-5.5' })

    // WHY: a restored or already-bound target has a provider thread, but its
    // model picker still owns the active model. The divider must follow that
    // choice instead of freezing the handoff default.
    expect(session.messages.at(-1)?.agentChangedToModel).toBe('Gpt 5.5')
  })
})

describe('settings written against a draft composer', () => {
  test('change the draft, not the defaults every other composer reads', async () => {
    // WHY: a draft is the only composer a phone has before Send, so a write
    // that resolved sessions alone landed in the global defaults while the
    // sheet above it kept reading the draft — choosing a model did nothing.
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)

    controller.updateModelConfig({ modelId: 'claude-haiku-4-5-20251001' }, draft.id)

    expect(draft.run.modelConfig.modelId).toBe('claude-haiku-4-5-20251001')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('carry the model’s own effort and window across the change', async () => {
    // WHY: each model states its own limits; keeping the outgoing model's would
    // start the run against a window the new model never agreed to.
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)

    controller.updateModelConfig({ modelId: 'claude-haiku-4-5-20251001' }, draft.id)

    expect(draft.run.modelConfig.reasoningEffort).toBe('medium')
    expect(draft.run.modelConfig.contextWindow).toBe(200000)
  })

  test('step the effort of the draft on screen', async () => {
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)

    controller.updateModelConfig({ reasoningEffort: 'low' }, draft.id)

    expect(draft.run.modelConfig.reasoningEffort).toBe('low')
    expect(draft.run.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('set the mode the draft will start in', async () => {
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)

    controller.setPermissionMode('plan', draft.id)

    expect(draft.run.permissionMode).toBe('plan')
    expect(controller.globalDefaults.permissionMode).toBe('auto')
  })

  test('switch the agent of the draft, which has no session to hand over', async () => {
    // WHY: `switchActiveAgent` resolved sessions, so a named draft fell into the
    // "no composer at all" branch — it moved the app-wide default and left the
    // run the next Send would use still pointed at the outgoing agent.
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)

    await controller.switchActiveAgent('codex', draft.id)

    expect(draft.run.provider).toBe('codex')
    expect(draft.run.modelConfig.modelId).toBe('gpt-6-astra')
  })

  test('leave the agent the next composer opens on alone', async () => {
    // WHY: a draft's agent is a choice about this composer. Writing it into the
    // settings default would hand it to every other surface reading that value.
    const settings = makeSettings({})
    const draft = makeDraft()
    const controller = await makeController(settings, null, undefined, draft)

    await controller.switchActiveAgent('codex', draft.id)

    expect(settings.activeAgent).toBe('claude-code')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('hand the draft a new run rather than editing the one it holds', async () => {
    // WHY: the draft owns its run. Editing it in place crosses a Svelte
    // ownership boundary, which is why every other draft write replaces it.
    const draft = makeDraft()
    const controller = await makeController(makeSettings({}), null, undefined, draft)
    const before = draft.run

    controller.updateModelConfig({ modelId: 'claude-sonnet-5' }, draft.id)

    expect(draft.run).not.toBe(before)
  })
})
