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

/**
 * Whether the labelled panel should render this frame. `atTop` is checked
 * directly because the reason set synchronizes from props in an effect; without
 * this guard, a split pane briefly paints the initial `top` hold before that
 * effect removes it. Other reasons still reveal the outline on demand.
 */
export function isOutlineVisible(
  reasons: Set<OutlineReason>,
  atTop: boolean,
): boolean {
  if (reasons.size === 1 && reasons.has('top') && !atTop) return false
  return isOutlineOpen(reasons)
}

/**
 * The at-top reveal is a margin note: the panel unfolds over the gutter beside
 * the prose, never over the prose itself. It is anchored to the rail's left
 * edge and overhangs the rail, so it only stays clear of the text while the
 * shell leaves that much slack beside the centered page.
 *
 * The geometry, in rem, comes from DocumentShell and DocumentOutline:
 *
 *   rail sleeve   5.5  (`basis-22`) plus 0.75 (`ml-3`)
 *   page block    min(column, measure + 7), measure = clamp(66ch, 68cqi, 112ch)
 *   text gutter   3.5  (half of the page block's 7rem of side gutters)
 *   panel         16.375, or 14.5 on a laptop display
 *
 * Room left of the prose is rail + (column − page) / 2 + gutter, which is
 * 0.16 × shell + 2.375rem while the 68cqi step of the measure binds. Narrower
 * steps give less (the page fills the column) and the 112ch step gives more, so
 * the cqi step is the safe bound — and it needs no `ch`, which is font-relative
 * and cannot be resolved here. Solving it for the panel width gives 88rem.
 *
 * A laptop display holds a narrower measure (58cqi, index.css) precisely so the
 * margin can carry the outline, so the same solution there gives 62rem — where
 * the measure's 66ch floor takes over and the margin stops growing.
 *
 * Below that the reveal would land on the first lines of the document, so it
 * waits for a hover, a pin, or a keyboard jump instead.
 */
const OUTLINE_ROOM_MIN_PX = { standard: 1408, laptop: 992 }

export function hasOutlineMarginRoom(shellWidth: number, isLaptopDisplay: boolean): boolean {
  const min = isLaptopDisplay ? OUTLINE_ROOM_MIN_PX.laptop : OUTLINE_ROOM_MIN_PX.standard
  return shellWidth >= min
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
