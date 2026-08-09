import { describe, expect, test } from 'bun:test'
import {
  addDiffComment,
  submitDiffFeedback,
  submitDiffFeedbackToNewSession,
} from '../../src/renderer/contexts/workspace/session-diff-feedback'
import type { WorkspaceContext } from '../../src/renderer/contexts/workspace/workspace.context.svelte'
import type { DiffComment } from '../../src/shared/types'

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

function session(overrides: Partial<{ diffComments: DiffComment[]; diffGeneralComment: string; workingDirectory: string }> = {}) {
  return {
    diffComments: overrides.diffComments ?? [],
    diffCommentDraft: null,
    diffGeneralComment: overrides.diffGeneralComment ?? '',
    run: { workingDirectory: overrides.workingDirectory ?? '', gitContext: null },
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
    const sessions = {
      active: session(),
      source: session({ diffComments: [sourceComment], workingDirectory: '/repo' }),
      fresh: session(),
    }
    const ctx = workspace(sessions, {
      createTab: async () => 'fresh',
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
    expect(sessions.fresh.run.workingDirectory).toBe('/repo')
    expect(sends[0]?.tabId).toBe('fresh')
    expect(sends[0]?.prompt).toContain('source.ts')
    expect(sessions.source.diffComments).toEqual([])
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
