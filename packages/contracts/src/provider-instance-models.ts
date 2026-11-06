import { MODEL_PROFILES, type AgentId, type AgentMetadata, type ModelProfile } from './types'
import { sameHostPath } from './host-path'
import { worktreeProjectRoot } from './types'
import type { ProviderProjectOverride, ProviderInstance, ProviderInstancesSnapshot } from './provider-instances'

/**
 * The same private catalog order, visibility, and picker groups on every client. Custom models remain visible.
 * A person's group choice is written into each profile's `isLegacy`, so every picker that reads the catalog follows it.
 */
export function instanceModelCatalog(instance: Pick<ProviderInstance, 'provider' | 'customModels' | 'hiddenModels' | 'modelOrder' | 'modelGroups'>, includeHidden = false) {
  const modelProfiles = { ...MODEL_PROFILES[instance.provider] }
  const custom = new Set(instance.customModels.map((model) => model.id))
  for (const { id, ...profile } of instance.customModels) modelProfiles[id] = profile
  for (const [id, group] of Object.entries(instance.modelGroups ?? {})) {
    if (modelProfiles[id]) modelProfiles[id] = { ...modelProfiles[id], isLegacy: group === 'legacy' }
  }
  const order = new Map(instance.modelOrder.map((id, index) => [id, index]))
  const hidden = new Set(instance.hiddenModels)
  const models = Object.entries(modelProfiles)
    .filter(([id]) => includeHidden || custom.has(id) || !hidden.has(id))
    .map(([id, profile], index) => ({ id, label: profile.label, index }))
    .sort((a, b) => (order.get(a.id) ?? 10000 + a.index) - (order.get(b.id) ?? 10000 + b.index))
    .map(({ id, label }) => ({ id, label }))
  return { models, modelProfiles }
}

export function modelProfileForAgent(provider: AgentId, modelId: string | null, metadata?: Pick<AgentMetadata, 'modelProfiles'> | null): ModelProfile | undefined {
  if (!modelId) return undefined
  return metadata?.modelProfiles?.[modelId] ?? MODEL_PROFILES[provider]?.[modelId]
}

export function changeModelPreference(instance: ProviderInstance, modelId: string, action: 'visibility' | 'group' | 'up' | 'down'): ProviderInstance {
  if (action === 'visibility') {
    const hidden = instance.hiddenModels
    return { ...instance, hiddenModels: hidden.includes(modelId) ? hidden.filter((id) => id !== modelId) : [...hidden, modelId] }
  }
  const { modelProfiles } = instanceModelCatalog(instance, true)
  if (action === 'group') {
    const toLegacy = modelProfiles[modelId]?.isLegacy !== true
    const modelGroups = { ...instance.modelGroups }
    // Store only a choice that differs from the catalog, so a later catalog change still reaches a model the person never moved.
    if (toLegacy === (MODEL_PROFILES[instance.provider]?.[modelId]?.isLegacy === true)) delete modelGroups[modelId]
    else modelGroups[modelId] = toLegacy ? 'legacy' : 'current'
    return { ...instance, modelGroups }
  }
  const order = instanceModelCatalog(instance, true).models.map((model) => model.id)
  const at = order.indexOf(modelId)
  const target = modelNeighbor(modelProfiles, order, modelId, action)
  if (at < 0 || target < 0) return instance
  order.splice(target, 0, order.splice(at, 1)[0]!)
  return { ...instance, modelOrder: order }
}

/**
 * The index of the model that `up` or `down` passes in the full order, or -1 at the end of its group.
 * The picker shows legacy models in their own group, so a move stays among the models of the same
 * group; a move that only passes a model of the other group would change nothing visible.
 */
export function modelNeighbor(modelProfiles: Record<string, ModelProfile>, order: readonly string[], modelId: string, direction: 'up' | 'down'): number {
  const group = (id: string) => modelProfiles[id]?.isLegacy === true
  const own = group(modelId)
  const step = direction === 'up' ? -1 : 1
  for (let index = order.indexOf(modelId) + step; index >= 0 && index < order.length; index += step) {
    if (group(order[index]!) === own) return index
  }
  return -1
}

/** Project overrides refer to canonical host project roots, shared by their worktrees. */
export function providerProjectOverride(projects: ProviderProjectOverride[] = [], cwd?: string): ProviderProjectOverride | undefined {
  return cwd ? projects.find((project) => sameHostPath(project.projectRoot, worktreeProjectRoot(cwd))) : undefined
}

export function selectedProviderInstance(snapshot: ProviderInstancesSnapshot, provider: 'codex' | 'claude-code', cwd?: string) {
  const project = providerProjectOverride(snapshot.projects, cwd)
  const instanceId = project?.selected[provider] ?? snapshot.selected[provider]
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.provider === provider)
  return { instance, enabled: instance ? project?.enabled[instance.id] ?? instance.enabled : false }
}

/** Derive only the chosen project's catalog. The host facts remain unchanged. */
export function agentForProject(metadata: AgentMetadata, cwd?: string): AgentMetadata {
  const preferences = metadata.instancePreferences
  if (!preferences) return metadata
  const project = providerProjectOverride(preferences.projects, cwd)
  const provider = metadata.id
  if (provider !== 'codex' && provider !== 'claude-code') return metadata
  const instanceId = project?.selected[provider] ?? preferences.selected
  const instance = preferences.instances.find((item) => item.id === instanceId)
  if (!instance) return { ...metadata, available: false, unavailableReason: 'The project provider instance is unavailable.' }
  const catalog = instanceModelCatalog(instance)
  // Profiles the provider reported live (Codex `model/list`) stay under the instance's catalog.
  if (metadata.modelProfiles) catalog.modelProfiles = { ...metadata.modelProfiles, ...catalog.modelProfiles }
  // So do the models it reported: a catalog lists only the published and the custom ones.
  catalog.models.push(...metadata.models.filter(({ id }) => !MODEL_PROFILES[provider]?.[id]
    && !instance.hiddenModels.includes(id) && !catalog.models.some((model) => model.id === id)))
  const enabled = project?.enabled[instance.id] ?? instance.enabled
  const builtin = Object.entries(catalog.modelProfiles).find(([, profile]) => profile.isDefault)?.[0] ?? metadata.defaultModel
  return { ...metadata, ...catalog, defaultModel: builtin, available: enabled && instance.binaryAvailable,
    unavailableReason: !enabled ? `${instance.displayName} is disabled for this project` : !instance.binaryAvailable ? 'Provider binary not found' : undefined }
}

export type ProjectProviderChange = { kind: 'enabled'; instanceId: string; enabled: boolean | null }
  | { kind: 'selected'; provider: 'codex' | 'claude-code'; instanceId: string | null }
  | { kind: 'reset' }

export function changeProjectProviderOverride(snapshot: ProviderInstancesSnapshot, projectRoot: string, change: ProjectProviderChange): ProviderProjectOverride {
  const current = providerProjectOverride(snapshot.projects, projectRoot)
  const next: ProviderProjectOverride = { projectRoot, enabled: { ...current?.enabled }, selected: { ...current?.selected } }
  if (change.kind === 'reset') return { projectRoot, enabled: {}, selected: {} }
  if (change.kind === 'enabled') {
    if (change.enabled === null) delete next.enabled[change.instanceId]
    else next.enabled[change.instanceId] = change.enabled
  } else {
    if (change.instanceId === null) delete next.selected[change.provider]
    else next.selected[change.provider] = change.instanceId
  }
  return next
}
