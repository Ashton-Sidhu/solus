/**
 * What a key press means inside the sidebar list.
 *
 * The list is `role="tree"`: a row lists the sessions its session started
 * under itself, so ← from one of them is the way back to its row. A row with
 * sessions folded away opens on → like a folder, and ← folds an open one
 * before it climbs. In the project view a project folder is a row too: →
 * opens it and then moves into its sessions, ← goes back to the folder and
 * then closes it. Nothing else opens or closes by key. The decision only
 * depends on the focused row's own state, so it lives here where it can be read
 * in one screen; the component is left holding nothing but the DOM.
 */
export type TreeKeyIntent =
  | { kind: 'focus'; index: number }
  /** → moves from the list into the conversation. */
  | { kind: 'enterPane' }
  | { kind: 'close' }
  /** Open or close the focused project folder. */
  | { kind: 'setFolderOpen'; isOpen: boolean }
  /** Unfold or fold the sessions the focused row started. */
  | { kind: 'setNestedOpen'; isOpen: boolean }
  | null

export interface TreeRowState {
  /** Position among the visible rows. */
  index: number
  /** Where ← lands from a session listed under a row, or from a session in a
   *  project folder: that folder. Null on a top-level row. */
  parentIndex: number | null
  /** Set on a project folder's header: whether the folder is open. */
  folderOpen?: boolean
  /** Set on a row that started sessions: whether they are unfolded under it. */
  nestedOpen?: boolean
}

export function treeKeyIntent(key: string, row: TreeRowState, rowCount: number): TreeKeyIntent {
  if (row.folderOpen !== undefined) return folderKeyIntent(key, row, rowCount)
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: Math.min(row.index + 1, rowCount - 1) }
    case 'ArrowUp':
      return { kind: 'focus', index: Math.max(row.index - 1, 0) }
    case 'ArrowRight':
      return row.nestedOpen === false ? { kind: 'setNestedOpen', isOpen: true } : { kind: 'enterPane' }
    case 'ArrowLeft':
      if (row.nestedOpen === true) return { kind: 'setNestedOpen', isOpen: false }
      return row.parentIndex === null ? null : { kind: 'focus', index: row.parentIndex }
    case 'Backspace':
      return { kind: 'close' }
    default:
      return null
  }
}

/** A folder's header: arrows walk as on any row, → and ← open and close it, and
 *  ⌫ does nothing because a project is not something the list can close. */
function folderKeyIntent(key: string, row: TreeRowState, rowCount: number): TreeKeyIntent {
  switch (key) {
    case 'ArrowRight':
      return row.folderOpen
        ? { kind: 'focus', index: Math.min(row.index + 1, rowCount - 1) }
        : { kind: 'setFolderOpen', isOpen: true }
    case 'ArrowLeft':
      return row.folderOpen ? { kind: 'setFolderOpen', isOpen: false } : null
    case 'Backspace':
      return null
    default:
      return treeKeyIntent(key, { index: row.index, parentIndex: row.parentIndex }, rowCount)
  }
}
