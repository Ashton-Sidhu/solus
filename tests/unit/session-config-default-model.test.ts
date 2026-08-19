import { afterEach, describe, expect, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'

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

async function makeController(settings: ReturnType<typeof makeSettings>) {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  const { SessionConfigController } = await import('@solus/workspace-ui/contexts/workspace/session-config.svelte')
  return new SessionConfigController({
    settings: settings as any,
    registry: { activeTabId: null, activeSession: null, sessionFor: () => null } as any,
    statusBar: { ctx: { workingDirectory: '/repo' } } as any,
    setPluginCommands: () => {},
    openSessionDraft: () => {},
    ctx: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
    ctxForDirectory: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
    refreshPluginCommands: () => {},
    refreshGitRefs: () => {},
    refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
  })
}

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

    expect(controller.globalDefaults.modelConfig.modelId).toBe('gpt-5.6-sol')
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
})
