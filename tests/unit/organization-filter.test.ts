import { describe, expect, test } from 'bun:test'
import { LOCAL_ORGANIZATION_ID, visibleInWindow } from '@solus/workspace-ui/lib/organization-filter'

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
