import { describe, expect, test } from 'bun:test'
import { virtualGroupItems } from '../../src/renderer/components/ui/list-page/virtualized-groups'

describe('virtualized grouped lists', () => {
  test('flattens a thousand rows for the shared virtual-list library', () => {
    // WHY: PR and Task sections must feed one scroll owner so the installed
    // virtual-list package can keep the mounted DOM bounded across all groups.
    const groups = [
      { key: 'open', rows: Array.from({ length: 600 }, (_, id) => ({ id })) },
      { key: 'done', rows: Array.from({ length: 400 }, (_, id) => ({ id: id + 600 })) },
    ]

    const items = virtualGroupItems(groups, (row) => row.id)
    expect(items).toHaveLength(1_002)
    expect(items[0]).toMatchObject({ key: 'header:open', kind: 'header' })
    expect(items.at(-1)).toMatchObject({ key: 'row:done:999', kind: 'row' })
  })

  test('keeps collapsed headers while removing their rows', () => {
    // WHY: collapsing a virtualized section must preserve the control that can
    // reopen it without leaving hidden rows in the library's item model.
    const groups = [
      { key: 'open', rows: [{ id: 1 }, { id: 2 }] },
      { key: 'done', rows: [{ id: 3 }] },
    ]
    const items = virtualGroupItems(groups, (row) => row.id, (group) => group.key !== 'open')

    expect(items.map((item) => item.key)).toEqual([
      'header:open',
      'header:done',
      'row:done:3',
    ])
  })
})
