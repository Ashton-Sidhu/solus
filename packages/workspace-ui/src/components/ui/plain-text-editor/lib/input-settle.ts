/**
 * Whether the editor must blur before a programmatic write so the keyboard
 * commits what it still holds. An open IME composition needs it everywhere. A
 * touch keyboard needs it whenever the editor has focus: iOS raises no
 * composition events for ordinary typing, yet still keeps the word under the
 * caret in flight and puts it back after a programmatic change.
 */
export function needsInputSettle(state: {
  hasFocus: boolean
  composing: boolean
  isTouchDevice: boolean
}): boolean {
  if (!state.hasFocus) return false
  return state.composing || state.isTouchDevice
}
