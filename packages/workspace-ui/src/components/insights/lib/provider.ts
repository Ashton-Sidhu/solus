/**
 * Which agent backend a recorded row came from, as the page names it.
 *
 * The stored value is whatever the emitter wrote — `claude`, `claude-code`,
 * `codex`, or nothing at all on turns captured before the field existed. Every
 * surface that shows a provider to a reader was spelling that mapping out
 * again, and the histogram, the turn's identity line, and the Summary card had
 * each arrived at slightly different words for the same backend.
 *
 * A backend Solus does not recognise has no name and no mark here. The wording
 * for that case belongs to the surface — the chart says "Unknown", the identity
 * line says "unknown provider", the Summary card says "Agent" — but none of
 * them may draw it as somebody's brand.
 *
 * Pure and non-reactive.
 */
import { modelLabelFor, type AgentId } from '@solus/contracts/types'

/** The logo drawn beside a backend's name. Null where Solus has no mark to
 *  draw, which is not the same as a backend with no logo. */
export type ProviderMarkId = 'claude' | 'codex' | null

export function providerMark(provider: string | null | undefined): ProviderMarkId {
  // Both spellings are Claude Code: `claude` is what the session emitter has
  // always written, `claude-code` is what the volume query reads back.
  if (provider === 'claude' || provider === 'claude-code') return 'claude'
  if (provider === 'codex') return 'codex'
  return null
}

/** The model's own name from the model profiles — `Opus 5.5`, not
 *  `claude-opus-5-5[1m]` — so a turn names its model the way the picker that
 *  chose it did. A turn recorded before the provider field existed is still
 *  matched by its id. An id no profile knows is shown as recorded. */
export function modelName(
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!model) return null
  const mark = providerMark(provider)
  const agents: AgentId[] =
    mark === 'claude' ? ['claude-code'] : mark === 'codex' ? ['codex'] : ['claude-code', 'codex']
  for (const agent of agents) {
    const label = modelLabelFor(agent, model)
    if (label && label !== model) return label
  }
  return model
}

/** The product's own name, or null when the recorded value names no backend
 *  Solus knows — including when nothing was recorded at all. */
export function providerName(provider: string | null | undefined): string | null {
  const mark = providerMark(provider)
  if (mark === 'claude') return 'Claude Code'
  if (mark === 'codex') return 'Codex'
  return null
}
