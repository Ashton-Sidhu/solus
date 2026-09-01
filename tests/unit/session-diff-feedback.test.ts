import { describe, expect, test } from 'bun:test'
import {
  addDiffComment,
  submitDiffFeedback,
  submitDiffFeedbackToNewSession,
} from '@solus/workspace-ui/contexts/workspace/session-diff-feedback'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { DiffComment } from '@solus/contracts/types'

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
  workingDirectory: string
  gitContext: { branch: string | null; targetBranch: string; repoRoot?: string } | null
  serverId: string
  taskServerId: string
  projectGroupPath: string | null
}> = {}) {
  return {
    diffComments: overrides.diffComments ?? [],
    diffCommentDraft: null,
    diffGeneralComment: overrides.diffGeneralComment ?? '',
    task: { kind: 'new' as const },
    run: {
      workingDirectory: overrides.workingDirectory ?? '',
      gitContext: overrides.gitContext ?? null,
      serverId: overrides.serverId ?? 'host',
      taskServerId: overrides.taskServerId ?? 'task-host',
      projectGroupPath: overrides.projectGroupPath ?? null,
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
  test('stores a file-pane comment against the requested tab’s session, not the active one', () => {
    const activeComment = comment('active.ts')
    const sourceComment = comment('source.ts')
    const sessions = {
      active: session({ diffComments: [activeComment] }),
      source: session({ diffGeneralComment: 'note' }),
    }

    addDiffComment(workspace(sessions), sourceComment, 'source')

    expect(sessions.active.diffComments).toEqual([activeComment])
    expect(sessions.source.diffComments).toEqual([sourceComment])
  })

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
        workingDirectory: '/repo/worktree',
        gitContext: sourceGitContext,
        serverId: 'source-host',
        taskServerId: 'project-host',
        projectGroupPath: '/repo',
      }),
      fresh: session(),
    }
    const ctx = workspace(sessions, {
      createTab: async (cwd?: string, options?: object) => {
        creates.push({ cwd, options })
        return 'fresh'
      },
      sendMessage(prompt: string, _cwd?: string, tabId?: string) {
        sends.push({ prompt, tabId })
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
        sourceTabId: 'source',
      },
    }])
    expect(sessions.fresh.run.workingDirectory).toBe('/repo/worktree')
    expect(sessions.fresh.run.gitContext).toEqual(sourceGitContext)
    expect(sessions.fresh.run.gitContext).not.toBe(sourceGitContext)
    expect(sessions.fresh.run.taskServerId).toBe('project-host')
    expect(sessions.fresh.run.projectGroupPath).toBe('/repo')
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
        workingDirectory: '/unrelated/source',
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
      sendMessage(prompt: string, _cwd?: string, tabId?: string) {
        sends.push({ prompt, tabId })
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
        sourceTabId: 'source',
      },
    }])
    expect(sessions.fresh.run.workingDirectory).toBe('/managed/pr')
    expect(sessions.fresh.run.gitContext).toEqual(reviewedCheckout)
    expect(sessions.fresh.run.gitContext).not.toBe(reviewedCheckout)
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
      sendMessage(prompt: string, _cwd?: string, tabId?: string) {
        sends.push({ prompt, tabId })
      },
    })

    expect(submitDiffFeedback(ctx, '', 'source')).toBe(true)
    expect(sends[0]?.tabId).toBe('source')
    expect(sends[0]?.prompt).toContain('Keep this behavior.')
    expect(sessions.source.diffComments).toEqual([])
  })
})
