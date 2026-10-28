import { describe, expect, it } from 'bun:test'
import { treeKeyIntent } from '@solus/workspace-ui/components/session/lib/task-tree-keys'

const row = { index: 1, parentIndex: null }
const listedSession = { index: 2, parentIndex: 1 }

describe('treeKeyIntent', () => {
  it('walks the visible rows without running off either end', () => {
    expect(treeKeyIntent('ArrowDown', row, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(treeKeyIntent('ArrowDown', { ...row, index: 2 }, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(treeKeyIntent('ArrowUp', row, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(treeKeyIntent('ArrowUp', { ...row, index: 0 }, 3)).toEqual({ kind: 'focus', index: 0 })
  })

  it('sends → into the pane from a row with nothing folded under it', () => {
    // WHY: a row that started no sessions, and a session listed under a row,
    // have nothing to open, so → has one meaning: leave the column for the
    // conversation. A row with folded sessions unfolds them first
    // (sidebar-project-view.test.ts).
    expect(treeKeyIntent('ArrowRight', row, 3)).toEqual({ kind: 'enterPane' })
    expect(treeKeyIntent('ArrowRight', listedSession, 3)).toEqual({ kind: 'enterPane' })
  })

  it('makes ← climb out of a session listed under a row', () => {
    expect(treeKeyIntent('ArrowLeft', listedSession, 3)).toEqual({ kind: 'focus', index: 1 })
  })

  it('leaves ← alone on a top-level row', () => {
    // Nowhere to climb — swallowing the key here would silently eat a caret
    // move the user meant for somewhere else.
    expect(treeKeyIntent('ArrowLeft', row, 3)).toBeNull()
  })

  it('closes on ⌫ and ignores everything else', () => {
    expect(treeKeyIntent('Backspace', row, 3)).toEqual({ kind: 'close' })
    expect(treeKeyIntent('a', row, 3)).toBeNull()
    expect(treeKeyIntent('Enter', row, 3)).toBeNull()
  })
})
