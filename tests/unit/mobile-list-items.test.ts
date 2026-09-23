import { describe, expect, test } from 'bun:test'
import type { PinnedSession } from '@solus/contracts/types'
import type { DraftRow } from '@solus/workspace-ui/components/session/lib/draft-list'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { sidebarListOrderKey } from '@solus/workspace-ui/components/session/lib/sidebar-list-items'
import { buildMobileListItems, type MobileListInput } from '../../apps/client/src/shell/mobile/lib/mobile-list-items'

function row(id: string, lifecycle: SidebarTask['lifecycle'] = 'active'): SidebarTask {
  // SAFETY: the list reads only identity and lifecycle from a row.
  return { id, listKey: id, key: id, lifecycle } as SidebarTask
}

function list(overrides: Partial<MobileListInput> = {}) {
  return buildMobileListItems({
    // SAFETY: the list reads only a draft's id and a pin's session identity.
    drafts: [{ draftId: 'd1' } as DraftRow],
    pinned: [{ serverId: 'local', sessionId: 's1' } as PinnedSession],
    showsLead: true,
    active: [row('a1')],
    snoozed: [row('z1', 'snoozed')],
    completed: [row('c1', 'completed')],
    isCompletedOpen: true,
    shelfRevealTaskId: null,
    ...overrides,
  })
}

describe("the phone's task list", () => {
  test('leads with drafts, pins, and presence, then lists tasks as the desktop does', () => {
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

  test('a search lists tasks only', () => {
    expect(list({ showsLead: false }).map((item) => item.key)).toEqual([
      'a1:card',
      'header:snoozed',
      'z1:slim',
      'header:completed',
      'c1:slim',
    ])
  })

  test('a pin that arrives is a change of order, so the tasks below it slide', () => {
    // WHY: on the phone pins sit above the tasks; before one list, a new pin
    // pushed every task down with no motion.
    const before = list({ pinned: [] })
    expect(sidebarListOrderKey(list())).not.toBe(sidebarListOrderKey(before))
  })

  test('Snoozed has no collapse control on the phone, so it always lists its rows', () => {
    expect(list().some((item) => item.key === 'z1:slim')).toBe(true)
  })
})
