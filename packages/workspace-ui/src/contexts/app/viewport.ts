import { LAPTOP_SCREEN_MAX_WIDTH, logicalDisplayWidth } from '@solus/contracts/zoom'

// Layout: which shell to render (mobile vs desktop)
export const MOBILE_MAX_WIDTH = 767
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

/**
 * A narrow viewport uses the mobile shell on every device. A phone also keeps
 * that shell when rotation makes its viewport wide: unlike innerWidth, the
 * shorter screen edge identifies the device without changing orientation.
 */
export function isMobileLayout(
  viewportWidth: number | undefined,
  screenWidth: number | undefined,
  screenHeight: number | undefined,
  isTouchDevice: boolean,
): boolean {
  if (typeof viewportWidth === 'number' && viewportWidth <= MOBILE_MAX_WIDTH) return true
  if (!isTouchDevice) return false

  const shorterScreenEdge = Math.min(screenWidth ?? 0, screenHeight ?? 0)
  return shorterScreenEdge > 0 && shorterScreenEdge <= MOBILE_MAX_WIDTH
}

/**
 * Layout: is this a laptop-scale *display*?
 *
 * Keyed on the physical display rather than the window, because zoom changes
 * how many CSS pixels the window reports: the old `(max-width: 1800px)` media
 * query put a 1920px monitor on the laptop branch as soon as the user zoomed to
 * 110%, so one keystroke silently resized the pill. The threshold is shared with
 * the first-run zoom seed (ADR-0010) — one definition of "laptop" for both.
 *
 * On web the browser owns zoom and we cannot read its factor, so a
 * browser-zoomed page reports a display narrower than it is. That is the same
 * blind spot the browser's own scaling has everywhere else in the app.
 */
export function isLaptopDisplay(screenWidth: number | undefined, zoomFactor: number): boolean {
  const displayWidth = logicalDisplayWidth(screenWidth, zoomFactor)
  return displayWidth > 0 && displayWidth <= LAPTOP_SCREEN_MAX_WIDTH
}
