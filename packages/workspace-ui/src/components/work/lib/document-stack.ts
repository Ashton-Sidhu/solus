/**
 * Two or more works written in one turn render as one card: a fanned stack of
 * page thumbnails on the left, the titles as an index on the right. This module
 * owns the two pieces of arithmetic that card needs — where each sheet sits in
 * the fan, and what marks are drawn on it — so the component stays markup.
 *
 * The fan never re-lays out. Selection only changes a sheet's transform and its
 * shadow, so moving the selection reflows nothing.
 */

/** Sheets past this are not drawn; the index still lists every title. */
export const MAX_SHEETS = 5

import type { WorkType } from '@solus/contracts/types'

/** One work in the stack, as the transcript knows it. */
export type DocumentStackEntry = {
  workId: string
  title: string
  workType?: WorkType
  /** Plain-text head of the work; drives the thumbnail's bars. */
  preview?: string
  updatedAt?: string
  streaming: boolean
}

type FanMetrics = {
  /** Sheet box, in pixels. */
  width: number
  height: number
  /** Per-sheet offset from the one below it. */
  stepX: number
  stepY: number
  /** Total rotation across the fan, split evenly around 0°. */
  spread: number
}

/** Four or more sheets need the width back, so the paper shrinks rather than the
 *  fan tightening — a tighter fan stops reading as several documents. */
const THREE_OR_FEWER: FanMetrics = { width: 118, height: 138, stepX: 12, stepY: 6, spread: 12 }
const FOUR_OR_MORE: FanMetrics = { width: 106, height: 130, stepX: 10, stepY: 5, spread: 16 }

export function fanMetrics(count: number): FanMetrics {
  return count <= 3 ? THREE_OR_FEWER : FOUR_OR_MORE
}

export type FanBox = {
  width: number
  height: number
}

/** The box the fan is absolutely positioned in. Fixed for the life of the card:
 *  it is sized from the final count, so the card never grows as writes land. */
export function fanBox(count: number): FanBox {
  const metrics = fanMetrics(count)
  const sheets = Math.min(count, MAX_SHEETS)
  return {
    width: metrics.width + metrics.stepX * (sheets - 1),
    height: metrics.height + metrics.stepY * (sheets - 1) + 12,
  }
}

export type SheetPlacement = {
  left: number
  top: number
  width: number
  height: number
  rotation: number
  zIndex: number
  selected: boolean
}

export function sheetPlacement(index: number, count: number, selectedIndex: number): SheetPlacement {
  const metrics = fanMetrics(count)
  const sheets = Math.min(count, MAX_SHEETS)
  const rotation =
    sheets === 1 ? 0 : -metrics.spread / 2 + (metrics.spread / (sheets - 1)) * index
  const selected = index === selectedIndex
  return {
    left: index * metrics.stepX,
    top: index * metrics.stepY,
    width: metrics.width,
    height: metrics.height,
    rotation,
    // The selected sheet leaves the dispatch order and comes to the front;
    // every other sheet keeps the z it was dealt.
    zIndex: selected ? MAX_SHEETS + 1 : index,
    selected,
  }
}

/** A mark on a thumbnail. Below 6px glyphs stop being legible as type, so the
 *  first page is drawn as bars: one heading rung and one body rung. */
export type SheetMark = { heading: boolean; width: number }

const HEADING_RE = /^\s{0,3}#{1,6}\s+/

/**
 * The work's own first page, not an icon and not a file-type glyph. `preview`
 * is the plain-text head the works store already keeps, so this needs no
 * markdown pass — a leading `#` is the only thing it reads.
 *
 * Bar widths track the real line lengths (clamped to a legible band) so two
 * documents never draw the same page.
 */
export function sheetMarks(preview: string | undefined, limit = 7): SheetMark[] {
  if (!preview) return []
  const marks: SheetMark[] = []
  for (const raw of preview.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = HEADING_RE.test(line)
    const text = heading ? line.replace(HEADING_RE, '') : line
    const span = Math.min(1, text.length / 42)
    marks.push({ heading, width: Math.round((heading ? 44 + span * 30 : 56 + span * 38) * 10) / 10 })
    if (marks.length === limit) break
  }
  return marks
}

/** "3 documents", "2 slides", "5 files" — a mixed write is files, because the
 *  head states what is in the stack and cannot state two types. */
export function stackKicker(types: Array<WorkType | undefined>): string {
  const distinct = new Set(types.map((type) => type ?? 'doc'))
  if (distinct.size > 1) return 'files'
  const [only] = distinct
  if (only === 'slides') return 'decks'
  if (only === 'diagram') return 'diagrams'
  if (only === 'artifact') return 'artifacts'
  return 'documents'
}
