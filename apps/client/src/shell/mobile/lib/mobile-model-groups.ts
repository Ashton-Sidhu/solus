import { MODEL_PROFILES, isLegacyModel } from '@solus/contracts/types'
import type { AgentId } from '@solus/contracts/types'

export interface MobileModelEntry {
  id: string
  label: string
  /** The one fact that decides between models in a family, as a mono line. */
  fact: string
}

export interface MobileModelGroup {
  /** Section heading. `In this session` for the lifted current model. */
  label: string
  models: MobileModelEntry[]
  /** The superseded generation. The sheet keeps this section's rows behind a
   *  disclosure heading instead of listing them with the rest. */
  isLegacy?: boolean
}

export const ALL_MODELS_LABEL = 'All models'
export const LEGACY_MODELS_LABEL = 'Legacy models'

/** "1M context" / "200k context" — the window, in the units people say it in. */
export function contextFact(provider: AgentId, modelId: string): string {
  const window = MODEL_PROFILES[provider]?.[modelId]?.defaultContextWindow
  if (!window) return ''
  return window >= 1_000_000
    ? `${window / 1_000_000}M context`
    : `${Math.round(window / 1000)}k context`
}

export function groupModels(
  provider: AgentId,
  models: readonly { id: string; label: string }[],
  currentId: string | null,
): MobileModelGroup[] {
  const entry = (model: { id: string; label: string }): MobileModelEntry => ({
    id: model.id,
    label: model.label,
    fact: contextFact(provider, model.id),
  })

  const groups: MobileModelGroup[] = []
  const current = models.find((model) => model.id === currentId)
  if (current) groups.push({ label: 'In this session', models: [entry(current)] })

  // The provider's own order, kept as given: it puts newer models first, and
  // resorting would bury the one most people want. Superseded models come off
  // the end into their own section — the session's own model is already lifted
  // above, so a session running a legacy model still shows it without the
  // section being open.
  const rest = models.filter((model) => model.id !== currentId)
  const currentGeneration = rest.filter((model) => !isLegacyModel(provider, model.id)).map(entry)
  const legacy = rest.filter((model) => isLegacyModel(provider, model.id)).map(entry)
  if (currentGeneration.length > 0)
    groups.push({ label: ALL_MODELS_LABEL, models: currentGeneration })
  if (legacy.length > 0)
    groups.push({ label: LEGACY_MODELS_LABEL, models: legacy, isLegacy: true })
  return groups
}

/** Matches on the name and on the fact, so "1M" finds every long-context model. */
export function filterModelGroups(
  groups: MobileModelGroup[],
  query: string,
): MobileModelGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return groups
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        `${model.label} ${model.fact}`.toLocaleLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0)
}
