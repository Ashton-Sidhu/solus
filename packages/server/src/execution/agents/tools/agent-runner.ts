import type { AgentId, AgentTarget, ReasoningEffort } from '@solus/contracts/types'

/**
 * The runner check that start_sessions and send_session share. It imports no
 * other session tool, so either tool module can load first.
 */

export type Checked<T> = T | { error: string }

/** The provider, model and reasoning level a session runs on. */
export interface Runner {
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
}

/** Checks the requested provider, model and reasoning level against what the host offers. */
export function chooseRunner(targets: readonly AgentTarget[], requestedProvider: string, requestedModel: string | undefined, requestedEffort: ReasoningEffort | undefined): Checked<Runner> {
  const target = targets.find((candidate) => candidate.provider === requestedProvider)
  if (!target) return { error: `Unknown agent provider "${requestedProvider}". Call list_agent_targets for current choices.` }
  if (!target.available) {
    return { error: `Agent provider "${requestedProvider}" is unavailable${target.unavailableReason ? `: ${target.unavailableReason}` : '.'}` }
  }
  const modelId = requestedModel?.trim() || target.defaultModel
  if (!modelId) return { error: 'start_sessions requires model_id.' }
  const profile = target.models.find((model) => model.id === modelId)
  if (!profile) {
    return { error: `Unknown model "${modelId}" for ${target.provider}. Valid models: ${target.models.map((model) => model.id).join(', ') || '(none)'}.` }
  }
  const reasoningEffort = requestedEffort ?? profile.defaultReasoningEffort
  if (profile.reasoningLevels.length > 0 && !profile.reasoningLevels.includes(reasoningEffort)) {
    return { error: `Model "${modelId}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
  }
  return { provider: target.provider, modelId, reasoningEffort, contextWindow: profile.defaultContextWindow }
}
