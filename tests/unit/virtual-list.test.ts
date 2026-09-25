import { describe, expect, test } from 'bun:test'
import { virtualGroupItems } from '@solus/workspace-ui/components/ui/list-page/virtualized-groups'
import { startOffset } from '@solus/workspace-ui/components/ui/list-page/virtual-list'

describe('the offset a list mounts at', () => {
  test('never asks for more than the rows can scroll', () => {
    // WHY: a remembered offset deeper than a list that came back shorter is
    // clamped by the browser without a scroll event, so the rows drawn would
    // sit below an empty viewport. Ten 30px rows in a 200px viewport scroll 100px.
    expect(startOffset(600, 10, () => 30, 200)).toBe(100)
    expect(startOffset(50, 10, () => 30, 200)).toBe(50)
    expect(startOffset(600, 3, () => 30, 200)).toBe(0)
  })

  test('sums per-row sizes for grouped lists', () => {
    const sizes = [20, 40, 40, 40, 40, 40, 40]
    expect(startOffset(1000, sizes.length, (index) => sizes[index], 200)).toBe(60)
  })
})

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
