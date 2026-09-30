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
