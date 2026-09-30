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

/** One predictable 10% step, kept on a single decimal so repeated steps never
 *  accumulate float drift (1.1 + 0.1 → 1.2000000000000002). */
export function stepZoomFactor(current: number, direction: 1 | -1): number {
  const stepped = Math.round((clampZoomFactor(current) + direction * ZOOM_FACTOR_STEP) * 10) / 10
  return clampZoomFactor(stepped)
}
