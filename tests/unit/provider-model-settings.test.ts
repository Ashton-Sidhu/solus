import { describe, expect, test } from 'bun:test'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { providerDefaultModel, providerModelChoices, providerModelOptions, withProviderDefault } from '@solus/contracts/provider-model-settings'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { newSessionModel } from '../../apps/mobile/src/features/conversation/lib/run-settings'

describe('provider settings', () => {
  test('changing and resetting one provider preserves the other and the default provider', () => {
    const storage = memoryKeyValueStore()
    const store = new PersonalSettingsStore(storage)
    store.set({ activeAgent: 'claude-code', defaultModels: { 'claude-code': 'claude-sonnet-5' } })
    store.set({ defaultModels: withProviderDefault(store.current().defaultModels, 'codex', 'gpt-6-luna') })
    expect(store.current().activeAgent).toBe('claude-code')
    const restored = new PersonalSettingsStore(storage)
    expect(newSessionModel('codex', restored.current()).preferredModel).toBe('gpt-6-luna')
    expect(newSessionModel('claude-code', restored.current()).preferredModel).toBe('claude-sonnet-5')
    restored.set({ defaultModels: withProviderDefault(restored.current().defaultModels, 'codex', '') })
    expect(restored.current().defaultModels).toEqual({ 'claude-code': 'claude-sonnet-5' })
    expect(newSessionModel('codex', restored.current()).preferredModel).toBe(providerDefaultModel('codex'))
  })

  test('a retired choice stays visible and an unavailable choice is preserved with an explicit fallback', () => {
    expect(providerModelChoices('claude-code', 'claude-haiku-4-5-20251001').some((model) => model.value === 'claude-haiku-4-5-20251001')).toBe(true)
    expect(providerModelChoices('codex', 'removed-model')).toContainEqual({ value: 'removed-model', label: 'removed-model (unavailable)' })
    expect(providerDefaultModel('codex', 'removed-model')).toBe(providerDefaultModel('codex'))
    expect(providerDefaultModel('codex', 'auto')).toBe('auto')
  })

  test('option controls show what a new session will use and reset to catalog defaults', () => {
    const model = 'gpt-6-astra'
    const store = new PersonalSettingsStore(memoryKeyValueStore())
    const saved = { reasoningEffort: 'max' as const, contextWindow: 1_050_000, fastMode: true }
    store.set({ defaultModels: { codex: model } })
    store.saveModelOptions('codex', model, saved)
    expect(providerModelOptions('codex', model, saved)).toEqual(saved)
    expect(newSessionModel('codex', store.current())).toMatchObject(saved)
    const defaults = providerModelOptions('codex', model)
    expect(defaults.reasoningEffort).toBe(MODEL_PROFILES.codex![model]!.defaultReasoningEffort)
    expect(defaults.contextWindow).toBe(MODEL_PROFILES.codex![model]!.defaultContextWindow)
    expect(defaults.fastMode).toBe(false)
  })

  test('unsupported reasoning, window, and fast mode do not become effective options', () => {
    const options = providerModelOptions('claude-code', 'claude-haiku-4-5-20251001', {
      reasoningEffort: 'ultracode', contextWindow: 1_000_000, fastMode: true,
    })
    expect(options).toEqual({ reasoningEffort: 'medium', contextWindow: 200_000, fastMode: false })
  })
})
