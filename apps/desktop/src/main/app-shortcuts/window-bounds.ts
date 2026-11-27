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

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

/**
 * Where the popover of a menu-bar page opens (Executor's `placePopover`):
 * centred on its item, below it when the item is in the top half of its
 * display (the macOS menu bar, a top panel), above it otherwise (the Windows
 * taskbar), and inside the work area. Linux gives no bounds of a tray icon:
 * the anchor is then the pointer, which was on the item.
 */
export function popoverPosition(
  size: { width: number; height: number },
  anchor: AppWindowBounds | { x: number; y: number; width: 0; height: 0 },
  workArea: AppWindowBounds,
): { x: number; y: number } {
  const isBelow = anchor.y < workArea.y + workArea.height / 2
  return {
    x: clamp(Math.round(anchor.x + anchor.width / 2 - size.width / 2), workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(isBelow ? anchor.y + anchor.height + 4 : anchor.y - size.height - 4, workArea.y, workArea.y + workArea.height - size.height),
  }
}
