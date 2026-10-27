const DEFAULT_TAIL = 10
const MAX_SEGMENT_TAIL = 16
const MIN_WORD_TAIL = 4
const WORD_BREAK = /[-_./\\]/

/**
 * Where `MiddleTruncate` cuts a string. The head may shrink behind an ellipsis;
 * the tail always shows. A path keeps its last segment when that segment is
 * short enough to be the useful part; anything else keeps a fixed count, moved
 * to the start of a word. Nothing is split when the tail would be most of the
 * string, since the head could then never show enough to be worth an ellipsis.
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
    // A Windows host path separates with `\` as well as `/`.
    const slash = Math.max(chars.lastIndexOf('/'), chars.lastIndexOf('\\'))
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null
  let cut = chars.length - keep
  // An automatic tail starts on a word: `…machine`, not `…er-machine`. A shorter
  // tail comes first so the head keeps its room; a longer one is the fallback.
  if (tail === undefined && !WORD_BREAK.test(chars[cut - 1])) {
    const startsWord = (index: number) => WORD_BREAK.test(chars[index - 1])
    let snapped = -1
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) {
        snapped = index
        break
      }
    }
    for (let index = cut - 1; snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4; index--) {
      if (startsWord(index)) snapped = index
    }
    if (snapped > 0) cut = snapped
  }
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') }
}
