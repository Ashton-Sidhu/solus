import { describe, expect, test } from 'bun:test'
import { ListSelection } from '../../packages/workspace-ui/src/components/ui/list-page/list-selection.svelte'

const click = { shiftKey: false } as MouseEvent
const shiftClick = { shiftKey: true } as MouseEvent

function selectionOver(order: string[]): ListSelection {
  const selection = new ListSelection()
  selection.setOrder(order)
  return selection
}

// The selection Tasks and Notifications share. Rows are named by whatever key the
// page uses, so a page with a composite key behaves as Tasks does.
describe('ListSelection', () => {
  test('Shift extends from the last row toggled, in either direction', () => {
    const selection = selectionOver(['a', 'b', 'c', 'd'])
    selection.toggle('d', click)
    selection.toggle('b', shiftClick)
    expect([...selection.ids].sort()).toEqual(['b', 'c', 'd'])
  })

  test('a plain click on a selected row removes it', () => {
    const selection = selectionOver(['a'])
    selection.toggle('a', click)
    selection.toggle('a', click)
    expect(selection.active).toBe(false)
  })

  test('a row that left the list leaves the selection, so the count stays honest', () => {
    const selection = selectionOver(['a', 'b'])
    selection.selectAllVisible()
    selection.setOrder(['b'])
    selection.retainVisible()
    expect([...selection.ids]).toEqual(['b'])
    expect(selection.size).toBe(1)
  })

  test('Shift after clear starts a new range instead of reaching back', () => {
    const selection = selectionOver(['a', 'b', 'c'])
    selection.toggle('a', click)
    selection.clear()
    selection.toggle('c', shiftClick)
    expect([...selection.ids]).toEqual(['c'])
  })
})
