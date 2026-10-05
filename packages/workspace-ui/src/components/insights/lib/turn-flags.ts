import {
  CircleDollarSign as ExpensiveIcon,
  Snail as SlowIcon,
  ThumbsDown as BadAnswerIcon,
  ThumbsUp as GoodIcon,
} from '@lucide/svelte'
import type { TurnFlagKind } from '@solus/contracts/observability-types'
import type { WorkMark } from '@solus/contracts/types'

// How a person's mark on a turn reads and is drawn. The kinds are the
// contract's; the words, the glyph, and the ink are this surface's.

export interface TurnFlagChoice {
  kind: TurnFlagKind
  label: string
  /** What the mark says when it is read back on a list row. */
  short: string
  /** The glyph that names the kind, so a mark reads without its colour. */
  icon: typeof GoodIcon
  /** Each kind has its own ink, so the marks tell apart down a list: the
   *  status green, the failure red, the warning amber, and plum for cost. */
  color: string
}

export const TURN_FLAG_CHOICES: readonly TurnFlagChoice[] = [
  { kind: 'good', label: 'Good example', short: 'good', icon: GoodIcon, color: 'var(--solus-status-complete)' },
  { kind: 'bad_answer', label: 'Bad answer', short: 'bad answer', icon: BadAnswerIcon, color: 'var(--failure)' },
  { kind: 'too_slow', label: 'Too slow', short: 'slow', icon: SlowIcon, color: 'var(--warning)' },
  { kind: 'expensive', label: 'Too expensive', short: 'expensive', icon: ExpensiveIcon, color: 'var(--solus-art-6)' },
]

export function flagChoice(kind: TurnFlagKind): TurnFlagChoice {
  return TURN_FLAG_CHOICES.find((choice) => choice.kind === kind) ?? TURN_FLAG_CHOICES[0]
}

export function flagColor(kind: TurnFlagKind): string {
  return flagChoice(kind).color
}

/** A mark's hover text: the kind, and the person's reason when they gave one. */
export function flagTitle(kind: TurnFlagKind, note: string): string {
  const label = flagChoice(kind).label
  return note ? `${label}: ${note}` : label
}

export interface MarkGroup {
  kind: TurnFlagKind
  count: number
  /** Who marked it so, and why when they said: one person per line. */
  title: string
}

/** Readers' marks on a shared report, one group per kind in the menu's order. */
export function markGroups(marks: readonly WorkMark[]): MarkGroup[] {
  return TURN_FLAG_CHOICES.flatMap((choice) => {
    const same = marks.filter((mark) => mark.kind === choice.kind)
    if (same.length === 0) return []
    const lines = same.map((mark) => (mark.note ? `${mark.by.displayName}: ${mark.note}` : mark.by.displayName))
    return [{ kind: choice.kind, count: same.length, title: `${choice.label}\n${lines.join('\n')}` }]
  })
}
