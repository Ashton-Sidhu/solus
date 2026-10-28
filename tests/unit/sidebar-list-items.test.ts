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
    sessions: [],
    working: [],
    snoozed: [],
    completed: [],
    isWorkingOpen: true,
    isSnoozedOpen: true,
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    ...overrides,
  })
}

describe('the sidebar as one list', () => {
  test('busy rows sit in a Working section between the sessions and the shelves', () => {
    // WHY: a row whose agent is busy without you does not ask for anything, so
    // it leaves the sessions until it comes back with a question, a plan, an
    // error, or a finished turn.
    const items = list({
      sessions: [row('a1')],
      working: [row('w1'), row('w2')],
      snoozed: [row('s1', 'snoozed')],
    })
    expect(items.map((item) => item.key)).toEqual([
      'a1:card',
      'header:working',
      'w1:card',
      'w2:card',
      'header:snoozed',
      's1:slim',
    ])
    expect(items[1]).toMatchObject({ section: 'working', count: 2, isOpen: true })
  })

  test('a closed Working section still shows the row on screen', () => {
    // WHY: sending a prompt makes the row you are reading busy. It must not
    // disappear into a closed section while you watch its turn run.
    expect(list({ working: [row('w1'), row('w2')], isWorkingOpen: false, shelfRevealTaskId: 'w2' })
      .map((item) => item.key)).toEqual(['header:working', 'w2:card'])
    expect(list({ working: [row('w1')], isWorkingOpen: false }).map((item) => item.key))
      .toEqual(['header:working'])
  })

  test('a row that starts or finishes a turn keeps its card, so it slides between sections', () => {
    // WHY: a remount would fade the row out and in instead of moving it.
    const idle = list({ sessions: [row('s1'), row('a1')] })
    const busy = list({ sessions: [row('s1')], working: [row('a1')] })
    expect(idle.find((item) => item.kind === 'task' && item.task.id === 'a1')?.key)
      .toBe(busy.find((item) => item.kind === 'task' && item.task.id === 'a1')?.key)
    expect(sidebarListOrderKey(idle)).not.toBe(sidebarListOrderKey(busy))
  })

  test('drafts lead, then the sessions, then each shelf under its header', () => {
    // WHY: tasks have no place in the sidebar. Every row is one session, and a
    // session linked to a task names it on a chip; there is no Tasks section.
    const items = list({
      drafts: [draft('d1')],
      sessions: [row('a1')],
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
    expect(items.some((item) => item.kind === 'header' && item.section === 'sessions')).toBe(false)
  })

  test('a section with no rows has no header', () => {
    expect(list({ working: [row('w1')] }).map((item) => item.key)).toEqual(['header:working', 'w1:card'])
    expect(list({}).map((item) => item.key)).toEqual([])
  })

  test('sessions stand without a header and never collapse', () => {
    // WHY: a Sessions header would only divide the sessions from nothing, and
    // a collapsed one would hide the work in front of the user.
    expect(list({ sessions: [row('a1'), row('a2')] }).map((item) => item.key))
      .toEqual(['a1:card', 'a2:card'])
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
