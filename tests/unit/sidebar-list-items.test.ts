import { describe, expect, test } from 'bun:test'
import {
  buildSidebarListItems,
  sidebarListOrderKey,
  type SidebarListInput,
} from '@solus/workspace-ui/components/session/lib/sidebar-list-items'
import type { DraftRow } from '@solus/workspace-ui/components/session/lib/draft-list'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'

function row(id: string, lifecycle: SidebarTask['lifecycle'] = 'active'): SidebarTask {
  // SAFETY: the list reads only identity and lifecycle from a row.
  return { id, listKey: id, key: id, lifecycle } as SidebarTask
}

function draft(draftId: string): DraftRow {
  // SAFETY: the list reads only the draft's id.
  return { draftId } as DraftRow
}

function list(overrides: Partial<SidebarListInput> = {}) {
  return buildSidebarListItems({
    drafts: [],
    active: [],
    snoozed: [],
    completed: [],
    isSnoozedOpen: true,
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    ...overrides,
  })
}

describe('the sidebar as one list', () => {
  test('drafts lead, then the active column, then each shelf under its header', () => {
    const items = list({
      drafts: [draft('d1')],
      active: [row('a1')],
      snoozed: [row('s1', 'snoozed')],
      completed: [row('c1', 'completed')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'draft:d1',
      'drafts-divider',
      'a1:card',
      'header:snoozed',
      's1:slim',
      'header:completed',
      'c1:slim',
    ])
  })

  test('a row moving from Snoozed to Completed keeps its key, so it slides', () => {
    // WHY: one list is what lets a section change animate as a move. The order
    // key must change (so motion runs) while the element key stays (so the
    // same element travels rather than one fading out and another in).
    const before = list({ snoozed: [row('t', 'snoozed')], completed: [row('c', 'completed')] })
    const after = list({ completed: [row('t', 'completed'), row('c', 'completed')] })
    const keyOf = (items: typeof before) => items.find((item) => item.kind === 'task' && item.task.id === 't')?.key
    expect(keyOf(after)).toBe(keyOf(before))
    expect(sidebarListOrderKey(after)).not.toBe(sidebarListOrderKey(before))
  })

  test('a row changing shape between card and slim is a new element', () => {
    const active = list({ active: [row('t')] })
    const done = list({ completed: [row('t', 'completed')] })
    expect(active.find((item) => item.kind === 'task')?.key).toBe('t:card')
    expect(done.find((item) => item.kind === 'task')?.key).toBe('t:slim')
  })

  test('a collapsed shelf shows its header and only the row you are reading', () => {
    const items = list({
      completed: [row('c1', 'completed'), row('c2', 'completed')],
      isCompletedOpen: false,
      shelfRevealTaskId: 'c2',
    })
    expect(items.map((item) => item.key)).toEqual(['header:completed', 'c2:slim'])
    expect(items[0]).toMatchObject({ count: 2, isOpen: false })
  })

  test('a draft arriving is a change of order; a row changing contents is not', () => {
    const base = list({ active: [row('a')] })
    expect(sidebarListOrderKey(list({ drafts: [draft('d')], active: [row('a')] })))
      .not.toBe(sidebarListOrderKey(base))
    const changed = row('a')
    changed.unread = true
    expect(sidebarListOrderKey(list({ active: [changed] }))).toBe(sidebarListOrderKey(base))
  })
})
