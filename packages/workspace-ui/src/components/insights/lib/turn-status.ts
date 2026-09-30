import {
  CircleDashed as RunningIcon,
  CircleStop as StoppedIcon,
  CircleX as FailedIcon,
} from '@lucide/svelte'

// A turn's state as a shape, not a word or a dot — the glyphs the list pages'
// check chips use, so running and failed read the same across Solus. The rail
// and the turn header draw the same badge.

export interface TurnStatusBadge {
  label: string
  icon: typeof FailedIcon
  color: string
}

/** The badge for a turn root's status, or null for a turn that ended well.
 *  A root with no end yet (`unknown`) is still running. */
export function turnStatusBadge(status: string): TurnStatusBadge | null {
  if (status === 'error') return { label: 'Failed', icon: FailedIcon, color: 'var(--failure)' }
  if (status === 'interrupted') return { label: 'Stopped', icon: StoppedIcon, color: 'var(--warning)' }
  if (status === 'unknown') return { label: 'Running', icon: RunningIcon, color: 'var(--primary)' }
  return null
}
