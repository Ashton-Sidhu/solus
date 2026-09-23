/**
 * The pull request row's tones: each state at full strength
 * in its own hue, lifted for dark mode rather than mixed toward the text
 * colour. Shared by the list row and its state glyph, so they live here rather
 * than in markup.
 */
import type { ListChecksSpec } from '../../ui/list-page/list-page'
import type { PrStatusKey, PrVerdict } from './prs-list-view'

export const PR_STATUS_TONE = {
  open: 'text-emerald-600 dark:text-emerald-300/90',
  draft: 'text-zinc-500 dark:text-zinc-400/80',
  merged: 'text-violet-600 dark:text-violet-300/90',
  closed: 'text-red-600 dark:text-red-300/90',
} satisfies Record<PrStatusKey, string>

export const PR_CHECKS_TONE = {
  passing: 'text-emerald-600 dark:text-emerald-300/90',
  pending: 'text-amber-600 dark:text-amber-400/90',
  failing: 'text-red-500 dark:text-red-400',
  none: 'text-muted-foreground',
} satisfies Record<ListChecksSpec['state'], string>

export const PR_VERDICT_TONE = {
  approved: 'text-emerald-600 dark:text-emerald-300/90',
  'changes-requested': 'text-amber-600/90 dark:text-amber-400/80',
} satisfies Record<PrVerdict, string>

export const PR_ADDITIONS_TONE = 'text-emerald-600 dark:text-emerald-400'
export const PR_DELETIONS_TONE = 'text-red-500 dark:text-red-400'
