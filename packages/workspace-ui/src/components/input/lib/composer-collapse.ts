/**
 * The idle composer.
 *
 * With the keyboard elsewhere the input bar tucks its toolbar row away and
 * drops to a single line, so the transcript gets the room back. Two things
 * decide that here: whether the bar should collapse at all given what it is
 * doing, and whether the keyboard has really left it once a leave settles.
 */

export interface ComposerCollapseState {
  /** The user's setting, already gated on the surface it applies to. */
  enabled: boolean
  /** The keyboard is in the bar, or in a menu the bar opened, or left it less
   *  than a grace ago. */
  focused: boolean
  /** The mic is live. The waveform replaces the text well, and its cancel and
   *  confirm controls must stay exactly where the hand left them. */
  recording: boolean
}

export function shouldCollapseComposer(state: ComposerCollapseState): boolean {
  return state.enabled && !state.focused && !state.recording
}

/**
 * How long the keyboard must be elsewhere before the bar folds.
 *
 * A leave is never decided from the focusout that starts it, because most
 * leaves are not leaves: a closing picker blurs its content a frame before it
 * hands focus back, a sidebar row takes focus on mousedown and gives it back
 * two frames after the click, and a settled recorder hands the keyboard back
 * a frame or two after the mic lets go. Each of those used to be predicted
 * with a hold of its own, and every hold that was not released on time left
 * the bar stuck open or folding under a hand-back. Now nothing is predicted:
 * the bar reads where the keyboard is once the grace is up, and any return
 * inside it is not a leave at all.
 *
 * Long enough for a refocus that waits three frames on a slow one; short
 * enough that a click on the transcript still folds the bar before the eye
 * has settled there. The pointer's release restarts it, so the clock runs
 * from the end of a click, not its start.
 */
export const COMPOSER_FOLD_GRACE_MS = 150

/**
 * The portalled surfaces a bar's own controls open: bits-ui floating content
 * (the model chip, the permission picker, the saved-prompts sheet) and any
 * dialog. Focus moving into one of these is the bar still being used — its
 * trigger has to stay on screen for the menu to anchor to and return to.
 */
export const FLOATING_LAYER_SELECTOR =
  '[data-bits-floating-content-wrapper], [role="dialog"]'

export function floatingLayerOf(node: Node): Element | null {
  // SAFETY: nodeType 1 is ELEMENT_NODE, so the node is an Element; any other
  // node (a text node the caret sits in) is answered by its parent element.
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  return element?.closest(FLOATING_LAYER_SELECTOR) ?? null
}

/**
 * Whether the keyboard, read where it actually is, still belongs to the bar.
 * Answered once a leave has settled rather than from a focusout's
 * `relatedTarget`, which a browser that does not focus a clicked button
 * (Safari) reports as nowhere, and which says nothing about focus handed
 * back a frame later.
 */
export function keyboardHoldsComposerOpen(args: {
  root: Element
  activeElement: Element | null
  documentHasFocus: boolean
}): boolean {
  // Nowhere: the window itself lost focus. The bar keeps its shape so
  // restoring the app does not paint one collapsed frame before Chromium
  // hands focus back to the editor.
  if (!args.documentHasFocus) return true
  const active = args.activeElement
  if (!active) return false
  return args.root.contains(active) || floatingLayerOf(active) !== null
}

/**
 * A live text selection in the transcript holds the bar open. A drag-select
 * blurs the editor, and folding mid-gesture would move the page under a
 * selection the user is still making.
 */
export function selectionHoldsComposerOpen(
  selection: Pick<Selection, 'isCollapsed' | 'rangeCount' | 'getRangeAt'> | null,
  transcript: Node | null,
): boolean {
  if (!transcript || !selection || selection.isCollapsed || selection.rangeCount === 0) return false
  return transcript.contains(selection.getRangeAt(0).commonAncestorContainer)
}
