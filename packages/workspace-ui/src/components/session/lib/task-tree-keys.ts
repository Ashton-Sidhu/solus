/**
 * What a key press means inside the sidebar list.
 *
 * The list is `role="tree"`: a row lists the session on screen under itself
 * when it does not stand for that session already, so ← from that session is
 * the way back to its row. Nothing opens or closes by key. The decision only
 * depends on the focused row's own state, so it lives here where it can be read
 * in one screen; the component is left holding nothing but the DOM.
 */
export type TreeKeyIntent =
  | { kind: 'focus'; index: number }
  /** → moves from the list into the conversation. */
  | { kind: 'enterPane' }
  | { kind: 'close' }
  | null

export interface TreeRowState {
  /** Position among the visible rows. */
  index: number
  /** Where ← lands from a session listed under a row. Null on a top-level row. */
  parentIndex: number | null
}

export function treeKeyIntent(key: string, row: TreeRowState, rowCount: number): TreeKeyIntent {
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: Math.min(row.index + 1, rowCount - 1) }
    case 'ArrowUp':
      return { kind: 'focus', index: Math.max(row.index - 1, 0) }
    case 'ArrowRight':
      return { kind: 'enterPane' }
    case 'ArrowLeft':
      return row.parentIndex === null ? null : { kind: 'focus', index: row.parentIndex }
    case 'Backspace':
      return { kind: 'close' }
    default:
      return null
  }
}
