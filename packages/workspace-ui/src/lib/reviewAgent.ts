import { type AgentId, type ReasoningEffort } from '@solus/contracts/types'
import { type SettingsContext } from '../contexts'

/**
 * Resolve the review guide's effective agent + model + reasoning effort for a
 * `generateGuide` call. The `reviewAgent`/`reviewModel`/`reviewReasoning`
 * settings are the exact durable choices shown in Settings. Guide generation
 * must not derive any of them from the active conversation.
 */
export interface ResolvedReviewAgent {
  agent: AgentId
  model: string | null
  reasoningEffort: ReasoningEffort | null
}

export function resolveReviewAgent(
  settings: Pick<SettingsContext, 'reviewAgent' | 'reviewModel' | 'reviewReasoning'>,
): ResolvedReviewAgent {
  return {
    agent: settings.reviewAgent,
    model: settings.reviewModel,
    reasoningEffort: settings.reviewReasoning,
  }
}
