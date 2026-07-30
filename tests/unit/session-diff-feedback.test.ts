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

describe('diff feedback tab targeting', () => {
  test('stores a file-pane comment on the requested tab, not the active tab', () => {
    const activeComment = comment('active.ts')
    const sourceComment = comment('source.ts')
    const ctx = {
      activeTabId: 'active',
      tabs: {
        active: {
          diffComments: [activeComment],
          diffCommentDraft: null,
          diffGeneralComment: '',
        },
        source: {
          diffComments: [],
          diffCommentDraft: null,
          diffGeneralComment: 'note',
        },
      },
    } as unknown as WorkspaceContext

    addDiffComment(ctx, sourceComment, 'source')
    expect(ctx.tabs.active.diffComments).toEqual([activeComment])
    expect(ctx.tabs.source.diffComments).toEqual([sourceComment])
  })

  test('sends a fresh-session review to the newly created tab', async () => {
    const sourceComment = comment('source.ts')
    const sends: Array<{ prompt: string; tabId?: string }> = []
    const sessions = {
      source: { workingDirectory: '/repo', gitContext: null },
      fresh: { workingDirectory: '', gitContext: null },
    }
    const ctx = {
      activeTabId: 'active',
      tabs: {
        active: {
          diffComments: [],
          diffCommentDraft: null,
          diffGeneralComment: '',
        },
        source: {
          diffComments: [sourceComment],
          diffCommentDraft: null,
          diffGeneralComment: '',
        },
      },
      createTab: async () => 'fresh',
      sessionFor: (tabId: keyof typeof sessions) => sessions[tabId],
      sendMessage(prompt: string, _cwd?: string, tabId?: string) {
        sends.push({ prompt, tabId })
      },
    } as unknown as WorkspaceContext

    expect(await submitDiffFeedbackToNewSession(ctx, {
      generalComment: '',
      filePath: 'source.ts',
      diffText: '',
      sourceTabId: 'source',
    })).toBe(true)
    expect(sessions.fresh.workingDirectory).toBe('/repo')
    expect(sends[0]?.tabId).toBe('fresh')
    expect(sends[0]?.prompt).toContain('source.ts')
    expect(ctx.tabs.source.diffComments).toEqual([])
  })

  test('sends file-preview feedback to its source tab when another tab is active', () => {
    const sourceComment = comment('source.ts')
    const sends: Array<{ prompt: string; tabId?: string }> = []
    const ctx = {
      activeTabId: 'active',
      tabs: {
        active: {
          diffComments: [],
          diffCommentDraft: null,
          diffGeneralComment: '',
        },
        source: {
          diffComments: [sourceComment],
          diffCommentDraft: null,
          diffGeneralComment: '',
        },
      },
      sendMessage(prompt: string, _cwd?: string, tabId?: string) {
        sends.push({ prompt, tabId })
      },
    } as unknown as WorkspaceContext

    expect(submitDiffFeedback(ctx, '', 'source')).toBe(true)
    expect(sends[0]?.tabId).toBe('source')
    expect(sends[0]?.prompt).toContain('Keep this behavior.')
    expect(ctx.tabs.source.diffComments).toEqual([])
  })
})
