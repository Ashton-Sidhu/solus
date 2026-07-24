import { describe, expect, test } from 'bun:test'
import type { DiffComment } from '../../src/shared/types'
import { formatDiffInlineComments } from '../../src/renderer/contexts/workspace/session.utils'
import { findOpenTabForSession } from '../../src/renderer/lib/sessionUtils'

function diffComment(selectedCode: string): DiffComment {
  return {
    id: 'comment-1',
    filePath: 'src/example.ts',
    startLine: 10,
    endLine: 12,
    side: 'new',
    selectedCode,
    comment: 'Tighten this branch.',
    createdAt: 1,
  }
}

describe('formatDiffInlineComments', () => {
  test('does not add blank lines between selected code lines', () => {
    const formatted = formatDiffInlineComments([
      diffComment('const a = 1;\n\nconst b = 2;\n'),
    ])

    expect(formatted).toContain('```\nconst a = 1;\nconst b = 2;\n```')
  })

  test('preserves intentional blank lines in selected code', () => {
    const formatted = formatDiffInlineComments([
      diffComment('const a = 1;\n\n\n\nconst b = 2;\n'),
    ])

    expect(formatted).toContain('```\nconst a = 1;\n\nconst b = 2;\n```')
  })
})

describe('findOpenTabForSession', () => {
  test('reuses the existing tab for a session instead of opening a duplicate', () => {
    const tabs = {
      'tab-1': { id: 'tab-1', sessionId: 'local-session-1' },
    }
    const sessions = {
      'local-session-1': {
        agentSessionId: 'agent-session-1',
        provider: 'codex',
      },
    }

    expect(
      findOpenTabForSession(
        'agent-session-1',
        tabs as any,
        sessions as any,
        ['tab-1'],
        'codex',
      ),
    ).toBe('tab-1')
  })
})
