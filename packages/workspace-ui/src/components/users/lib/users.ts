import { PRESENCE_COLOR_COUNT } from '@solus/contracts/presence'
import type { User } from '@solus/contracts/user'

/**
 * How the client draws one person (plans/012 §6): `UserAvatar` and `UserChip`
 * read these rules, so a face, a name and a colour mean the same person in every
 * stack, row, card and mention.
 */

/** The small form inside cards and dividers: the first word of the name. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName
}

/** The name a chip shows: the first name inside a card or a divider, the full name elsewhere. */
export function chipName(user: User, short: boolean): string {
  return short ? firstName(user.displayName) : user.displayName
}

/**
 * The palette: eight hues at one lightness and chroma, spaced so neighbours are
 * telling-apart distinct, and mixed against the foreground for text so each
 * reads on paper and on ink alike. A person's index is `userColorIndex` of their user.
 */
const PRESENCE_HUES = [25, 70, 120, 165, 205, 250, 295, 340] as const

export interface PresenceTint {
  /** The person's colour itself, for rings and dots. */
  color: string
  /** A wash of it, for an avatar's fill behind initials. */
  fill: string
  /** Initials and names over the wash or the page. */
  ink: string
}

export function presenceTint(colorIndex: number): PresenceTint {
  const hue = PRESENCE_HUES[((colorIndex % PRESENCE_COLOR_COUNT) + PRESENCE_COLOR_COUNT) % PRESENCE_COLOR_COUNT]
  const color = `oklch(0.66 0.15 ${hue})`
  return {
    color,
    fill: `color-mix(in oklch, ${color} 26%, transparent)`,
    ink: `color-mix(in oklch, ${color} 70%, var(--foreground))`,
  }
}
