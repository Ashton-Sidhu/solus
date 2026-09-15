/** The part of a DOM node the selection guard reads. */
interface SelectionHost {
  ownerDocument: { getSelection(): Selection | null } | null
  contains(other: Node | null): boolean
}

/**
 * Whether a click is the tail of a real text selection inside `el`.
 *
 * A transcript row that both toggles on click and shows selectable text has to
 * tell the two gestures apart: releasing a drag-select fires `click`, so
 * without this the row collapses the moment the user finishes highlighting the
 * thing they wanted to copy. Containment is checked because a selection
 * somewhere else on the page is not this row's business.
 */
export function clickEndsTextSelection(el: SelectionHost): boolean {
  const selection = el.ownerDocument?.getSelection()
  if (!selection || selection.isCollapsed) return false
  return el.contains(selection.anchorNode) || el.contains(selection.focusNode)
}
