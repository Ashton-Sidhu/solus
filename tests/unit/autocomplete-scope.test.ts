import { describe, expect, test } from 'bun:test'
import type { Session } from '../../src/shared/types'
import {
  autocompleteSessionChangedFiles,
  resolveAutocompleteScope,
} from '../../src/renderer/components/editor/autocomplete-scope'

function workspace(sessions: Record<string, Partial<Session>>) {
  return {
    activeTabId: 'local-tab',
    sessionFor: (tabId: string) => sessions[tabId] as Session | undefined,
  }
}

describe('autocomplete scope', () => {
  test("a tab-bound composer searches the agent's worktree checkout", () => {
    // WHY: the project root and worktree can contain different files; references
    // must describe the filesystem the agent will actually read.
    const scope = resolveAutocompleteScope(
      workspace({
        'remote-tab': {
          run: {
            workingDirectory: '/projects/solus',
            gitContext: {
              repoRoot: '/projects/solus',
              branch: 'feature',
              targetBranch: 'main',
              worktreePath: '/projects/solus/.solus-worktrees/feature',
            },
          } as Session['run'],
        },
      }),
      '/projects/solus',
      'remote-tab',
    )

    expect(scope).toEqual({
      tabId: 'remote-tab',
      workingDirectory: '/projects/solus/.solus-worktrees/feature',
    })
  })

  test('a non-active owner tab remains the RPC routing target', () => {
    // WHY: tabs may belong to different hosts even when their absolute project
    // paths are identical, so active-tab routing can query the wrong machine.
    const scope = resolveAutocompleteScope(
      workspace({
        'remote-tab': { run: { workingDirectory: '/projects/solus', gitContext: null } as Session['run'] },
      }),
      '/projects/solus',
      'remote-tab',
    )

    expect(scope.tabId).toBe('remote-tab')
    expect(scope.workingDirectory).toBe('/projects/solus')
  })

  test('a detached editor keeps its explicit directory on the active host', () => {
    // WHY: task and automation editors are project-scoped rather than bound to
    // a chat worktree; an unrelated active session must not replace their cwd.
    const scope = resolveAutocompleteScope(
      workspace({
        'local-tab': {
          run: {
            workingDirectory: '/projects/other',
            gitContext: {
              repoRoot: '/projects/other',
              branch: 'other',
              targetBranch: 'main',
              worktreePath: '/projects/other/.solus-worktrees/other',
            },
          } as Session['run'],
        },
      }),
      '/projects/tasks',
      undefined,
    )

    expect(scope).toEqual({
      tabId: 'local-tab',
      workingDirectory: '/projects/tasks',
    })
  })

  test('a new-session draft does not inherit changed files from the active session', () => {
    // WHY: the active tab can route autocomplete to its host, but the draft has
    // no session content yet and must not show "Open in this session" for it.
    const currentSession = {
      sessionChangedFiles: ['src/current-session.ts'],
    } as Session
    const currentWorkspace = workspace({ 'local-tab': currentSession })
    const scope = resolveAutocompleteScope(
      currentWorkspace,
      '/projects/new-draft',
      undefined,
    )

    expect(scope).toEqual({
      tabId: 'local-tab',
      workingDirectory: '/projects/new-draft',
    })
    expect(
      autocompleteSessionChangedFiles({ 'current-session': currentSession }, undefined),
    ).toEqual([])
  })

  test('changed-file suggestions are owned by a session id, not a tab id', () => {
    // WHY: several tabs can show one session, and closing a tab must not change
    // the session content that autocomplete offers.
    const currentSession = {
      sessionChangedFiles: ['src/session-owned.ts'],
    } as Session

    expect(
      autocompleteSessionChangedFiles({ 'session-1': currentSession }, 'session-1'),
    ).toEqual(['src/session-owned.ts'])
    expect(
      autocompleteSessionChangedFiles({ 'session-1': currentSession }, 'tab-1'),
    ).toEqual([])
  })
})
