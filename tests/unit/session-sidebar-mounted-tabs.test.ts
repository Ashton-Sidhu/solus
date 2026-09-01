import { describe, expect, test } from 'bun:test'
import type { Session, Tab } from '@solus/contracts/types'
import {
  mountedSidebarTabIds,
  sidebarSessionIds,
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

  test('keeps a worktree fork source attached to the mounted session', () => {
    // WHY: moving a session into a worktree forks its provider thread. The
    // durable task still names the source thread, so omitting that alias makes
    // the sidebar show the old attempt and the mounted session as two rows.
    const mountedTab = tab('worktree')
    const session = {
      agentSessionId: 'provider-session-in-worktree',
      forkedFromSessionId: 'provider-session-before-worktree',
      handoffId: null,
    } as unknown as Session

    expect(sidebarSessionIds(mountedTab, session)).toEqual([
      'session-worktree',
      'provider-session-in-worktree',
      'provider-session-before-worktree',
    ])
  })
})
