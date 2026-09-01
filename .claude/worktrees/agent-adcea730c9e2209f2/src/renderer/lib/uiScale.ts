/**
 * Fluid root font-size scaling — drives proportional UI sizing via rem units.
 *
 * All UI dimensions are in rem, so changing the root font-size on <html> scales
 * the entire interface proportionally. This replaces the old `zoom`-based approach
 * with the standard rem pattern used by Material, Ant, Radix, etc.
 *
 * Driven by the physical screen width (window.screen.width), so resizing the
 * app window does NOT rescale the UI — only the monitor's resolution does.
 *
 * Scaling curve:
 * - 16px root everywhere ≥ 1920px (design reference, same on desktop & ultrawide)
 * - 1800px laptop benchmark: 17px root, two pixels larger than the old 15px
 * - Below 1800px: scales down linearly, floor at 15px (~1560px and below)
 * - 1800–1920px: eases back to the 16px desktop reference
 *
 * At common screen widths:
 *   1440px (laptop)    → 15px
 *   1512px (MacBook)   → 15px
 *   1680px (mid)       → 16px
 *   1800px (benchmark) → 17px
 *   1920px (desktop)   → 16px  ← design reference
 *   2560px (ultrawide) → 16px
 *
 * Composes with `--solus-font-scale` (user's text-size preference). Content text
 * uses `calc(Nrem * var(--solus-font-scale, 1))` so it scales with both the
 * screen AND the user setting.
 */

const ROOT_SCALE_DIVISOR = 120
const LAPTOP_WIDTH_MAX = 1800
const DESKTOP_WIDTH_MIN = 1920
const ROOT_FONT_MIN = 15
const ROOT_FONT_DESKTOP = 16
const ROOT_FONT_LAPTOP_MAX = 17

export function computeRootFontSize(width: number): number {
  if (width <= LAPTOP_WIDTH_MAX) {
    const raw = width / ROOT_SCALE_DIVISOR + 2
    return Number(Math.min(ROOT_FONT_LAPTOP_MAX, Math.max(ROOT_FONT_MIN, raw)).toFixed(2))
  }

  if (width < DESKTOP_WIDTH_MIN) {
    const progress = (width - LAPTOP_WIDTH_MAX) / (DESKTOP_WIDTH_MIN - LAPTOP_WIDTH_MAX)
    const size = ROOT_FONT_LAPTOP_MAX - progress * (ROOT_FONT_LAPTOP_MAX - ROOT_FONT_DESKTOP)
    return Number(size.toFixed(2))
  }

  return ROOT_FONT_DESKTOP
}

/**
 * Initialise fluid root scaling on the document. Call once at app startup.
 */
export function initRootScaling(): () => void {
  let raf = 0
  let currentSize = -1

  const update = () => {
    raf = 0
    // Scale off the physical screen width, NOT window.innerWidth — the UI must
    // stay a fixed size as the user resizes the app window. Only moving to a
    // different-resolution monitor should change it.
    const size = computeRootFontSize(window.screen.width)
    // The size is clamped and rounded, so most screen-width values
    // produce the same result. Skip the DOM write — mutating the root font-size
    // reflows the entire rem-sized UI.
    if (size === currentSize) return
    currentSize = size
    document.documentElement.style.fontSize = `${size}px`
  }

  // Resize fires when the window moves to another monitor; recompute then in
  // case the new screen has a different resolution. Coalesce into one frame.
  const onResize = () => {
    if (!raf) raf = requestAnimationFrame(update)
  }

  window.addEventListener('resize', onResize)
  update()

  return () => {
    window.removeEventListener('resize', onResize)
    if (raf) cancelAnimationFrame(raf)
  }
}
