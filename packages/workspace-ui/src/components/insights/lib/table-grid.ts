import type { CellFormat } from './result-shape'

// Column widths for the two result grids.
//
// A track sized `1fr` inside a horizontally scrolling grid gives every column
// an equal share of a width nobody chose, so `select *` renders twenty
// identical columns: a status squats in eight characters of empty space while
// a shell command truncates after six. Widths here come from what a column
// holds, so every track starts from what it must hold rather than from a share
// of the row — which is also what keeps the header aligned to its rows.
//
// Natural widths alone are only half the answer: five columns whose natural
// sum is 54rem, laid out in a 120rem card, clump against the left edge and
// leave half the surface blank. So the leftover width is *given away* — to the
// columns that can use it, meaning the prose and paths that were truncating,
// never to a status or a count that would just gain padding. Below the natural
// sum nothing shrinks and the grid scrolls, because a truncated command in a
// 4rem track is not a readable column.
//
// Pure and non-reactive: both grids read these from `$derived`.

export interface GridColumn {
  name: string
  numeric: boolean
  format?: CellFormat
}

/** Columns whose value is prose or a path, and is worth reading in place. */
const WIDE_COLUMNS = new Set([
  'prompt',
  'input',
  'command',
  'file_path',
  'error',
  'project_root',
  'question',
  'sql',
])

/** Default widths in pixels, including the cell's own padding, so a track is
 *  the width the column occupies rather than a number the markup must adjust.
 *  Every one of them is only a default: the reader can resize any column. */
const TRACK = {
  time: 124,
  duration: 96,
  status: 88,
  numeric: 104,
  identifier: 216,
  wide: 360,
  text: 176,
} as const

/** The narrowest a column may be dragged: enough for a header label and its
 *  sort caret, so a column can never be lost by mistake. */
export const MIN_TRACK_PX = 72

export function columnTrack(column: GridColumn): number {
  if (column.format === 'time') return TRACK.time
  if (column.format === 'duration') return TRACK.duration
  if (column.format === 'status') return TRACK.status
  if (WIDE_COLUMNS.has(column.name)) return TRACK.wide
  if (column.numeric) return TRACK.numeric
  if (column.name.endsWith('_id')) return TRACK.identifier
  return TRACK.text
}

/**
 * Which columns can use more room than they were born with.
 *
 * A count, an instant, a duration, or a status is as wide as its widest value
 * and no wider; handing it the leftover width buys empty space beside a number
 * — which is what leaves a table with a truncated prompt beside four columns of
 * blank. Prose, paths, and ids are the columns that were truncating, so they
 * are the ones that grow. Prose leads: where a row has something worth reading
 * in place, it takes the whole remainder rather than sharing it out.
 *
 * The table gives the slack away by setting `width:100%` on every grower, so
 * the answer depends on the whole row, not on one column.
 */
export function columnGrows(column: GridColumn, columns: GridColumn[]): boolean {
  if (columns.some((candidate) => WIDE_COLUMNS.has(candidate.name))) {
    return WIDE_COLUMNS.has(column.name)
  }
  if (column.format === 'time' || column.format === 'duration' || column.format === 'status') {
    return false
  }
  return !column.numeric
}

/**
 * How loudly a column speaks.
 *
 * A grid where every cell is one weight in one colour is a wall of characters:
 * the eye has no column to land on and no column to skip. Emphasis follows what
 * a column is *for* — the prose or path is what the row is about, ids and
 * instants are how it is found again, and measures are what is being compared.
 */
export type ColumnEmphasis = 'primary' | 'measure' | 'secondary'

export function columnEmphasis(column: GridColumn): ColumnEmphasis {
  if (WIDE_COLUMNS.has(column.name)) return 'primary'
  // An instant is stored as an epoch and a status is read as a word, so
  // neither is a measure however numeric its column tests.
  if (column.format === 'time' || column.format === 'status') return 'secondary'
  if (column.format === 'duration' || column.numeric) return 'measure'
  return 'secondary'
}
