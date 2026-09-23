/** The pixel sizes a font-size select offers: every integer from `min` to
 *  `max`, plus the current value when it sits outside that span, so a size
 *  set before the span existed (or typed on another client) still shows as
 *  the selected row instead of an empty trigger. */
export function fontSizeOptions(min: number, max: number, current: number): number[] {
  const sizes: number[] = []
  for (let size = min; size <= max; size += 1) sizes.push(size)
  if (Number.isInteger(current) && (current < min || current > max)) {
    sizes.push(current)
    sizes.sort((a, b) => a - b)
  }
  return sizes
}
