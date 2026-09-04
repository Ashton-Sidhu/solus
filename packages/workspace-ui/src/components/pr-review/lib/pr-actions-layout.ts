/**
 * The two homes the pull request's action cluster has, and the geometry each
 * one asks for.
 *
 * Beside the conversation the actions sit inside the rail's status card: a
 * stacked column of full-width controls under the readiness sentence. Once the
 * rail has no column and folds into the reading column, that card is drawn as
 * a single row, and the same controls sit beside the readiness text at
 * content width.
 *
 * The distinction has to travel down to the controls themselves. A card
 * control is `w-full` and 34px tall so the stack reads as one block; a row
 * control is content-width and 32px. A parent cannot override either from the
 * outside, which is how the row once ended up rendering a full-width column
 * with the card's top margin still on it.
 */
export type PrActionsLayout = 'card' | 'row'
