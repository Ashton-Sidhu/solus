/**
 * When the outline shows its labels.
 *
 * The rail is the resting state of a real table of contents. It renders in
 * full while the document is at the top, on hover, and while a jump is in
 * flight; two seconds after a transient hold ends, the labels dissolve and
 * each row keeps only its measure bar, so the left gutter stops competing
 * with the prose.
 */
export const OUTLINE_DWELL_MS = 2000

export type OutlineReason = 'top' | 'hover' | 'focus' | 'jump' | 'pinned'

/**
 * Reasons that hold the outline open. A set rather than a boolean because
 * several can be true at once — the reader can pin it *and* hover it, and
 * releasing one must not close it while another still holds.
 */
export function isOutlineOpen(reasons: Set<OutlineReason>): boolean {
  return reasons.size > 0
}

/** Reasons that keep it open with no dwell timer — they end explicitly. */
const STICKY: OutlineReason[] = ['top', 'pinned', 'focus']

export function isSticky(reason: OutlineReason): boolean {
  return STICKY.includes(reason)
}

export function holdsWithoutDwell(reasons: Set<OutlineReason>): boolean {
  return STICKY.some((reason) => reasons.has(reason))
}

/** What survives the dwell: everything transient goes, the sticky holds stay. */
export function afterDwell(reasons: Set<OutlineReason>): Set<OutlineReason> {
  return new Set([...reasons].filter(isSticky))
}

/**
 * `⌥1`…`⌥9` jump to the nth section. Returns the index, or null when the key
 * is not a section digit or there is no section there — so a document with
 * three headings never swallows ⌥7.
 */
export function sectionJumpIndex(code: string, sectionCount: number): number | null {
  const match = /^Digit([1-9])$/.exec(code)
  if (!match) return null
  const index = Number(match[1]) - 1
  return index < sectionCount ? index : null
}
