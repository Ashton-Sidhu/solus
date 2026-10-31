import { describe, expect, test } from 'bun:test'
import { newProviderInstance } from '@solus/contracts/provider-instances'
import { instanceModelCatalog, changeModelPreference } from '@solus/contracts/provider-instance-models'
import { modelOptionsFor } from '@solus/workspace-ui/components/pickers/lib/picker-selection'
import { newSessionModel } from '../../apps/mobile/src/features/conversation/lib/run-settings'

const customModel = { id: 'private-model', label: 'Private model', reasoningLevels: ['low', 'high'] as const, defaultReasoningEffort: 'low' as const, contextWindows: [32000], defaultContextWindow: 32000, supportsFastMode: true }

describe('private instance model catalogs', () => {
  test('custom model capabilities reach native defaults without changing the global catalog', () => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.customModels.push({ ...customModel, reasoningLevels: [...customModel.reasoningLevels] })
    const catalog = instanceModelCatalog(instance)
    expect(newSessionModel('codex', { defaultModels: { codex: 'private-model' }, modelOptionsByProvider: {} }, catalog)).toEqual({ preferredModel: 'private-model', reasoningEffort: 'low', contextWindow: 32000, fastMode: false })
    expect(instanceModelCatalog(newProviderInstance('codex', 'other', 'Other')).modelProfiles['private-model']).toBeUndefined()
  })
  test('favorites, visibility, and explicit order are applied together', () => {
    let instance = newProviderInstance('codex', 'work', 'Work')
    const models = instanceModelCatalog(instance).models
    const first = models[0]!.id
    const second = models[1]!.id
    instance = changeModelPreference(instance, second, 'favorite')
    expect(instanceModelCatalog(instance).models[0]?.id).toBe(second)
    instance = changeModelPreference(instance, first, 'visibility')
    expect(instanceModelCatalog(instance).models.some((model) => model.id === first)).toBe(false)
    expect(instanceModelCatalog(instance, true).models.some((model) => model.id === first)).toBe(true)
    instance = changeModelPreference(instance, first, 'visibility')
    instance = changeModelPreference(instance, second, 'favorite')
    instance = changeModelPreference(instance, second, 'up')
    expect(instanceModelCatalog(instance).models[0]?.id).toBe(second)
  })
  test('hiding all built-ins does not silently restore them in the desktop picker', () => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.hiddenModels = instanceModelCatalog(instance).models.map((model) => model.id)
    const catalog = instanceModelCatalog(instance)
    expect(modelOptionsFor('codex', { codex: { id: 'codex', label: 'Codex', defaultModel: '', ...catalog } })).toEqual([])
  })
  test('custom models stay visible when built-in models are hidden', () => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.customModels.push({ ...customModel, reasoningLevels: [...customModel.reasoningLevels] })
    instance.hiddenModels = instanceModelCatalog(instance).models.map((model) => model.id)
    expect(instanceModelCatalog(instance).models).toEqual([{ id: 'private-model', label: 'Private model' }])
  })
})
