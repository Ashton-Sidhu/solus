import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL_ROUTING, modelRoutingSchema } from '@solus/contracts/model-routing'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema, mergeHostConfig } from '@solus/contracts/host-config'
import { FIVE_HOUR_WINDOW_MINS, MODEL_PROFILES, WEEKLY_WINDOW_MINS, type AgentMetadata } from '@solus/contracts/types'
import { routeModelPrompt, selectModelRoute } from '@solus/server/agents/model-routing'
import { UsageLimitsStore } from '@solus/server/usage/usage-store'

const agents: AgentMetadata[] = (['claude-code', 'codex'] as const).map(id => ({
  id, label: id, available: true,
  models: Object.entries(MODEL_PROFILES[id]).map(([id, model]) => ({ id, label: model.label })),
  defaultModel: id === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5',
}))

describe('one-time model routing', () => {
  test('the category model names the provider that runs the turn', () => {
    expect(selectModelRoute('ui', DEFAULT_MODEL_ROUTING, agents)).toMatchObject({ provider: 'claude-code', modelId: DEFAULT_MODEL_ROUTING.ui, usedFallback: false })
    expect(selectModelRoute('structured', DEFAULT_MODEL_ROUTING, agents)).toMatchObject({ provider: 'codex', modelId: DEFAULT_MODEL_ROUTING.structured, usedFallback: false })
  })

  test('a category model no installed provider offers uses the general route', () => {
    expect(selectModelRoute('ui', DEFAULT_MODEL_ROUTING, agents.filter(agent => agent.id === 'codex')))
      .toMatchObject({ provider: 'codex', modelId: DEFAULT_MODEL_ROUTING.general, usedFallback: true })
  })

  test('a removed category model uses the configured general route', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, ui: 'removed' }
    expect(selectModelRoute('ui', config, agents)).toMatchObject({ provider: 'codex', modelId: DEFAULT_MODEL_ROUTING.general, usedFallback: true })
  })

  test('removed general models use an available provider default, never Auto', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, general: 'removed' }
    expect(selectModelRoute('general', config, agents)).toMatchObject({ provider: 'claude-code', modelId: 'claude-opus-5-5', usedFallback: true })
    expect(() => selectModelRoute('ui', config, [])).toThrow('available Claude or Codex')
  })

  test('the chosen provider being out of quota takes the fallback provider', async () => {
    const usage = new UsageLimitsStore()
    usage.applyWindows('claude-code', [{ windowDurationMins: FIVE_HOUR_WINDOW_MINS, usedPercent: 100, resetsAt: null }])
    // Interface work chooses Claude; with its window spent the Codex interface
    // model takes the turn rather than a run that cannot start.
    const result = await routeModelPrompt('Redesign the toolbar', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, {
      spent: provider => usage.isSpent(provider),
      classify: async () => 'ui',
    })
    // Claude is out, so the UI model goes with it; the General use model on
    // Codex takes the turn.
    expect(result).toMatchObject({ provider: 'codex', modelId: DEFAULT_MODEL_ROUTING.general, category: 'ui' })
  })

  test('both providers out of quota keeps the chosen model', async () => {
    const result = await routeModelPrompt('Redesign the toolbar', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, {
      spent: () => true,
      classify: async () => 'ui',
    })
    expect(result).toMatchObject({ provider: 'claude-code', category: 'ui' })
  })

  test('a spent weekly window is out of quota even while the session window has room', async () => {
    const usage = new UsageLimitsStore()
    usage.applyWindows('claude-code', [
      { windowDurationMins: FIVE_HOUR_WINDOW_MINS, usedPercent: 10, resetsAt: null },
      { windowDurationMins: WEEKLY_WINDOW_MINS, usedPercent: 100, resetsAt: null },
    ])
    const result = await routeModelPrompt('Investigate alternatives', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, {
      spent: provider => usage.isSpent(provider),
      classify: async () => 'exploration',
    })
    expect(result).toMatchObject({ provider: 'codex', modelId: DEFAULT_MODEL_ROUTING.general, category: 'exploration' })
  })

  test('routes the original prompt through one classification call', async () => {
    let calls = 0
    const result = await routeModelPrompt('Investigate alternatives', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, { classify: async prompt => {
      expect(prompt).toBe('Investigate alternatives')
      calls++
      return 'exploration'
    } })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ category: 'exploration', provider: 'claude-code', usedFallback: false })
  })

  test('a service failure uses the user-configured general model', async () => {
    const config = { ...DEFAULT_MODEL_ROUTING, general: 'gpt-5.6-terra' }
    const result = await routeModelPrompt('Fix this', config, agents, new AbortController().signal, { classify: async () => { throw new Error('Unavailable') } })
    expect(result).toMatchObject({ modelId: 'gpt-5.6-terra', category: 'general', usedFallback: true })
  })

  test('the deadline aborts a stalled classifier and selects general', async () => {
    let classifierSignal: AbortSignal | undefined
    const result = await routeModelPrompt('Fix this', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, { timeoutMs: 0, classify: (_prompt, signal) => {
      classifierSignal = signal
      return new Promise(() => {})
    } })
    expect(classifierSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ category: 'general', usedFallback: true })
  })

  test('Stop cancels classification without selecting a fallback or starting work', async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = routeModelPrompt('Fix this', DEFAULT_MODEL_ROUTING, agents, controller.signal, { classify: () => {
      started()
      return new Promise(() => {})
    } })
    await ready
    controller.abort(new Error('Interrupted'))
    await expect(pending).rejects.toThrow('Interrupted')
  })

  test('routing settings persist independently and reject recursive Auto routes', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, ui: 'gpt-6-astra' }
    const patch = hostConfigPatchSchema.parse({ modelRouting: config })
    expect(mergeHostConfig(DEFAULT_HOST_CONFIG, patch).modelRouting).toEqual(config)
    expect(mergeHostConfig({ ...DEFAULT_HOST_CONFIG, modelRouting: config }, { fontSize: 15 }).modelRouting).toEqual(config)
    expect(modelRoutingSchema.safeParse({ ...config, ui: 'auto' }).success).toBe(false)
  })
})
