import { describe, expect, test } from 'bun:test'
import type { PinnedSession } from '@solus/contracts/types'
import type { DraftRow } from '@solus/workspace-ui/components/session/lib/draft-list'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { sidebarListOrderKey } from '@solus/workspace-ui/components/session/lib/sidebar-list-items'
import { buildMobileListItems, type MobileListInput } from '../../apps/client/src/shell/mobile/lib/mobile-list-items'

function row(id: string, lifecycle: SidebarTask['lifecycle'] = 'active'): SidebarTask {
  // SAFETY: the list reads only identity and lifecycle from a row.
  return { id, key: id, lifecycle } as SidebarTask
}

function list(overrides: Partial<MobileListInput> = {}) {
  return buildMobileListItems({
    // SAFETY: the list reads only a draft's id and a pin's session identity.
    drafts: [{ draftId: 'd1' } as DraftRow],
    pinned: [{ serverId: 'local', sessionId: 's1' } as PinnedSession],
    showsLead: true,
    tasks: [],
    sessions: [row('a1')],
    snoozed: [row('z1', 'snoozed')],
    completed: [row('c1', 'completed')],
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    ...overrides,
  })
}

describe("the phone's list", () => {
  test('leads with drafts, pins, and presence, then lists sections as the desktop does', () => {
    expect(list().map((item) => item.key)).toEqual([
      'label:drafts',
      'draft:d1',
      'label:pinned',
      'pin:local:s1',
      'here-now',
      'a1:card',
      'header:snoozed',
      'z1:slim',
      'header:completed',
      'c1:slim',
    ])
  })

  test('a search lists tasks and sessions only', () => {
    expect(list({ showsLead: false }).map((item) => item.key)).toEqual([
      'a1:card',
      'header:snoozed',
      'z1:slim',
      'header:completed',
      'c1:slim',
    ])
  })

  test('a pin that arrives is a change of order, so the rows below it slide', () => {
    // WHY: on the phone pins sit above the rows; before one list, a new pin
    // pushed every row down with no motion.
    const before = list({ pinned: [] })
    expect(sidebarListOrderKey(list())).not.toBe(sidebarListOrderKey(before))
  })

  test('Snoozed has no collapse control on the phone, so it always lists its rows', () => {
    expect(list().some((item) => item.key === 'z1:slim')).toBe(true)
  })

  test('Tasks arrive through the shared builder, above Sessions and always open', () => {
    // WHY: the phone lists the same sections as the desktop sidebar; a task
    // must not fall into the Sessions section here.
    const keys = list({ tasks: [row('t1')] }).map((item) => item.key)
    expect(keys.indexOf('header:tasks')).toBeGreaterThan(keys.indexOf('here-now'))
    expect(keys.indexOf('t1:card')).toBe(keys.indexOf('header:tasks') + 1)
    expect(keys.indexOf('header:sessions')).toBe(keys.indexOf('t1:card') + 1)
    expect(keys.indexOf('a1:card')).toBe(keys.indexOf('header:sessions') + 1)
  })
})
