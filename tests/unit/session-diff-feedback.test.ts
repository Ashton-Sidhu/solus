import { describe, expect, test } from 'bun:test'
import {
  submitDiffFeedback,
  submitDiffFeedbackToNewSession,
} from '@solus/workspace-ui/contexts/workspace/session-diff-feedback'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { DiffComment, GitCheckout, Place } from '@solus/contracts/types'
import { checkoutGit, checkoutPlace, folderLocation, projectHome } from '@solus/workspace-ui/contexts/workspace/run-location'

function comment(filePath: string): DiffComment {
  return {
    id: crypto.randomUUID(),
    filePath,
    startLine: 2,
    endLine: 3,
    side: 'new',
    selectedCode: 'const value = true',
    comment: 'Keep this behavior.',
    createdAt: 1,
  }
}

function session(overrides: Partial<{
  diffComments: DiffComment[]
  diffGeneralComment: string
  path: string
  git: GitCheckout | null
  serverId: string
  project: Place
}> = {}) {
  return {
    diffComments: overrides.diffComments ?? [],
    diffCommentDraft: null,
    diffGeneralComment: overrides.diffGeneralComment ?? '',
    task: { kind: 'none' as const },
    run: {
      location: folderLocation(
        { serverId: overrides.serverId ?? 'host', path: overrides.path ?? '~' },
        { git: overrides.git ?? null, project: overrides.project ?? { serverId: 'task-host', path: '~' } },
      ),
    },
  }
}

/** A workspace where each tab watches the like-named session. Queued review
 *  feedback lives on the session; the tab is only how a surface names it. */
function workspace(sessions: Record<string, ReturnType<typeof session>>, extra: object = {}) {
  return {
    activeTabId: 'active',
    tabs: Object.fromEntries(Object.keys(sessions).map((id) => [id, { id, sessionId: id }])),
    sessionFor: (tabId: string) => sessions[tabId],
    ...extra,
  } as unknown as WorkspaceContext
}

describe('diff feedback tab targeting', () => {
  test('sends a fresh-session review to the newly created tab', async () => {
    const sourceComment = comment('source.ts')
    const sends: Array<{ prompt: string; tabId?: string }> = []
    const creates: Array<{ cwd?: string; options?: object }> = []
    const sourceGitContext = {
      branch: 'feature/review',
      targetBranch: 'main',
      repoRoot: '/repo',
    }
    const sessions = {
      active: session(),
      source: session({
        diffComments: [sourceComment],
        path: '/repo/worktree',
        git: sourceGitContext,
        serverId: 'source-host',
        project: { serverId: 'project-host', path: '/repo' },
      }),
      fresh: session(),
    }
    const ctx = workspace(sessions, {
      createTab: async (cwd?: string, options?: object) => {
        creates.push({ cwd, options })
        return 'fresh'
      },
      dispatch: {
        sendMessage(prompt: string, _cwd?: string, tabId?: string) {
          sends.push({ prompt, tabId })
        },
      },
    })

    expect(await submitDiffFeedbackToNewSession(ctx, {
      generalComment: '',
      filePath: 'source.ts',
      diffText: '',
      sourceTabId: 'source',
    })).toBe(true)
    expect(creates).toEqual([{
      cwd: '/repo/worktree',
      options: {
        gitContext: sourceGitContext,
        serverId: 'source-host',
        sourceId: 'source',
      },
    }])
    expect(checkoutPlace(sessions.fresh.run).path).toBe('/repo/worktree')
    expect(checkoutGit(sessions.fresh.run)).toEqual(sourceGitContext)
    expect(checkoutGit(sessions.fresh.run)).not.toBe(sourceGitContext)
    // Feedback on a dispatched session keeps its project home, and its tasks there.
    expect(projectHome(sessions.fresh.run)).toEqual({ serverId: 'project-host', path: '/repo' })
    expect(sessions.fresh.task).toEqual({ kind: 'none' })
    expect(sends[0]?.tabId).toBe('fresh')
    expect(sends[0]?.prompt).toContain('source.ts')
    expect(sessions.source.diffComments).toEqual([])
  })

  test('starts detached review feedback in the reviewed checkout and host', async () => {
    const sourceComment = comment('reviewed.ts')
    const creates: Array<{ cwd?: string; options?: object }> = []
    const sends: Array<{ prompt: string; tabId?: string }> = []
    const sessions = {
      active: session(),
      source: session({
        diffComments: [sourceComment],
        path: '/unrelated/source',
        serverId: 'source-host',
      }),
      fresh: session(),
    }
    const reviewedCheckout = {
      branch: null,
      detachedHeadSha: 'head-sha',
      targetBranch: 'base-sha',
      repoRoot: '/managed/pr',
      worktreePath: '/managed/pr',
    }
    const ctx = workspace(sessions, {
      createTab: async (cwd?: string, options?: object) => {
        creates.push({ cwd, options })
        return 'fresh'
      },
      dispatch: {
        sendMessage(prompt: string, _cwd?: string, tabId?: string) {
          sends.push({ prompt, tabId })
        },
      },
    })

    expect(await submitDiffFeedbackToNewSession(ctx, {
      generalComment: '',
      filePath: 'reviewed.ts',
      diffText: '',
      sourceTabId: 'source',
      sessionTarget: {
        workingDirectory: '/managed/pr',
        gitContext: reviewedCheckout,
        serverId: 'review-host',
      },
    })).toBe(true)
    expect(creates).toEqual([{
      cwd: '/managed/pr',
      options: {
        gitContext: reviewedCheckout,
        serverId: 'review-host',
        sourceId: 'source',
      },
    }])
    expect(checkoutPlace(sessions.fresh.run).path).toBe('/managed/pr')
    expect(checkoutGit(sessions.fresh.run)).toEqual(reviewedCheckout)
    expect(checkoutGit(sessions.fresh.run)).not.toBe(reviewedCheckout)
    expect(sends[0]?.tabId).toBe('fresh')
  })

  test('sends file-preview feedback to its source tab when another tab is active', () => {
    const sourceComment = comment('source.ts')
    const sends: Array<{ prompt: string; tabId?: string }> = []
    const sessions = {
      active: session(),
      source: session({ diffComments: [sourceComment] }),
    }
    const ctx = workspace(sessions, {
      dispatch: {
        sendMessage(prompt: string, _cwd?: string, tabId?: string) {
          sends.push({ prompt, tabId })
        },
      },
    })

    expect(submitDiffFeedback(ctx, '', 'source')).toBe(true)
    expect(sends[0]?.tabId).toBe('source')
    expect(sends[0]?.prompt).toContain('Keep this behavior.')
    expect(sessions.source.diffComments).toEqual([])
  })
})
