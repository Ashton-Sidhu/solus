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

/** The product's own name, or null when the recorded value names no backend
 *  Solus knows — including when nothing was recorded at all. */
export function providerName(provider: string | null | undefined): string | null {
  const mark = providerMark(provider)
  if (mark === 'claude') return 'Claude Code'
  if (mark === 'codex') return 'Codex'
  return null
}
