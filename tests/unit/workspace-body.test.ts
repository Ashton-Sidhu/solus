import { describe, expect, test } from 'bun:test'
import { visibleWorkspaceTabIds } from '../../src/renderer/components/layout/lib/workspace-body'

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
