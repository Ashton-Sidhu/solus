import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL_ROUTING, modelRoutingSchema } from '@solus/contracts/model-routing'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema, mergeHostConfig } from '@solus/contracts/host-config'
import { MODEL_PROFILES, type AgentMetadata } from '@solus/contracts/types'
import { routeModelPrompt, selectModelRoute } from '@solus/server/agents/model-routing'

const agents: AgentMetadata[] = (['claude-code', 'codex'] as const).map(id => ({
  id, label: id, available: true,
  models: Object.entries(MODEL_PROFILES[id]).map(([id, model]) => ({ id, label: model.label })),
  defaultModel: id === 'codex' ? 'gpt-6-astra' : 'claude-opus-5',
}))

describe('one-time model routing', () => {
  test('category preference wins over the initially selected provider', () => {
    expect(selectModelRoute('ui', DEFAULT_MODEL_ROUTING, agents)).toMatchObject({ provider: 'claude-code', modelId: 'claude-opus-5', usedFallback: false })
    expect(selectModelRoute('structured', DEFAULT_MODEL_ROUTING, agents)).toMatchObject({ provider: 'codex', modelId: 'gpt-5.6-terra' })
  })

  test('uses the category model on the remaining provider', () => {
    expect(selectModelRoute('ui', DEFAULT_MODEL_ROUTING, agents.filter(agent => agent.id === 'codex'))).toMatchObject({ provider: 'codex', modelId: 'gpt-6-astra' })
  })

  test('removed category models use the configured general route', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, ui: { ...DEFAULT_MODEL_ROUTING.ui, codex: 'removed', 'claude-code': 'removed' } }
    expect(selectModelRoute('ui', config, agents)).toMatchObject({ provider: 'codex', modelId: 'gpt-5.6-sol', usedFallback: true })
  })

  test('removed general models use an available provider default, never Auto', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, general: { ...DEFAULT_MODEL_ROUTING.general, codex: 'removed', 'claude-code': 'removed' } }
    expect(selectModelRoute('general', config, agents)).toMatchObject({ modelId: 'gpt-6-astra', usedFallback: true })
    expect(() => selectModelRoute('ui', config, [])).toThrow('available Claude or Codex')
  })

  test('routes the original prompt through one classification call', async () => {
    let calls = 0
    const result = await routeModelPrompt('Investigate alternatives', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, async prompt => {
      expect(prompt).toBe('Investigate alternatives')
      calls++
      return 'exploration'
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ category: 'exploration', provider: 'claude-code', usedFallback: false })
  })

  test('a service failure uses the user-configured general model', async () => {
    const config = { ...DEFAULT_MODEL_ROUTING, general: { ...DEFAULT_MODEL_ROUTING.general, codex: 'gpt-5.6-terra' } }
    const result = await routeModelPrompt('Fix this', config, agents, new AbortController().signal, async () => { throw new Error('Unavailable') })
    expect(result).toMatchObject({ modelId: 'gpt-5.6-terra', category: 'general', usedFallback: true })
  })

  test('the deadline aborts a stalled classifier and selects general', async () => {
    let classifierSignal: AbortSignal | undefined
    const result = await routeModelPrompt('Fix this', DEFAULT_MODEL_ROUTING, agents, new AbortController().signal, (_prompt, signal) => {
      classifierSignal = signal
      return new Promise(() => {})
    }, 0)
    expect(classifierSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ category: 'general', usedFallback: true })
  })

  test('Stop cancels classification without selecting a fallback or starting work', async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = routeModelPrompt('Fix this', DEFAULT_MODEL_ROUTING, agents, controller.signal, () => {
      started()
      return new Promise(() => {})
    })
    await ready
    controller.abort(new Error('Interrupted'))
    await expect(pending).rejects.toThrow('Interrupted')
  })

  test('routing settings persist independently and reject recursive Auto routes', () => {
    const config = { ...DEFAULT_MODEL_ROUTING, ui: { ...DEFAULT_MODEL_ROUTING.ui, preferredProvider: 'codex' as const } }
    const patch = hostConfigPatchSchema.parse({ modelRouting: config })
    expect(mergeHostConfig(DEFAULT_HOST_CONFIG, patch).modelRouting).toEqual(config)
    expect(mergeHostConfig({ ...DEFAULT_HOST_CONFIG, modelRouting: config }, { fontSize: 15 }).modelRouting).toEqual(config)
    expect(modelRoutingSchema.safeParse({ ...config, ui: { ...config.ui, codex: 'auto' } }).success).toBe(false)
  })
})
