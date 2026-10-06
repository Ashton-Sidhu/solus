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
