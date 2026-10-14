import { MODEL_PROFILES, type AgentId, type ReasoningEffort } from '@solus/contracts/types'

type SubagentModel = { model: string; reasoningEffort: ReasoningEffort } | { error: string }

/** Explicit model choices must be honored; defaults come from the shared profiles. */
export function resolveSubagentModel(
  provider: AgentId,
  requestedModel: string | undefined,
  defaultModel: string,
  requestedEffort: ReasoningEffort | undefined,
): SubagentModel {
  const profiles = MODEL_PROFILES[provider] ?? {}
  const model = (requestedModel ?? defaultModel).trim()
  const profile = profiles[model]
  if (!profile) {
    return { error: `Unknown model "${model}" for ${provider}. Valid models: ${Object.keys(profiles).join(', ')}.` }
  }
  const reasoningEffort = requestedEffort ?? profile.defaultReasoningEffort
  if (!profile.reasoningLevels.includes(reasoningEffort)) {
    return { error: `Model "${model}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
  }
  return { model, reasoningEffort }
}
