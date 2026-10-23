import { describe, expect, test } from 'bun:test'
import type { Tab } from '@solus/contracts/types'
import {
  mountedSidebarTabIds,
} from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

function tab(id: string): Tab {
  return { id, sessionId: `session-${id}`, hasUnread: false }
}

describe('session sidebar mounted tabs', () => {
  test('includes a session started without activating the leading tab pool', () => {
    const tabs = {
      'leading-tab': tab('leading-tab'),
      'secondary-tab': tab('secondary-tab'),
    }

    // WHY: a secondary-pane send mounts its session without activation. The
    // first prompt must create a sidebar row even before the task title arrives.
    expect(mountedSidebarTabIds(['leading-tab'], tabs)).toEqual([
      'leading-tab',
      'secondary-tab',
    ])
  })

  test('keeps tab order and ignores stale ordered ids', () => {
    const tabs = {
      'second-tab': tab('second-tab'),
      'first-tab': tab('first-tab'),
    }

    expect(mountedSidebarTabIds(['first-tab', 'closed-tab', 'second-tab'], tabs)).toEqual([
      'first-tab',
      'second-tab',
    ])
  })
})

test('a switch hides mounted sessions from the previous organization without closing their tabs', () => {
  const tabs = { local: tab('local'), first: tab('first'), second: tab('second') }
  const organizationIdForTab = (tabId: string) => tabId === 'local' ? 'local' : tabId === 'first' ? 'org-1' : 'org-2'
  expect(mountedSidebarTabIds(['first', 'local'], tabs, organizationIdForTab, 'org-1')).toEqual(['first', 'local'])
  expect(mountedSidebarTabIds(['first', 'local'], tabs, organizationIdForTab, 'org-2')).toEqual(['local', 'second'])
  expect(mountedSidebarTabIds(['first', 'local'], tabs, organizationIdForTab, 'org-1')).toEqual(['first', 'local'])
  expect(Object.keys(tabs)).toEqual(['local', 'first', 'second'])
})
