/** Relative presets wake a fixed span from now; the rest wake at a clock time. */
export type TaskSnoozePreset =
  | '15m'
  | '30m'
  | '1h'
  | '3h'
  | '6h'
  | '12h'
  | '24h'
  | 'evening'
  | 'tomorrow'
  | 'week'

const RELATIVE_MINUTES = new Map<TaskSnoozePreset, number>([
  ['15m', 15],
  ['30m', 30],
  ['1h', 60],
  ['3h', 180],
  ['6h', 360],
  ['12h', 720],
  ['24h', 1440],
])

export interface TaskSnoozeChoice {
  preset: TaskSnoozePreset
  label: string
  /** Relative spans read as a clock; clock times read as a moon. The callers
   *  own the icon components so this module stays free of Svelte imports. */
  isRelative: boolean
}

/** The offered wake times, shared by the snooze popover and the context
 *  submenu so both surfaces always list the same choices in the same order:
 *  relative spans first — the common "not now, soon" case — then clock times. */
export const TASK_SNOOZE_CHOICES: TaskSnoozeChoice[] = [
  { preset: '15m', label: '15 minutes', isRelative: true },
  { preset: '30m', label: '30 minutes', isRelative: true },
  { preset: '1h', label: '1 hour', isRelative: true },
  { preset: '3h', label: '3 hours', isRelative: true },
  { preset: '6h', label: '6 hours', isRelative: true },
  { preset: '12h', label: '12 hours', isRelative: true },
  { preset: '24h', label: '24 hours', isRelative: true },
  { preset: 'evening', label: 'This evening', isRelative: false },
  { preset: 'tomorrow', label: 'Tomorrow morning', isRelative: false },
  { preset: 'week', label: 'Next week', isRelative: false },
]

/**
 * What the user is told after a snooze lands.
 *
 * A snooze is an attention control, not an execution control: it moves the row
 * to the Snoozed shelf and nothing else. So when the agent is mid-turn the
 * confirmation has to say so, or the user is left to guess whether their work
 * was paused, abandoned, or is still running. Nothing needs resuming, and that
 * is the part the sentence must carry.
 */
export function taskSnoozeToastLabel(input: {
  count: number
  hasNote: boolean
  /** True when any snoozed task has a turn in flight. */
  keepsRunning: boolean
}): string {
  const subject = input.count === 1 ? 'Task' : `${input.count} tasks`
  const reminder = input.hasNote ? ' with a reminder' : ''
  const agents = input.count === 1 ? 'the agent keeps working' : 'their agents keep working'
  return `${subject} snoozed${reminder}${input.keepsRunning ? ` — ${agents}` : ''}`
}

/** Where the snooze menu hangs from. A row's snooze button gives its element;
 *  the context menu only knows the point the user right-clicked at. */
export type TaskSnoozeAnchor = HTMLElement | { x: number; y: number }

/**
 * Popover anchors accept an element or anything that can measure itself, so a
 * point becomes a zero-size rect at that coordinate.
 *
 * A row's snooze button lives in an action cluster the row only reveals on
 * hover, and the pointer leaves the row on its way to the menu. Measuring the
 * button directly would therefore report an empty rect the moment the user
 * reaches for what they just opened, and floating-ui hides a menu whose anchor
 * has gone. So keep tracking the button while it can be seen, and hold its last
 * known position once it cannot.
 */
export interface TaskSnoozeAnchorTarget { getBoundingClientRect: () => DOMRect }

export function taskSnoozeAnchorTarget(
  anchor: TaskSnoozeAnchor,
): TaskSnoozeAnchorTarget {
  if (!(anchor instanceof HTMLElement)) {
    const { x, y } = anchor
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }
  }
  let lastVisible = anchor.getBoundingClientRect()
  return {
    getBoundingClientRect: () => {
      const rect = anchor.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) lastVisible = rect
      return lastVisible
    },
  }
}

export function taskSnoozeUntil(preset: TaskSnoozePreset, now = new Date()): number {
  const minutes = RELATIVE_MINUTES.get(preset)
  if (minutes) return now.getTime() + minutes * 60 * 1000
  const target = new Date(now)
  if (preset === 'evening') {
    target.setHours(18, 0, 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return target.getTime()
  }
  if (preset === 'tomorrow') {
    target.setDate(target.getDate() + 1)
    target.setHours(9, 0, 0, 0)
    return target.getTime()
  }
  const daysUntilMonday = ((8 - target.getDay()) % 7) || 7
  target.setDate(target.getDate() + daysUntilMonday)
  target.setHours(9, 0, 0, 0)
  return target.getTime()
}
