import { describe, expect, it } from 'bun:test'
import { treeKeyIntent } from '@solus/workspace-ui/components/session/lib/task-tree-keys'

const leaf = { index: 1, expanded: undefined, parentIndex: null }
const collapsed = { index: 1, expanded: false, parentIndex: null }
const expanded = { index: 1, expanded: true, parentIndex: null }
const child = { index: 2, expanded: undefined, parentIndex: 1 }

describe('treeKeyIntent', () => {
  it('walks the visible rows without running off either end', () => {
    expect(treeKeyIntent('ArrowDown', leaf, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(treeKeyIntent('ArrowDown', { ...leaf, index: 2 }, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(treeKeyIntent('ArrowUp', leaf, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(treeKeyIntent('ArrowUp', { ...leaf, index: 0 }, 3)).toEqual({ kind: 'focus', index: 0 })
  })

  it('makes → open a closed task before it walks into one', () => {
    // Two presses to reach a subtask, never one: the first press is a
    // disclosure, and disclosure must not move what the pane is showing.
    expect(treeKeyIntent('ArrowRight', collapsed, 3)).toEqual({ kind: 'expand' })
    expect(treeKeyIntent('ArrowRight', expanded, 3)).toEqual({ kind: 'focus', index: 2 })
  })

  it('sends → into the pane from a row with nothing to open', () => {
    // A leaf has no next step inside the tree, so → is the way out of the
    // column and into the conversation.
    expect(treeKeyIntent('ArrowRight', leaf, 3)).toEqual({ kind: 'enterPane' })
  })

  it('makes ← close a task and climb out of a subtask', () => {
    expect(treeKeyIntent('ArrowLeft', expanded, 3)).toEqual({ kind: 'collapse' })
    expect(treeKeyIntent('ArrowLeft', child, 3)).toEqual({ kind: 'focus', index: 1 })
  })

  it('leaves ← alone on a collapsed top-level row', () => {
    // Nothing to collapse and nowhere to climb — swallowing the key here would
    // silently eat a caret move the user meant for somewhere else.
    expect(treeKeyIntent('ArrowLeft', collapsed, 3)).toBeNull()
    expect(treeKeyIntent('ArrowLeft', leaf, 3)).toBeNull()
  })

  it('closes on ⌫ and ignores everything else', () => {
    expect(treeKeyIntent('Backspace', leaf, 3)).toEqual({ kind: 'close' })
    expect(treeKeyIntent('a', leaf, 3)).toBeNull()
    expect(treeKeyIntent('Enter', leaf, 3)).toBeNull()
  })
})
