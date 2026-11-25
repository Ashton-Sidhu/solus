/**
 * The badge of a codebase (docs/plans/codebases.md §9, "Badge"): the mark that
 * the session sidebar, the breadcrumb, and the phone's session list show for a
 * session in the codebase. It is a colour and an icon. The icon is one or two
 * letters, or one emoji. A person can choose each one; a badge with no choice
 * takes the initials of the name on a colour that comes from the name. The
 * badge is part of the codebase record, so it moves to each host with it.
 */

import { z } from 'zod'
import { projectInitials } from './project-badge'

/**
 * The colours of a badge. They are the names of the project icon colours of
 * the phone (T3 Code's `ProjectIconColor`), so each client draws a codebase
 * in the same colour.
 */
export const CODEBASE_COLORS = [
  'gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const
export const codebaseColorSchema = z.enum(CODEBASE_COLORS)
export type CodebaseColor = z.infer<typeof codebaseColorSchema>

const LETTERS = /^[\p{L}\p{N}]{1,2}$/u
// One emoji: a flag, or one pictograph with its variation, skin tone, and
// joined parts. Hermes has no `Intl.Segmenter`, so a pattern decides.
const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)$/u

export const codebaseIconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('letters'), text: z.string().regex(LETTERS) }).strict(),
  z.object({ kind: z.literal('emoji'), emoji: z.string().max(32).regex(ONE_EMOJI) }).strict(),
])
export type CodebaseIcon = z.infer<typeof codebaseIconSchema>

/** What a person chose. An absent field takes its value from the name. */
export const codebaseBadgeSchema = z.object({
  color: codebaseColorSchema.optional(),
  icon: codebaseIconSchema.optional(),
}).strict()
export type CodebaseBadge = z.infer<typeof codebaseBadgeSchema>

/**
 * The icon that a person typed in the badge's one field: one or two letters
 * or digits (in capitals), or one emoji. Empty text is no choice (`null`), so
 * the icon takes the initials of the name. Text that is neither is refused
 * (`'invalid'`).
 */
export function parseCodebaseIcon(typed: string): CodebaseIcon | null | 'invalid' {
  const text = typed.trim()
  if (!text) return null
  if (LETTERS.test(text)) return { kind: 'letters', text: text.toUpperCase() }
  if (ONE_EMOJI.test(text) && text.length <= 32) return { kind: 'emoji', emoji: text }
  return 'invalid'
}

/** The text of the badge's field for an icon: what a person typed, or empty for no choice. */
export function codebaseIconText(icon: CodebaseIcon | undefined): string {
  if (!icon) return ''
  return icon.kind === 'letters' ? icon.text : icon.emoji
}

/** The colour that a codebase with no chosen colour takes: a stable pick from its name, so a codebase keeps it on each client. */
export function codebaseNameColor(name: string): CodebaseColor {
  let hash = 0x811c9dc5
  const seed = name.trim().toLowerCase()
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return CODEBASE_COLORS[(hash >>> 0) % CODEBASE_COLORS.length] ?? 'blue'
}

/** The mark that a client draws for a codebase. */
export interface CodebaseMark {
  color: CodebaseColor
  /** Letters to draw; empty when the name has none and no icon was chosen. */
  letters: string
  /** The emoji to draw in place of the letters. */
  emoji: string | null
}

/** The mark of a codebase: the chosen colour and icon, else the colour and initials of its name. */
export function codebaseMark(codebase: { name: string; badge?: CodebaseBadge }): CodebaseMark {
  const icon = codebase.badge?.icon
  return {
    color: codebase.badge?.color ?? codebaseNameColor(codebase.name),
    letters: icon?.kind === 'letters' ? icon.text : projectInitials(codebase.name),
    emoji: icon?.kind === 'emoji' ? icon.emoji : null,
  }
}

/** The badge with one field changed. A badge with no choice left is absent, so the record has no empty object. */
export function withCodebaseBadge(
  badge: CodebaseBadge | undefined,
  change: { color?: CodebaseColor | null; icon?: CodebaseIcon | null },
): CodebaseBadge | undefined {
  const next: CodebaseBadge = { ...badge }
  if (change.color !== undefined) {
    if (change.color === null) delete next.color
    else next.color = change.color
  }
  if (change.icon !== undefined) {
    if (change.icon === null) delete next.icon
    else next.icon = change.icon
  }
  return next.color || next.icon ? next : undefined
}
