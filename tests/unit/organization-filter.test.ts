import { describe, expect, test } from 'bun:test'
import { LOCAL_ORGANIZATION_ID, visibleInWindow } from '@solus/workspace-ui/lib/organization-filter'
import { solusApiId } from '@solus/contracts/uplink'

// docs/plans/organization-scope.md §2: a window shows Local content beside the
// organization it selected, and nothing of another organization.

describe('what a window shows', () => {
  test('Local content is visible in every window, whatever organization is selected', () => {
    // WHY: selecting an organization is a filter on cloud content, never a way
    // to hide the person's own work.
    for (const active of [null, 'org-1', 'org-2']) {
      expect(visibleInWindow(LOCAL_ORGANIZATION_ID, active)).toBe(true)
      // A record from a host that predates the field is Local.
      expect(visibleInWindow(undefined, active)).toBe(true)
    }
  })

  test('an organization\'s record is visible only while that organization is selected', () => {
    expect(visibleInWindow('org-1', 'org-1')).toBe(true)
    expect(visibleInWindow('org-1', 'org-2')).toBe(false)
    // With no organization selected, only Local shows.
    expect(visibleInWindow('org-1', null)).toBe(false)
  })
})

describe('a personal host is read whole (plans/031 rule 1)', () => {
  test('a personal host\'s organization record shows in every window, signed in or out; a Solus API\'s and a managed host\'s keep the filter', async () => {
    // WHY: signed out there is no organization selection, and the owner's own
    // organization sessions, tasks, and works on their laptop vanished from every list.
    const { usesWindowFilter } = await import('@solus/client-core/organization-filter')
    const managed = new Set(['vm-1'])
    expect(visibleInWindow('org-a', null, usesWindowFilter('laptop', managed))).toBe(true)
    expect(visibleInWindow('org-a', 'org-b', usesWindowFilter('laptop', managed))).toBe(true)
    expect(visibleInWindow('org-a', 'org-b', usesWindowFilter('vm-1', managed))).toBe(false)
    expect(visibleInWindow('org-a', 'org-b', usesWindowFilter(solusApiId('org-a'), managed))).toBe(false)
    // A record whose source is not known keeps the filter.
    expect(visibleInWindow('org-a', 'org-b', usesWindowFilter(null, managed))).toBe(false)
  })
})
