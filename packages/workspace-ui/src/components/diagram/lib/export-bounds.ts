export interface ImageBounds { x: number; y: number; width: number; height: number }
/** Convert rendered ink back to canvas coordinates before framing the image. */
export function includeRenderedBounds(base: ImageBounds, ink: ImageBounds[], origin: { x: number; y: number }, zoom: number): ImageBounds {
  let left = base.x, top = base.y, right = base.x + base.width, bottom = base.y + base.height
  for (const rect of ink) {
    left = Math.min(left, (rect.x - origin.x) / zoom)
    top = Math.min(top, (rect.y - origin.y) / zoom)
    right = Math.max(right, (rect.x + rect.width - origin.x) / zoom)
    bottom = Math.max(bottom, (rect.y + rect.height - origin.y) / zoom)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}
