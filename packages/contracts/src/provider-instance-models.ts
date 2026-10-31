import { MODEL_PROFILES, type AgentId, type AgentMetadata, type ModelProfile } from './types'
import { sameHostPath } from './host-path'
import { worktreeProjectRoot } from './types'
import type { ProviderProjectOverride, ProviderInstance, ProviderInstancesSnapshot } from './provider-instances'

/** The same private catalog order and visibility on every client. Custom models remain visible. */
export function instanceModelCatalog(instance: Pick<ProviderInstance, 'provider' | 'customModels' | 'hiddenModels' | 'favoriteModels' | 'modelOrder'>, includeHidden = false) {
  const modelProfiles = { ...MODEL_PROFILES[instance.provider] }
  const custom = new Set(instance.customModels.map((model) => model.id))
  for (const { id, ...profile } of instance.customModels) modelProfiles[id] = profile
  const order = new Map(instance.modelOrder.map((id, index) => [id, index]))
  const favorites = new Set(instance.favoriteModels)
  const hidden = new Set(instance.hiddenModels)
  const models = Object.entries(modelProfiles)
    .filter(([id]) => includeHidden || custom.has(id) || !hidden.has(id))
    .map(([id, profile], index) => ({ id, label: profile.label, index }))
    .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || (order.get(a.id) ?? 10000 + a.index) - (order.get(b.id) ?? 10000 + b.index))
    .map(({ id, label }) => ({ id, label }))
  return { models, modelProfiles }
}

export function modelProfileForAgent(provider: AgentId, modelId: string | null, metadata?: Pick<AgentMetadata, 'modelProfiles'> | null): ModelProfile | undefined {
  if (!modelId) return undefined
  return metadata?.modelProfiles?.[modelId] ?? MODEL_PROFILES[provider]?.[modelId]
}

export function changeModelPreference(instance: ProviderInstance, modelId: string, action: 'favorite' | 'visibility' | 'up' | 'down'): ProviderInstance {
  if (action === 'favorite' || action === 'visibility') {
    const key = action === 'favorite' ? 'favoriteModels' : 'hiddenModels'
    const current = instance[key]
    return { ...instance, [key]: current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId] }
  }
  const order = instanceModelCatalog(instance, true).models.map((model) => model.id)
  const at = order.indexOf(modelId)
  const target = at + (action === 'up' ? -1 : 1)
  if (at < 0 || target < 0 || target >= order.length) return instance
  order.splice(target, 0, order.splice(at, 1)[0]!)
  return { ...instance, modelOrder: order }
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
