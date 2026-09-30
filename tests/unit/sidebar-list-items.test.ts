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
  return { id, key: id, lifecycle } as SidebarTask
}

function draft(draftId: string): DraftRow {
  // SAFETY: the list reads only the draft's id.
  return { draftId } as DraftRow
}

function list(overrides: Partial<SidebarListInput> = {}) {
  return buildSidebarListItems({
    drafts: [],
    tasks: [],
    sessions: [],
    snoozed: [],
    completed: [],
    isTasksOpen: true,
    isSessionsOpen: true,
    isSnoozedOpen: true,
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    ...overrides,
  })
}

describe('the sidebar as one list', () => {
  test('drafts lead, then Tasks, Sessions and each shelf under its header', () => {
    // WHY: a task is talked to through its lead with its page beside it; a
    // session is a conversation on its own. The column keeps the two apart
    // (docs/plans/task-conversation.md, decision 5).
    const items = list({
      drafts: [draft('d1')],
      tasks: [row('t1')],
      sessions: [row('a1')],
      snoozed: [row('s1', 'snoozed')],
      completed: [row('c1', 'completed')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'draft:d1',
      'drafts-divider',
      'header:tasks',
      't1:card',
      'header:sessions',
      'a1:card',
      'header:snoozed',
      's1:slim',
      'header:completed',
      'c1:slim',
    ])
    expect(items[2]).toMatchObject({ section: 'tasks', count: 1, isOpen: true })
    expect(items[4]).toMatchObject({ section: 'sessions', count: 1, isOpen: true })
  })

  test('a section with no rows has no header', () => {
    expect(list({ tasks: [row('t1')] }).map((item) => item.key)).toEqual(['header:tasks', 't1:card'])
  })

  test('with no tasks, sessions stand without a header and never collapse', () => {
    // WHY: a Sessions header only separates sessions from tasks. Alone, it is
    // a divider between the search bar and the list that divides nothing.
    expect(list({ sessions: [row('a1'), row('a2')], isSessionsOpen: false }).map((item) => item.key))
      .toEqual(['a1:card', 'a2:card'])
    expect(list({ tasks: [row('t1')], sessions: [row('a1')] }).map((item) => item.key))
      .toEqual(['header:tasks', 't1:card', 'header:sessions', 'a1:card'])
  })

  test('a session that becomes a task keeps its card, so it slides up into Tasks', () => {
    // WHY: the row is the same open work with the same shape; only its place
    // changes. A remount here would fade the row out and in instead of moving it.
    const before = list({ sessions: [row('t'), row('u')] })
    const after = list({ tasks: [row('t')], sessions: [row('u')] })
    const keyOf = (items: typeof before) => items.find((item) => item.kind === 'task' && item.task.id === 't')?.key
    expect(keyOf(after)).toBe(keyOf(before))
    expect(sidebarListOrderKey(after)).not.toBe(sidebarListOrderKey(before))
  })

  test('a collapsed Tasks or Sessions section keeps the row you are reading', () => {
    expect(list({ tasks: [row('t1'), row('t2')], isTasksOpen: false, shelfRevealTaskId: 't2' }).map((item) => item.key))
      .toEqual(['header:tasks', 't2:card'])
    expect(list({ tasks: [row('t1')], sessions: [row('a1'), row('a2')], isSessionsOpen: false, shelfRevealTaskId: 'a1' }).map((item) => item.key))
      .toEqual(['header:tasks', 't1:card', 'header:sessions', 'a1:card'])
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
    const active = list({ sessions: [row('t')] })
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
    const base = list({ sessions: [row('a')] })
    expect(sidebarListOrderKey(list({ drafts: [draft('d')], sessions: [row('a')] })))
      .not.toBe(sidebarListOrderKey(base))
    const changed = row('a')
    changed.unread = true
    expect(sidebarListOrderKey(list({ sessions: [changed] }))).toBe(sidebarListOrderKey(base))
  })
})
