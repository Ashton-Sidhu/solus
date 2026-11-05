import { MODEL_PROFILES, REASONING_EFFORT_LABELS, type ModelProfile, type ReasoningEffort } from '@solus/contracts/types'
import type { Model } from './generated/v2/Model'

/** Codex names no context window in `model/list`; the picker's own default for a model it does not know. */
const UNKNOWN_CONTEXT_WINDOW = 200_000

function isReasoningEffort(effort: string): effort is ReasoningEffort {
  return Object.hasOwn(REASONING_EFFORT_LABELS, effort)
}

/**
 * Profiles for the models Codex lists that the published model list does not
 * know (t3code #27931), with the reasoning levels Codex reports for each. The
 * published list stays authoritative: a model it knows is never returned. It
 * is read at call time, because the host replaces it daily.
 */
export function unlistedCodexModelProfiles(models: readonly Model[]): Record<string, ModelProfile> {
  const known = MODEL_PROFILES.codex ?? {}
  const profiles: Record<string, ModelProfile> = {}
  for (const model of models) {
    if (Object.hasOwn(known, model.id)) continue
    const reasoningLevels = model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter(isReasoningEffort)
    if (!reasoningLevels.length) continue
    profiles[model.id] = {
      label: model.displayName || model.id,
      reasoningLevels,
      defaultReasoningEffort: isReasoningEffort(model.defaultReasoningEffort) && reasoningLevels.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : reasoningLevels[0]!,
      supportsFastMode: model.serviceTiers.some((tier) => tier.id === 'fast'),
      contextWindows: [UNKNOWN_CONTEXT_WINDOW],
      defaultContextWindow: UNKNOWN_CONTEXT_WINDOW,
    }
  }
  return profiles
}
