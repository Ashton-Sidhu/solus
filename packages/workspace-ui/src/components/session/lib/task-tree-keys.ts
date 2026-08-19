/**
 * What a key press means inside the task tree.
 *
 * The list is `role="tree"`, so the arrows have to behave like a tree rather
 * than like a listbox: → opens a closed row before it walks into it, and ← is
 * the way back out of a session. The decision only depends on the focused row's
 * own state, so it lives here where it can be read in one screen; the component
 * is left holding nothing but the DOM.
 */
export type TreeKeyIntent =
  | { kind: 'focus'; index: number }
  | { kind: 'expand' }
  | { kind: 'collapse' }
  /** → on a row with nothing to open: the next step in is the conversation. */
  | { kind: 'enterPane' }
  | { kind: 'close' }
  | null

export interface TreeRowState {
  /** Position among the visible rows, sessions included when expanded. */
  index: number
  /** Undefined on a row with no sessions — it has nothing to open or close. */
  expanded: boolean | undefined
  /** Where ← lands from a session. Null on a top-level task row. */
  parentIndex: number | null
}

export function treeKeyIntent(key: string, row: TreeRowState, rowCount: number): TreeKeyIntent {
  const next = Math.min(row.index + 1, rowCount - 1)

  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: next }
    case 'ArrowUp':
      return { kind: 'focus', index: Math.max(row.index - 1, 0) }
    case 'ArrowRight':
      if (row.expanded === false) return { kind: 'expand' }
      // An expanded row's first child is the row directly after it.
      if (row.expanded === true) return { kind: 'focus', index: next }
      return { kind: 'enterPane' }
    case 'ArrowLeft':
      if (row.expanded === true) return { kind: 'collapse' }
      if (row.parentIndex !== null) return { kind: 'focus', index: row.parentIndex }
      return null
    case 'Backspace':
      return { kind: 'close' }
    default:
      return null
  }
}
