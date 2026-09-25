const DEFAULT_TAIL = 10
const MAX_SEGMENT_TAIL = 16

/**
 * Where `MiddleTruncate` cuts a string. The head may shrink behind an ellipsis;
 * the tail always shows. A path keeps its last segment when that segment is
 * short enough to be the useful part; anything else keeps a fixed count. Nothing
 * is split when the tail would be most of the string, since the head could then
 * never show enough to be worth an ellipsis.
 */
export function splitForMiddleTruncate(
  value: string,
  tail?: number,
): { head: string; tail: string } | null {
  // Code points, not UTF-16 units: a cut inside a surrogate pair renders two
  // broken glyphs where an emoji or a CJK extension character used to be.
  const chars = Array.from(value)
  let keep = tail ?? DEFAULT_TAIL
  if (tail === undefined) {
    const slash = chars.lastIndexOf('/')
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null
  const cut = chars.length - keep
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') }
}
