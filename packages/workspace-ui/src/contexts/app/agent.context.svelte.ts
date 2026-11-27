import { createAppContext } from './create-app-context'
import { agentForProject } from '@solus/contracts/provider-instance-models'
import { MODEL_PROFILES, providerModelsFor, type AgentMetadata, type ModelProfile } from '@solus/contracts/types'
import { modelProfilesStore } from '../updates/model-profiles.store.svelte'
import type { SettingsContext } from './settings.context.svelte'

/**
 * Refresh a hydrated `AgentMetadata` against the live published `MODEL_PROFILES`:
 * - When the agent reported its account's offered models (`modelsOffered`), keep
 *   only those models and refresh each profile from the published list while
 *   preserving the agent's reported reasoning levels.
 * - Otherwise, rebuild `models`, `modelProfiles`, and `defaultModel` together so
 *   stale `modelProfiles` never drop `isLegacy` flags on newly listed models.
 */
export function applyLiveModelProfiles(meta: AgentMetadata): AgentMetadata {
  const listed = MODEL_PROFILES[meta.id]
  if (!listed) return meta
  if (meta.modelsOffered) {
    if (!meta.modelProfiles) return meta
    const refreshed: Record<string, ModelProfile> = {}
    for (const [id, existing] of Object.entries(meta.modelProfiles)) {
      const published = listed[id]
      if (!published) {
        refreshed[id] = existing
        continue
      }
      const profile: ModelProfile = { ...published }
      if (existing.reasoningLevels.length) {
        profile.reasoningLevels = existing.reasoningLevels
        if (!profile.reasoningLevels.includes(profile.defaultReasoningEffort)) {
          profile.defaultReasoningEffort = profile.reasoningLevels.includes('medium') ? 'medium' : profile.reasoningLevels[0]!
        }
      }
      refreshed[id] = profile
    }
    const updated: AgentMetadata = {
      ...meta,
      models: meta.models.map((model) => ({ id: model.id, label: refreshed[model.id]?.label ?? model.label })),
      modelProfiles: refreshed,
      defaultModel: meta.models.find((model) => refreshed[model.id]?.isDefault)?.id ?? meta.models[0]?.id ?? meta.defaultModel,
    }
    return meta.instancePreferences ? agentForProject(updated) : updated
  }
  if (meta.instancePreferences) return agentForProject(meta)
  const updated: AgentMetadata = {
    ...meta,
    ...providerModelsFor(meta.id),
  }
  if (meta.modelProfiles) updated.modelProfiles = { ...meta.modelProfiles, ...listed }
  return updated
}

/**
 * Frontend store for the backend-provided agent list. Session startup hydrates
 * this once from `start().agents`; UI components only read from this store.
 */
export class AgentContext {
  // primary-host by decision pending WP6 host framing (docs/plans/multi-host-parity.md)
  agents = $state<AgentMetadata[]>([])
  /** A host's model list, once one is in effect, replaces the models the host
   *  listed at start: the list can change while the app runs. */
  metadata: Record<string, AgentMetadata | null> = $derived.by(() => {
    const hasHostModelList = modelProfilesStore.revision > 0
    return Object.fromEntries(this.agents.map((meta) => [
      meta.id,
      hasHostModelList ? applyLiveModelProfiles(meta) : meta,
    ]))
  })

  private settings: SettingsContext

  constructor(settings: SettingsContext) {
    this.settings = settings
  }

  get activeMetadata(): AgentMetadata | null {
    return this.metadata[this.settings.activeAgent] ?? null
  }

  hydrate(agents: AgentMetadata[]): void {
    this.agents = agents
  }
}

export const [getAgentContext, setAgentContext] = createAppContext<AgentContext>('agent')
