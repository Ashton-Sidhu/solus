/**
 * What the labelled outline lists.
 *
 * A twelve-heading document is a list you read. A hundred-heading document is
 * a list you search — so past `OUTLINE_LONG_MIN` the panel gains a field, and
 * the rows become whatever that field leaves. Nothing else about the outline
 * changes with length: no folding, no second navigation model to learn.
 */
import type { PlanHeading } from "../headings"

/** Where scanning stops being the fast way in. */
export const OUTLINE_LONG_MIN = 16

export interface OutlineRow {
  heading: PlanHeading
  /** Index into the full heading list — the section numeral keys on it. */
  index: number
  /**
   * A top-level section, which pins to the top of the list while its own
   * sub-headings scroll under it. Never while filtering: a set of matches is
   * flat, and pinning one of them above the rest would only claim they belong
   * to it.
   */
  isSection: boolean
}

export function outlineRows(headings: PlanHeading[], query: string): OutlineRow[] {
  const needle = query.trim().toLowerCase()
  // The section level is the shallowest the document uses, so a document
  // written entirely in h3 still has sections to pin.
  const topLevel = headings.length > 0 ? Math.min(...headings.map((h) => h.level)) : 0
  return headings.flatMap((heading, index) =>
    needle && !heading.text.toLowerCase().includes(needle)
      ? []
      : [{ heading, index, isSection: !needle && heading.level === topLevel }],
  )
}
