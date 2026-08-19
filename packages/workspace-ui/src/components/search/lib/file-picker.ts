/**
 * The finder ranks results but does not report *why* a path matched, so the
 * highlight is recomputed here. It is display-only: ranking stays with the
 * native index, and a query this cannot align simply renders unhighlighted.
 */

/** Split a path into the file name and the directory prefix before it. */
export function splitFilePath(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf('/')
  return separator === -1
    ? { name: path, directory: '' }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator + 1) }
}

/**
 * Character positions in `text` matching `query`, or `null` when it does not
 * match at all.
 *
 * A contiguous run is tried first and the *last* one wins: typing "test" in
 * `tests/unit/test.ts` means the file, not the folder the eye already skipped,
 * and scattering those four characters across the path reads as a broken
 * result rather than a good one. Only a query that is not a substring falls
 * back to subsequence matching, which is also walked right-to-left so it
 * settles on the most specific part of the path.
 */
export function fuzzyIndices(text: string, query: string): number[] | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const haystack = text.toLowerCase()

  const contiguous = haystack.lastIndexOf(needle)
  if (contiguous !== -1) {
    return Array.from({ length: needle.length }, (_, offset) => contiguous + offset)
  }

  const indices: number[] = []
  let cursor = text.length - 1
  for (let position = needle.length - 1; position >= 0; position -= 1) {
    const character = needle[position]
    while (cursor >= 0 && haystack[cursor] !== character) cursor -= 1
    if (cursor < 0) return null
    indices.push(cursor)
    cursor -= 1
  }
  return indices.reverse()
}

export interface PathSegment {
  text: string
  isMatch: boolean
}

/** Split `text` into alternating plain and matched runs at `indices`. */
export function highlightSegments(text: string, indices: readonly number[] | null): PathSegment[] {
  if (!indices || indices.length === 0) return [{ text, isMatch: false }]

  const marked = new Set(indices)
  const segments: PathSegment[] = []
  let start = 0
  let previousWasMatch = marked.has(0)
  for (let index = 1; index <= text.length; index += 1) {
    const isMatch = index < text.length && marked.has(index)
    if (isMatch === previousWasMatch && index < text.length) continue
    segments.push({ text: text.slice(start, index), isMatch: previousWasMatch })
    start = index
    previousWasMatch = isMatch
  }
  return segments
}
