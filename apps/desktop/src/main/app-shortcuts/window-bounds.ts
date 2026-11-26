import type { AppWindowBounds } from './app-shortcut-records'

/** The part of a window that must be on a display for the person to find it and move it. */
const MIN_VISIBLE = { width: 120, height: 60 }

/**
 * The place an app window opens at: where the person left it, when enough of
 * that is on a display now. A display that is gone, or one with another
 * arrangement, gives null, and the window opens at its default place.
 */
export function restoredWindowBounds(saved: AppWindowBounds | null, workAreas: readonly AppWindowBounds[]): AppWindowBounds | null {
  if (!saved) return null
  const isVisible = workAreas.some((area) => {
    const width = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
    const height = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y)
    return width >= MIN_VISIBLE.width && height >= MIN_VISIBLE.height
  })
  return isVisible ? saved : null
}
