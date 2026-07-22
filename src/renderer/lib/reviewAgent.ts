import { MODEL_PROFILES, type AgentId, type ReasoningEffort } from '../../shared/types'
import { type SettingsContext, type AgentContext } from '../contexts'

/**
 * Resolve the review guide's effective agent + model + reasoning effort for a
 * `generateGuide` call. The `reviewAgent`/`reviewModel`/`reviewReasoning`
 * settings are overrides: null means "follow the active agent / that agent's
 * default model / a medium default reasoning effort".
 *
 * Reasoning defaults to `medium` regardless of model (reviews don't need the
 * model's heavier chat default) unless the user explicitly sets `reviewReasoning`
 * to a level the resolved model supports.
 *
 * Each override is only honored when it belongs to the resolved agent/model — a
 * model override is a different provider's id once the agent changes (e.g.
 * `reviewAgent` is null and `activeAgent` flips to codex while `reviewModel` still
 * holds a Claude id). Applying it blindly ran codex with a stale Claude model id;
 * we mirror the main model picker (status-bar.context) and fall back to the
 * agent/model default whenever the override doesn't match.
 */
export function resolveReviewAgent(
  settings: SettingsContext,
  agents: AgentContext,
): { agent: AgentId; model: string | null; reasoningEffort: ReasoningEffort | null } {
  const agent = settings.reviewAgent ?? settings.activeAgent
  const meta = agents.metadata[agent] ?? null
  const models = meta?.models ?? []
  const model =
    settings.reviewModel && models.some((m) => m.id === settings.reviewModel)
      ? settings.reviewModel
      : meta?.defaultModel ?? null
  const profile = model ? MODEL_PROFILES[agent]?.[model] : undefined
  const reasoningEffort: ReasoningEffort =
    settings.reviewReasoning && profile?.reasoningLevels.includes(settings.reviewReasoning)
      ? settings.reviewReasoning
      : 'medium'
  return { agent, model, reasoningEffort }
}
