/**
 * Grouping for the mobile model sheet.
 *
 * The model in this session is lifted to the top under its own label so the
 * check that marks it is not somewhere in the middle of the list. Everything
 * else is one list: Codex reads that way already, because its labels share a
 * single family name, and splitting Claude into Opus/Sonnet/Haiku cards made
 * the same sheet look like two different designs per agent.
 */
import { MODEL_PROFILES } from '@solus/contracts/types'
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
}

/** Heading over everything that is not the model already in use. */
export const ALL_MODELS_LABEL = 'All models'

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
  // resorting would bury the one most people want.
  const rest = models.filter((model) => model.id !== currentId).map(entry)
  if (rest.length > 0) groups.push({ label: ALL_MODELS_LABEL, models: rest })
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
      label: group.label,
      models: group.models.filter((model) =>
        `${model.label} ${model.fact}`.toLocaleLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0)
}
