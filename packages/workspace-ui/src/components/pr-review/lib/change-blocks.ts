/**
 * The change cell of the pull request meta band states `+22 −2` and then draws
 * the same ratio as a short row of squares, so the size *and* the shape of a
 * change read at a glance without a full-width bar competing with the title.
 *
 * The row is deliberately coarse: it answers "mostly additions?" and nothing
 * finer. Both sides keep at least one square whenever they are non-zero — a
 * two-line deletion inside a large change is still a deletion, and rounding it
 * away is the one reading this row must not produce.
 */
export type ChangeBlock = 'added' | 'removed'

export function changeBlocks(
  additions: number,
  deletions: number,
  count = 5,
): ChangeBlock[] {
  const adds = Math.max(0, additions)
  const dels = Math.max(0, deletions)
  const total = adds + dels
  if (total === 0 || count <= 0) return []
  if (dels === 0) return Array<ChangeBlock>(count).fill('added')
  if (adds === 0) return Array<ChangeBlock>(count).fill('removed')

  // One square is reserved for each side before the rest is shared out, so
  // neither side can round to nothing.
  const addBlocks = Math.min(
    count - 1,
    Math.max(1, Math.round((adds / total) * count)),
  )
  return [
    ...Array<ChangeBlock>(addBlocks).fill('added'),
    ...Array<ChangeBlock>(count - addBlocks).fill('removed'),
  ]
}
