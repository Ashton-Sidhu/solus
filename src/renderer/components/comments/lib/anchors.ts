import type { Editor } from '@tiptap/core'
import type { PlanComment } from '../../../../shared/types'

export interface MeasuredAnchor {
  id: string
  /** Top of the anchor's first line, in viewport coordinates. */
  anchorTop: number
  /** Bottom of the highlighted run's last line — where a connector leaves. */
  anchorBottom: number
  /** Right edge of that last line: the end of the run, which is the point the
   *  connector is drawn from rather than the rail's own left inset. */
  anchorRight: number
  /** False once the highlight has scrolled out of the reading viewport, which
   *  is when a card starts quoting its anchor instead. */
  visible: boolean
}

/**
 * Measure every comment mark.
 *
 * Coordinates stay in the viewport space `getBoundingClientRect` returns, and
 * the rail converts them against its own box. That way the rail's distance
 * from the text column — its padding, its header, whatever chrome grows above
 * it — never has to be encoded here.
 */
export function measureAnchors(
  scrollContainer: HTMLElement | null,
  comments: PlanComment[],
): MeasuredAnchor[] {
  if (!scrollContainer) return []
  const containerRect = scrollContainer.getBoundingClientRect()
  const measured: MeasuredAnchor[] = []
  for (const comment of comments) {
    const mark = scrollContainer.querySelector(
      `mark[data-plan-comment="${comment.id}"]`,
    ) as HTMLElement | null
    if (!mark) continue
    // A highlight that wraps has several rects; the first is its opening line
    // (where the card wants to sit) and the last is where a connector leaves.
    const rects = mark.getClientRects()
    const first = rects[0] ?? mark.getBoundingClientRect()
    const last = rects[rects.length - 1] ?? first
    measured.push({
      id: comment.id,
      anchorTop: first.top,
      anchorBottom: last.bottom,
      anchorRight: last.right,
      visible: last.bottom > containerRect.top && first.top < containerRect.bottom,
    })
  }
  return measured
}

/**
 * Document position of each comment mark — what the outline needs to say which
 * section a thread belongs to. Read from the doc rather than from the DOM, so
 * it survives a heading being scrolled out of view.
 */
export function commentMarkPositions(editor: Editor | null): { id: string; pos: number }[] {
  const markType = editor?.schema.marks.planComment
  if (!editor || !markType) return []
  const seen = new Set<string>()
  const positions: { id: string; pos: number }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type !== markType) continue
      const id = mark.attrs.commentId as string | null
      if (!id || seen.has(id)) continue
      seen.add(id)
      positions.push({ id, pos })
    }
  })
  return positions
}

/**
 * Bucket threads by the heading they fall under, for the outline's counts.
 * Headings arrive in document order; a thread belongs to the last heading at
 * or above its anchor.
 */
export function countThreadsByHeading(
  anchorPositions: { id: string; pos: number }[],
  headingPositions: number[],
): Map<number, number> {
  const counts = new Map<number, number>()
  const headings = [...headingPositions].sort((a, b) => a - b)
  for (const anchor of anchorPositions) {
    let owner: number | null = null
    for (const pos of headings) {
      if (pos <= anchor.pos) owner = pos
      else break
    }
    if (owner === null) continue
    counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  return counts
}
