import { describe, expect, test } from 'bun:test'
import { newProviderInstance } from '@solus/contracts/provider-instances'
import { isLegacyModel } from '@solus/contracts/types'
import { instanceModelCatalog, changeModelPreference } from '@solus/contracts/provider-instance-models'
import { modelOptionsFor, splitLegacyModels } from '@solus/workspace-ui/components/pickers/lib/picker-selection'
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
  test('visibility and explicit order are applied together', () => {
    let instance = newProviderInstance('codex', 'work', 'Work')
    const models = instanceModelCatalog(instance).models
    const first = models[0]!.id
    const second = models[1]!.id
    instance = changeModelPreference(instance, first, 'visibility')
    expect(instanceModelCatalog(instance).models.some((model) => model.id === first)).toBe(false)
    expect(instanceModelCatalog(instance, true).models.some((model) => model.id === first)).toBe(true)
    instance = changeModelPreference(instance, first, 'visibility')
    instance = changeModelPreference(instance, second, 'up')
    expect(instanceModelCatalog(instance).models[0]?.id).toBe(second)
  })
  test('a move stays among the models the picker shows together', () => {
    // The picker lists current models, then legacy ones. A move that only passes a legacy model
    // would change nothing on screen, so a current model passes the next current model instead.
    let instance = newProviderInstance('claude-code', 'work', 'Work')
    const all = instanceModelCatalog(instance).models.map((model) => model.id)
    const legacy = all.filter((id) => isLegacyModel('claude-code', id))
    const current = all.filter((id) => !isLegacyModel('claude-code', id))
    instance.modelOrder = [current[0]!, legacy[0]!, ...current.slice(1), ...legacy.slice(1)]
    instance = changeModelPreference(instance, current[0]!, 'down')
    const moved = instanceModelCatalog(instance).models.map((model) => model.id).filter((id) => !isLegacyModel('claude-code', id))
    expect(moved.slice(0, 2)).toEqual([current[1], current[0]])
    expect(changeModelPreference(instance, moved.at(-1)!, 'down')).toBe(instance)
  })
  test('a person can move a model between the picker groups and back', () => {
    // The picker reads the instance catalog, so its legacy disclosure follows the person's choice.
    let instance = newProviderInstance('claude-code', 'work', 'Work')
    const ids = instanceModelCatalog(instance).models.map((model) => model.id)
    const oldModel = ids.find((id) => isLegacyModel('claude-code', id))!
    const newModel = ids.find((id) => !isLegacyModel('claude-code', id))!
    instance = changeModelPreference(changeModelPreference(instance, oldModel, 'group'), newModel, 'group')
    let catalog = instanceModelCatalog(instance)
    expect(splitLegacyModels('claude-code', catalog.models, catalog.modelProfiles).current.map((model) => model.id)).toContain(oldModel)
    expect(splitLegacyModels('claude-code', catalog.models, catalog.modelProfiles).legacy.map((model) => model.id)).toContain(newModel)
    // Moving back stores nothing, so a later catalog change still reaches the model.
    instance = changeModelPreference(changeModelPreference(instance, oldModel, 'group'), newModel, 'group')
    expect(instance.modelGroups).toEqual({})
    catalog = instanceModelCatalog(instance)
    expect(catalog.modelProfiles[oldModel]?.isLegacy).toBe(true)
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
