/**
 * The two homes the pull request's action cluster has, and the geometry each
 * one asks for.
 *
 * On a wide pane the actions sit inside the rail's merge card: a stacked column
 * of full-width controls under the readiness sentence. Below the rail's fold
 * that card becomes `PrMergeBar`, a single row where the same controls sit
 * beside the readiness text and the Details trigger.
 *
 * The distinction has to travel down to the controls themselves. A card control
 * is `w-full` and 34px tall so the stack reads as one block; a bar control is
 * content-width and matches the bar's other rows at 32px. A parent cannot
 * override either from the outside, which is how the bar ended up rendering a
 * full-width column with the card's 13px top margin still on it — the buttons
 * hung below the text they were meant to be level with.
 */
export type PrActionsLayout = 'card' | 'bar'
