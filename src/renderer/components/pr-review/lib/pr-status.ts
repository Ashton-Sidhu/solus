/**
 * The one place a pull request's lifecycle turns into colour.
 *
 * Keyed on the *list's* group keys (see `prs/lib/prs-list-view`) rather than a
 * second vocabulary of its own: the dot beside a row in the crumb switcher has
 * to mean the same thing as the group that row sits under in the list, and one
 * table is how that stays true.
 */
export type PrStatusKey = 'review' | 'open' | 'draft' | 'merged' | 'closed'

const TINTS: Record<PrStatusKey, string | null> = {
  review: 'warning',
  open: 'running',
  // Draft has no state to report yet, so it takes the neutral idle token rather
  // than a mixed tint that would read as a status.
  draft: null,
  merged: 'success',
  closed: 'failure',
}

export function statusDotColor(key: string): string {
  const tint = TINTS[key as PrStatusKey]
  if (tint === undefined || tint === null) return 'var(--idle)'
  return `color-mix(in oklch, var(--${tint}) 78%, transparent)`
}

/** The pill on the detail masthead — same table, filled rather than a speck. */
export function statusPillColors(key: string): { background: string; color: string } {
  const tint = TINTS[key as PrStatusKey]
  if (tint === undefined || tint === null) {
    return { background: 'var(--wash-3)', color: 'var(--muted-foreground)' }
  }
  return {
    background: `color-mix(in oklch, var(--${tint}) 15%, transparent)`,
    color: `color-mix(in oklch, var(--${tint}) 60%, var(--foreground))`,
  }
}

const LABELS: Record<PrStatusKey, string> = {
  review: 'Awaiting your review',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

export function statusLabel(key: string): string {
  return LABELS[key as PrStatusKey] ?? 'Open'
}
