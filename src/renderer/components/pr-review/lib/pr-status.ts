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
 * Pull requests use the conventional Git host palette: open is green, merged
 * is purple, and closed is red. A review request remains purple because it is
 * an attention state rather than a PR lifecycle state. Draft stays neutral.
 */
const TONES = {
  review: 'var(--review)',
  open: 'var(--success)',
  draft: null,
  merged: 'var(--review)',
  closed: 'var(--failure)',
} satisfies Record<PrStatusKey, string | null>

function isPrStatusKey(key: string): key is PrStatusKey {
  return key in TONES
}

export interface PrStatusPillColors {
  background: string
  color: string
}

export function statusDotColor(key: string): string {
  const tone = isPrStatusKey(key) ? TONES[key] : undefined
  if (tone === undefined || tone === null) return 'var(--idle)'
  return `color-mix(in oklch, ${tone} 78%, transparent)`
}

/** The chip in a pull request's subtitle — same table, filled rather than a speck. */
export function statusPillColors(key: string): PrStatusPillColors {
  const tone = isPrStatusKey(key) ? TONES[key] : undefined
  if (tone === undefined || tone === null) {
    return { background: 'var(--wash-3)', color: 'var(--muted-foreground)' }
  }
  return {
    background: `color-mix(in oklch, ${tone} 14%, transparent)`,
    color: `color-mix(in oklch, ${tone} 58%, var(--foreground))`,
  }
}

const LABELS = {
  review: 'Awaiting your review',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
} satisfies Record<PrStatusKey, string>

export function statusLabel(key: string): string {
  return isPrStatusKey(key) ? LABELS[key] : 'Open'
}
