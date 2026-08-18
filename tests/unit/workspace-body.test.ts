import { describe, expect, test } from 'bun:test'
import {
  COMPANION_PANE_DEFAULT_SIZE,
  COMPANION_PANE_MIN_SIZE,
  isHomeVisible,
  LIST_PRIMARY_PANE_MIN_SIZE,
  LIST_PRIMARY_PANE_SIZE,
  PRIMARY_PANE_MIN_SIZE,
  primaryProjectPanelOpen,
  retainedConversationTabIds,
  visibleWorkspaceTabIds,
} from '../../src/renderer/components/layout/lib/workspace-body'
import { hasSessionStarted } from '../../src/renderer/lib/sessionUtils'

describe('restored conversation loading', () => {
  test('never replaces a restored provider session with the new-session home', () => {
    // WHY: an empty or failed history read must not turn the tab selected before
    // reload into a composer. The provider id is durable proof that it started.
    expect(isHomeVisible({
      agentSessionId: 'provider-session',
      handoffFrom: undefined,
      messages: [],
      statusCard: null,
      loadingHistory: false,
    })).toBe(false)
  })

  test('keeps the home hidden while restored history is actually loading', () => {
    expect(isHomeVisible({
      agentSessionId: 'provider-session',
      handoffFrom: undefined,
      messages: [],
      statusCard: null,
      loadingHistory: true,
    })).toBe(false)
  })

  test('keeps the conversation open when an empty session has a snooze reminder', () => {
    // WHY: the reminder is transcript content. Treating this state as a fresh
    // tab closes the Pill body and hides the only item the user needs to see.
    expect(isHomeVisible({
      agentSessionId: 'provider-session',
      handoffFrom: undefined,
      messages: [],
      statusCard: null,
      loadingHistory: false,
    }, true)).toBe(false)
  })

  test('never replaces a restored handoff session with the new-session home', () => {
    expect(isHomeVisible({
      agentSessionId: null,
      handoffFrom: { provider: 'claude', sessionId: 'previous-session' },
      messages: [],
      statusCard: null,
      loadingHistory: false,
    })).toBe(false)
  })
})

describe('primary project rail visibility', () => {
  test('treats a tab-backed empty session as an unstarted draft', () => {
    expect(hasSessionStarted({
      agentSessionId: null,
      messages: [],
      status: 'idle',
    })).toBe(false)
  })

  test('recognizes resumed and newly dispatched conversations as started', () => {
    expect(hasSessionStarted({
      agentSessionId: 'provider-session',
      messages: [],
      status: 'idle',
    })).toBe(true)
    expect(hasSessionStarted({
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

describe('pane sizing', () => {
  test('the docked PR inbox leaves the review every point it does not take', () => {
    // WHY: the inbox is navigation beside its review, so it is the one case where
    // the primary states its share and the companion takes the remainder. The two
    // are set independently, so a drift between them opens the split with a gap.
    expect(LIST_PRIMARY_PANE_SIZE + (100 - LIST_PRIMARY_PANE_SIZE)).toBe(100)
    // A conversation floor is sized for a composer; navigation needs far less,
    // and applying the chat floor here stranded the inbox at half the split.
    expect(LIST_PRIMARY_PANE_MIN_SIZE).toBeLessThan(PRIMARY_PANE_MIN_SIZE)
  })

  test('a companion can never squeeze the primary below its floor', () => {
    // WHY: PaneForge clamps each pane to its own bounds and cannot see that two
    // floors together exceed the split. If these ever sum past 100 the group has
    // no satisfiable layout, and the leading pane is the one that loses.
    expect(COMPANION_PANE_MIN_SIZE + PRIMARY_PANE_MIN_SIZE).toBeLessThanOrEqual(100)
    expect(COMPANION_PANE_DEFAULT_SIZE).toBeGreaterThanOrEqual(COMPANION_PANE_MIN_SIZE)
    expect(COMPANION_PANE_DEFAULT_SIZE).toBeLessThanOrEqual(100 - PRIMARY_PANE_MIN_SIZE)
  })
})
