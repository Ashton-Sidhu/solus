/**
 * UI zoom bounds shared by the renderer (steps and persistence) and the main
 * process (clamps the factor it applies to a webContents). The root font-size
 * is a fixed 16px; user-controlled zoom is the one mechanism that scales the
 * whole UI — see docs/adr/0010-fixed-root-font-size-and-user-zoom.md.
 */
export const ZOOM_FACTOR_MIN = 0.5
export const ZOOM_FACTOR_MAX = 2
export const ZOOM_FACTOR_DEFAULT = 1
export const ZOOM_FACTOR_STEP = 0.1

export function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor)) return ZOOM_FACTOR_DEFAULT
  return Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, factor))
}

/** Widest logical screen still treated as laptop-class. 1512 is the 14" MacBook
 *  Pro at its default scaled resolution and 1536 is the common Windows panel at
 *  150% scaling; 1680 and up are desktop monitors and stay at 100%. */
export const LAPTOP_SCREEN_MAX_WIDTH = 1600

/**
 * The zoom a display starts at before the user ever chooses one. Laptop-class
 * screens open one step out, which is the density the deleted fluid root
 * font-size used to give them (ADR-0010). This is a first-run default only —
 * it is persisted once and never recomputed, because Chromium reports
 * `screen.width` in zoomed CSS pixels and re-reading it would fight the user's
 * own zoom.
 */
export function defaultZoomFactorForScreen(screenWidth: number | undefined): number {
  if (screenWidth === undefined || !Number.isFinite(screenWidth) || screenWidth <= 0) {
    return ZOOM_FACTOR_DEFAULT
  }
  if (screenWidth > LAPTOP_SCREEN_MAX_WIDTH) return ZOOM_FACTOR_DEFAULT
  return stepZoomFactor(ZOOM_FACTOR_DEFAULT, -1)
}

/**
 * The display's true logical width, recovered from what the renderer can see.
 * Chromium reports `screen.width` in *zoomed* CSS pixels, so a 1512px laptop
 * reads as 1680 at 90% zoom; multiplying the factor back out gives the number a
 * display threshold can be compared against. Returns 0 when the width is
 * unreadable, which callers must treat as "unknown", not as "narrow".
 */
export function logicalDisplayWidth(screenWidth: number | undefined, zoomFactor: number): number {
  if (screenWidth === undefined || !Number.isFinite(screenWidth) || screenWidth <= 0) return 0
  return screenWidth * clampZoomFactor(zoomFactor)
}

/** One predictable 10% step, kept on a single decimal so repeated steps never
 *  accumulate float drift (1.1 + 0.1 → 1.2000000000000002). */
export function stepZoomFactor(current: number, direction: 1 | -1): number {
  const stepped = Math.round((clampZoomFactor(current) + direction * ZOOM_FACTOR_STEP) * 10) / 10
  return clampZoomFactor(stepped)
}
