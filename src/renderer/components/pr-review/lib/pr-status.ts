/**
 * The one place a pull request's lifecycle turns into colour.
 *
 * Keyed on the *list's* group keys (see `prs/lib/prs-list-view`) rather than a
 * second vocabulary of its own: the dot beside a row in the crumb switcher has
 * to mean the same thing as the group that row sits under in the list, and one
 * table is how that stays true.
 */
export type PrStatusKey = 'review' | 'open' | 'draft' | 'merged' | 'closed'

/**
 * The same tones the session sidebar's PR chip uses, so one pull request reads
 * identically wherever it surfaces: a review the person owes leads in the brand
 * accent, a merged PR settles into plum, a live open PR shows the on-brand sage.
 * Draft has no state to report yet, so it stays neutral rather than taking a
 * tint that would read as a status.
 */
const TONES: Record<PrStatusKey, string | null> = {
  review: 'var(--primary)',
  open: 'var(--solus-art-positive)',
  draft: null,
  merged: 'var(--solus-art-6)',
  closed: 'var(--failure)',
}

export function statusDotColor(key: string): string {
  const tone = TONES[key as PrStatusKey]
  if (tone === undefined || tone === null) return 'var(--idle)'
  return `color-mix(in oklch, ${tone} 78%, transparent)`
}

/** The chip in a pull request's subtitle — same table, filled rather than a speck. */
export function statusPillColors(key: string): { background: string; color: string } {
  const tone = TONES[key as PrStatusKey]
  if (tone === undefined || tone === null) {
    return { background: 'var(--wash-3)', color: 'var(--muted-foreground)' }
  }
  return {
    background: `color-mix(in oklch, ${tone} 14%, transparent)`,
    color: `color-mix(in oklch, ${tone} 58%, var(--foreground))`,
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
