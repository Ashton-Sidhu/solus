/**
 * The idle composer.
 *
 * With the keyboard elsewhere the input bar tucks its toolbar row away and
 * drops to a single line, so the transcript gets the room back. Two things
 * decide that here: whether the bar should collapse at all given what it is
 * doing, and whether a `focusout` on the bar really means the user has left it.
 */

export interface ComposerCollapseState {
  /** The user's setting, already gated on the surface it applies to. */
  enabled: boolean
  /** The keyboard is in the bar, or in a menu the bar opened. */
  focused: boolean
  /** The mic is live. The waveform replaces the text well, and its cancel and
   *  confirm controls must stay exactly where the hand left them. */
  recording: boolean
  /** The recorder has just settled and the keyboard is on its way back to the
   *  editor. The hand-back lands a frame or two later; folding in between
   *  painted a collapsed bar that unfolded again the moment focus arrived. */
  refocusPending: boolean
}

export function shouldCollapseComposer(state: ComposerCollapseState): boolean {
  return state.enabled && !state.focused && !state.recording && !state.refocusPending
}

/**
 * The portalled surfaces a bar's own controls open: bits-ui floating content
 * (the model chip, the permission picker, the saved-prompts sheet) and any
 * dialog. Focus moving into one of these is the bar still being used — its
 * trigger has to stay on screen for the menu to anchor to and return to.
 */
export const FLOATING_LAYER_SELECTOR =
  '[data-bits-floating-content-wrapper], [role="dialog"]'

/** Duck-typed rather than `instanceof Node`: a focus target from another
 *  realm — a test DOM, a webview — is still a node. */
function isNode(target: EventTarget | null): target is Node {
  // An EventTarget is always an object, so `in` is safe on it.
  return target !== null && 'nodeType' in target
}

export function floatingLayerOf(node: Node): Element | null {
  // SAFETY: nodeType 1 is ELEMENT_NODE, so the node is an Element; any other
  // node (a text node the caret sits in) is answered by its parent element.
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  return element?.closest(FLOATING_LAYER_SELECTOR) ?? null
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

export type FocusDestination =
  /** Still somewhere in the bar. */
  | 'inside'
  /** In a menu or dialog opened from the bar. */
  | 'menu'
  /** Nowhere: the window itself lost focus. The bar keeps its shape so
   *  restoring the app does not paint one collapsed frame before Chromium
   *  hands focus back to the editor. */
  | 'window'
  /** Genuinely elsewhere in the page. */
  | 'left'

export function focusDestinationAfterFocusOut(args: {
  root: Element
  relatedTarget: EventTarget | null
  documentHasFocus: boolean
}): FocusDestination {
  const next = args.relatedTarget
  if (isNode(next)) {
    if (args.root.contains(next)) return 'inside'
    if (floatingLayerOf(next)) return 'menu'
    return 'left'
  }
  return args.documentHasFocus ? 'left' : 'window'
}
