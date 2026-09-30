import { userColorIndex, type User } from '@solus/contracts/user'
import type { WorkLiveDoc } from '../../../contexts/works/work-live-doc.svelte'

/**
 * What an editor needs to edit a work live: the shared doc and awareness, and
 * how the reader's caret is named and coloured for everyone else.
 */
export interface LiveEditorBinding {
  live: WorkLiveDoc
  user: { name: string; color: string }
}

/**
 * The presence palette (`presenceTint`, `oklch(0.66 0.15 hue)`) in sRGB hex:
 * the caret extension takes only `#rrggbb`, and so does the diagram outline check.
 */
const CARET_COLORS = ['#df6862', '#cb7f00', '#879f18', '#00ae7b', '#00abbd', '#3e96ea', '#9a7de3', '#cd6aaf'] as const

/** The reader as their caret shows to others: their name, in their presence colour. */
export function liveCaretUser(user: User | null): LiveEditorBinding['user'] {
  if (!user) return { name: 'Someone', color: CARET_COLORS[0] }
  return { name: user.displayName, color: CARET_COLORS[userColorIndex(user) % CARET_COLORS.length]! }
}
