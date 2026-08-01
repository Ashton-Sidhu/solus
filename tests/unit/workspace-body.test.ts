import { describe, expect, test } from 'bun:test'
import {
  hasStartedConversation,
  listSidebarPrimaryWidth,
  primaryProjectPanelOpen,
  retainedConversationTabIds,
  visibleWorkspaceTabIds,
} from '../../src/renderer/components/layout/lib/workspace-body'

describe('primary project rail visibility', () => {
  test('treats a tab-backed empty session as an unstarted draft', () => {
    expect(hasStartedConversation({
      agentSessionId: null,
      messages: [],
      status: 'idle',
    })).toBe(false)
  })

  test('recognizes resumed and newly dispatched conversations as started', () => {
    expect(hasStartedConversation({
      agentSessionId: 'provider-session',
      messages: [],
      status: 'idle',
    })).toBe(true)
    expect(hasStartedConversation({
      agentSessionId: null,
      messages: [{ role: 'user' } as any],
      status: 'connecting',
    })).toBe(true)
  })

  test('starts hidden on a new tab even when conversations prefer it open', () => {
    expect(primaryProjectPanelOpen(false, true, false)).toBe(false)
  })

  test('can be explicitly popped out before a session starts', () => {
    expect(primaryProjectPanelOpen(false, false, true)).toBe(true)
  })

  test('returns to the persisted preference once a session exists', () => {
    expect(primaryProjectPanelOpen(true, true, false)).toBe(true)
    expect(primaryProjectPanelOpen(true, false, true)).toBe(false)
  })
})

// The strip groups by the same environment-derived branch key the sidebar uses,
// supplied here as a per-tab lookup so the test stays independent of the Git
// environment store.
const branchKeyOf = (keys: Record<string, string>) => (tabId: string) => keys[tabId] ?? '~'

describe('workspace tab visibility', () => {
  test('shows only sessions in the active project and branch group', () => {
    const keys = {
      'main-tab': '/projects/solus::main',
      'agent-tab': '/projects/solus::agent/fix (worktree)',
      'other-tab': '/projects/other::main',
    }
    const workspace = {
      tabOrder: ['main-tab', 'agent-tab', 'other-tab'],
      tabs: {
        'main-tab': { id: 'main-tab' },
        'agent-tab': { id: 'agent-tab' },
        'other-tab': { id: 'other-tab' },
      },
      sessionFor: () => undefined,
    }

    expect(
      visibleWorkspaceTabIds(workspace as any, 'main-tab', null, branchKeyOf(keys)),
    ).toEqual(['main-tab'])
  })

  test('keeps a resumed session grouped with its siblings while gitContext lags', () => {
    // The resumed tab has hydrated its environment key (matches main) even though
    // its live session.gitContext is still null — the sibling must stay visible.
    const keys = {
      'main-tab': '/projects/solus::main',
      'resumed-tab': '/projects/solus::main',
    }
    const workspace = {
      tabOrder: ['main-tab', 'resumed-tab'],
      tabs: {
        'main-tab': { id: 'main-tab' },
        'resumed-tab': { id: 'resumed-tab' },
      },
      sessionFor: () => undefined,
    }

    expect(
      visibleWorkspaceTabIds(workspace as any, 'resumed-tab', null, branchKeyOf(keys)),
    ).toEqual(['main-tab', 'resumed-tab'])
  })

  test('keeps a secondary split chat visible outside the active branch group', () => {
    const keys = {
      'main-tab': '/projects/solus::main',
      'agent-tab': '/projects/solus::agent/fix (worktree)',
    }
    const workspace = {
      tabOrder: ['main-tab', 'agent-tab'],
      tabs: {
        'main-tab': { id: 'main-tab' },
        'agent-tab': { id: 'agent-tab' },
      },
      sessionFor: () => undefined,
    }

    expect(
      visibleWorkspaceTabIds(workspace as any, 'main-tab', 'agent-tab', branchKeyOf(keys)),
    ).toEqual(['main-tab', 'agent-tab'])
  })

  test('stays scoped to the active group while the active session loads history', () => {
    // A resumed pinned session becomes active while its history loads. The strip
    // must stay grouped by the resumed tab's environment key — which already
    // resolves off the cwd's cached status — rather than flashing every project
    // into the strip until the load finishes.
    const keys = {
      'main-tab': '/projects/solus::main',
      'other-tab': '/projects/other::main',
    }
    const workspace = {
      tabOrder: ['main-tab', 'other-tab'],
      tabs: {
        'main-tab': { id: 'main-tab' },
        'other-tab': { id: 'other-tab' },
      },
      sessionFor: (tabId: string) =>
        tabId === 'main-tab' ? ({ loadingHistory: true } as any) : undefined,
    }

    expect(
      visibleWorkspaceTabIds(workspace as any, 'main-tab', null, branchKeyOf(keys)),
    ).toEqual(['main-tab'])
  })

  test('omits stale tab-order entries that no longer have a tab', () => {
    const workspace = {
      tabOrder: ['open-tab', 'closed-tab'],
      tabs: {
        'open-tab': { id: 'open-tab' },
      },
      sessionFor: () => undefined,
    }

    expect(
      visibleWorkspaceTabIds(workspace as any, 'open-tab', null, () => 'x'),
    ).toEqual(['open-tab'])
  })
})

describe('conversation transcript retention', () => {
  test('keeps visible chats and only the most recent hidden transcripts', () => {
    expect(
      retainedConversationTabIds(
        ['tab-d', 'tab-c', 'tab-b', 'tab-a'],
        ['tab-e'],
        ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e'],
        4,
      ),
    ).toEqual(['tab-e', 'tab-d', 'tab-c', 'tab-b'])
  })

  test('keeps every visible split chat even when the retention limit is smaller', () => {
    expect(
      retainedConversationTabIds(
        ['tab-a'],
        ['tab-b', 'tab-c'],
        ['tab-a', 'tab-b', 'tab-c'],
        1,
      ),
    ).toEqual(['tab-b', 'tab-c'])
  })

  test('drops closed tabs from the retained set', () => {
    expect(
      retainedConversationTabIds(
        ['closed-tab', 'recent-tab'],
        ['active-tab'],
        ['active-tab', 'recent-tab'],
      ),
    ).toEqual(['active-tab', 'recent-tab'])
  })
})

describe('docked list sidebar sizing', () => {
  test('keeps the PR inbox compact while leaving the review the remaining width', () => {
    expect(listSidebarPrimaryWidth(1000)).toBe(228)
    expect(listSidebarPrimaryWidth(1440)).toBe(274)
    expect(listSidebarPrimaryWidth(2400)).toBe(340)
  })
})
