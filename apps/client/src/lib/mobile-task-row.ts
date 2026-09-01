/**
 * The colours a mobile row draws state in, and the words it says out loud.
 *
 * A phone reads the same glyph vocabulary as the desktop sidebar: one
 * silhouette per state, in its reserved colour, rather than a second name for
 * the same thing on a second line. The word survives as the row's accessible
 * label, which is where a state that is drawn rather than printed has to be
 * stated. Same states, same source (`SidebarTask`) — only the rendering
 * differs, so nothing here may invent a lifecycle the sidebar does not have.
 */
import { taskStatusFor, type SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import type { AttentionState } from '@solus/workspace-ui/lib/sessionUtils'

/** Which reserved colour the state glyph and its tile take. */
export type MobileStateTone = 'running' | 'failure' | 'warning' | 'success' | 'unread' | 'muted'

/**
 * Every silhouette a mobile row can draw. One per state the sidebar can be in,
 * so no two states share a mark: `limit` owns the clock, which is why `idle`
 * and `unread` spend discs instead of borrowing it.
 */
export type MobileStateGlyph =
  | 'running'
  | 'question'
  | 'plan'
  | 'failure'
  | 'limit'
  | 'snoozed'
  | 'completed'
  | 'unread'
  | 'idle'

export interface MobileTaskState {
  glyph: MobileStateGlyph
  /** What that glyph means, in words, for the accessible name. Empty when the
   *  row has nothing to report. */
  label: string
  tone: MobileStateTone
}

/** Ink for a state stated in text. Mixed toward `--foreground` so it stays
 *  readable at 11px in both themes rather than glowing at full chroma. */
export const MOBILE_STATE_INK = {
  running: 'color-mix(in oklch, var(--running) 72%, var(--foreground))',
  failure: 'color-mix(in oklch, var(--failure) 62%, var(--foreground))',
  warning: 'color-mix(in oklch, var(--warning) 58%, var(--foreground))',
  success: 'color-mix(in oklch, var(--success) 58%, var(--foreground))',
  unread: 'var(--solus-status-unread)',
  muted: 'var(--muted-foreground)',
} satisfies Record<MobileStateTone, string>

/** Fill behind the 28px leading glyph tile. */
export const MOBILE_STATE_TILE_BG = {
  running: 'color-mix(in oklch, var(--running) 20%, transparent)',
  failure: 'color-mix(in oklch, var(--failure) 18%, transparent)',
  warning: 'color-mix(in oklch, var(--warning) 16%, transparent)',
  success: 'color-mix(in oklch, var(--success) 18%, transparent)',
  unread: 'color-mix(in oklch, var(--solus-status-unread) 18%, transparent)',
  muted: 'var(--wash-3)',
} satisfies Record<MobileStateTone, string>

/** Glyph colour inside that tile — one step stronger than the fill. */
export const MOBILE_STATE_TILE_INK = {
  running: 'color-mix(in oklch, var(--running) 62%, var(--foreground))',
  failure: 'color-mix(in oklch, var(--failure) 60%, var(--foreground))',
  warning: 'color-mix(in oklch, var(--warning) 55%, var(--foreground))',
  success: 'color-mix(in oklch, var(--success) 52%, var(--foreground))',
  // Unread is the one mark the sidebar keeps at full colour on a row that has
  // otherwise stepped back, so it is not mixed toward the foreground here either.
  unread: 'var(--solus-status-unread)',
  muted: 'var(--muted-foreground)',
} satisfies Record<MobileStateTone, string>

/**
 * Lifecycle decides the state before status does: a task the user snoozed or
 * completed reads that way even though the session under it may have ended in
 * any state. Only an active task reports what its newest run is doing.
 *
 * Unread comes last, on the sidebar's own rule (`showsUnreadIndicator`): a
 * state that wants a person keeps its more specific mark, and unread only
 * speaks for a row that has finished and has nothing else to say.
 */
export function mobileTaskState(
  row: Pick<SidebarTask, 'lifecycle' | 'status'> & { unread?: boolean },
): MobileTaskState {
  if (row.lifecycle === 'snoozed') return { glyph: 'snoozed', label: 'snoozed', tone: 'warning' }
  if (row.lifecycle === 'completed') {
    return { glyph: 'completed', label: 'completed', tone: 'success' }
  }
  switch (row.status) {
    case 'running':
      return { glyph: 'running', label: 'running', tone: 'running' }
    case 'error':
      return { glyph: 'failure', label: 'failed', tone: 'failure' }
    case 'question':
      return { glyph: 'question', label: 'needs an answer', tone: 'running' }
    case 'plan':
      return { glyph: 'plan', label: 'plan to review', tone: 'running' }
    case 'limit':
      return { glyph: 'limit', label: 'rate limited', tone: 'warning' }
    case 'done':
      // The user's own tick. It says the same thing as a completed lifecycle,
      // so it says it with the same mark rather than a second one.
      return { glyph: 'completed', label: 'completed', tone: 'success' }
    default:
      return row.unread
        ? { glyph: 'unread', label: 'finished, unread', tone: 'unread' }
        : { glyph: 'idle', label: '', tone: 'muted' }
  }
}

/**
 * The trailing timestamp. Within the current day the time is the useful fact;
 * beyond it the date is, and the year only once it stops being this one — a row
 * that reads "Aug 16" is unambiguous until next August.
 */
export function mobileRowTimestamp(activityAt: number, now: number): string {
  if (!activityAt) return ''
  const then = new Date(activityAt)
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
      .format(then)
  }
  // The year only once it stops being this one, so an ordinary row stays two
  // tokens wide.
  const format: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (then.getFullYear() !== today.getFullYear()) format.year = 'numeric'
  return new Intl.DateTimeFormat(undefined, format).format(then)
}

/** When a snoozed row comes back, in the words the row prints after "snoozed". */
export function mobileSnoozeWake(snoozedUntil: number, now: number): string {
  if (!snoozedUntil) return ''
  const wake = new Date(snoozedUntil)
  const today = new Date(now)
  const tomorrow = new Date(now + 86_400_000)
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(wake)
  if (wake.toDateString() === today.toDateString()) return `wakes ${time}`
  if (wake.toDateString() === tomorrow.toDateString()) return `wakes tomorrow ${time}`
  return `wakes ${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(wake)} ${time}`
}

/** "3 sessions" / "" — the run count only earns its place past one. */
export function mobileSessionCount(count: number): string {
  return count > 1 ? `${count} sessions` : ''
}

/** The same state for one run rather than a whole task: a session has no
 *  lifecycle of its own, only the state of the turn it is in — which is what
 *  `attention` already reports, unread included. */
export function mobileSessionState(attention: AttentionState): MobileTaskState {
  return mobileTaskState({
    lifecycle: 'active',
    status: taskStatusFor(attention),
    unread: attention === 'unread',
  })
}
