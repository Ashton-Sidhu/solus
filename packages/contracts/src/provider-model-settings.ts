import { AUTO_MODEL_ID } from './model-routing'
import { MODEL_PROFILES, isLegacyModel, type AgentId, type ModelProfile } from './types'
import type { ModelOptions, PersonalSettings } from './settings'

export const PROVIDERS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const satisfies ReadonlyArray<{ id: AgentId; label: string }>

/** Keep a saved model visible even after the catalog retires it. */
export function providerModelChoices(provider: AgentId, savedModel?: string, profiles = MODEL_PROFILES[provider] ?? {}) {
  const models = Object.entries(profiles)
    .filter(([id]) => !isLegacyModel(provider, id, profiles) || id === savedModel)
    .map(([value, profile]) => ({ value, label: profile.label }))
  if (savedModel && savedModel !== AUTO_MODEL_ID && !models.some((model) => model.value === savedModel)) {
    models.push({ value: savedModel, label: `${savedModel} (unavailable)` })
  }
  return [{ value: '', label: 'Built-in default' }, { value: AUTO_MODEL_ID, label: 'Auto' }, ...models]
}

export function providerDefaultModel(provider: AgentId, savedModel?: string, profiles = MODEL_PROFILES[provider] ?? {}): string | null {
  if (savedModel === AUTO_MODEL_ID) return AUTO_MODEL_ID
  if (savedModel && profiles[savedModel]) return savedModel
  return Object.entries(profiles).find(([, profile]) => profile.isDefault)?.[0] ?? null
}

/** A settings change replaces one provider's choice and preserves the others. */
export function withProviderDefault(defaults: PersonalSettings['defaultModels'], provider: AgentId, modelId: string): PersonalSettings['defaultModels'] {
  const next = { ...defaults }
  if (modelId) next[provider] = modelId
  else delete next[provider]
  return next
}

/** Match the options used by new sessions, including catalog capability limits. */
export function providerModelOptions(provider: AgentId, modelId: string | null, saved?: ModelOptions, profileOverride?: ModelProfile): ModelOptions {
  const profile = profileOverride ?? (modelId ? MODEL_PROFILES[provider]?.[modelId] : undefined)
  return {
    reasoningEffort: saved && profile?.reasoningLevels.includes(saved.reasoningEffort)
      ? saved.reasoningEffort : profile?.defaultReasoningEffort ?? 'high',
    contextWindow: saved?.contextWindow === null ? null
      : saved?.contextWindow && profile?.contextWindows.includes(saved.contextWindow)
        ? saved.contextWindow : profile?.defaultContextWindow ?? null,
    fastMode: profile?.supportsFastMode === true && saved?.fastMode === true,
  }
}
