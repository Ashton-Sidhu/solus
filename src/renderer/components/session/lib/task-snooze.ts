export type TaskSnoozePreset = 'hour' | 'evening' | 'tomorrow' | 'week'

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
  if (preset === 'hour') return now.getTime() + 60 * 60 * 1000
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
