import type { AgentMetadata, AgentTarget } from '@solus/contracts/types'
import { MODEL_PROFILES } from '@solus/contracts/types'

/** Build the agent-facing launch catalogue from one registered backend. Binary
 * availability is supplied by the host probe; model policy remains owned by
 * the same shared profiles every other launch surface uses. */
export function agentTargetFromMetadata(metadata: AgentMetadata): AgentTarget {
  const profiles = MODEL_PROFILES[metadata.id] ?? {}
  return {
    provider: metadata.id,
    label: metadata.label,
    available: metadata.available !== false,
    unavailableReason: metadata.unavailableReason,
    defaultModel: metadata.defaultModel,
    models: metadata.models.map((model) => {
      const profile = profiles[model.id]
      return {
        id: model.id,
        label: model.label,
        reasoningLevels: profile?.reasoningLevels ?? [],
        defaultReasoningEffort: profile?.defaultReasoningEffort ?? 'medium',
        defaultContextWindow: profile?.defaultContextWindow ?? null,
      }
    }),
  }
}
