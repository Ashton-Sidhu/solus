import type { AgentId, ModelConfig } from '@solus/contracts/types'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { ModelOptions } from '@solus/contracts/settings'

/** Saved options must still fit the model's current advertised profile. */
export function restoredModelConfig(provider: AgentId, modelId: string | null, saved?: ModelOptions): ModelConfig {
  if (modelId === AUTO_MODEL_ID) {
    return { modelId, reasoningEffort: 'medium', contextWindow: null, fastMode: false }
  }
  const profile = MODEL_PROFILES[provider]?.[modelId ?? '']
  const reasoningEffort = saved && profile?.reasoningLevels.includes(saved.reasoningEffort)
    ? saved.reasoningEffort : profile?.defaultReasoningEffort ?? 'high'
  const contextWindow = saved && (saved.contextWindow === null || profile?.contextWindows.includes(saved.contextWindow))
    ? saved.contextWindow : profile?.defaultContextWindow ?? null
  return { modelId, reasoningEffort, contextWindow, fastMode: !!profile?.supportsFastMode && !!saved?.fastMode }
}
