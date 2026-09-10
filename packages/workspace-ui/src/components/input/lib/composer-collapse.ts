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
  /** The keyboard is in the bar, or in a menu the bar opened, or is returning
   *  from a closing menu or recorder. */
  focused: boolean
  /** The mic is live. The waveform replaces the text well, and its cancel and
   *  confirm controls must stay exactly where the hand left them. */
  recording: boolean
}

export function shouldCollapseComposer(state: ComposerCollapseState): boolean {
  return state.enabled && !state.focused && !state.recording
}

/** Allow a closing menu or recorder to return focus on a later frame. */
export const COMPOSER_REFOCUS_GRACE_MS = 150

/**
 * The room the transcript keeps under itself for the docked composer.
 *
 * The dock floats over the conversation, so the transcript's own box never
 * changes size and nothing in it moves when the bar folds. This reservation is
 * what keeps the last message, the orb, the activity strip and the minimap
 * clear of the bar — and it is *held* at the expanded height while the bar
 * rests. A folded measurement may only hold the reservation, never shrink it,
 * so unfolding does not move the transcript either. An expanded measurement is
 * authoritative and may shrink it: that is the bar reporting its true height
 * after a chip or a draft line came or went.
 *
 * A bar that has never been expanded reserves its folded height, and the first
 * expansion moves the transcript once. Guessing an expansion delta instead
 * would be a number no surface agrees on.
 */
export function resolveComposerInset(state: {
  currentInset: number
  dockHeight: number
  collapsed: boolean
}): number {
  return state.collapsed
    ? Math.max(state.currentInset, state.dockHeight)
    : state.dockHeight
}

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
