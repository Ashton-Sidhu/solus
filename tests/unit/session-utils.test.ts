import { describe, expect, test } from 'bun:test'
import type { DiffComment, Session, SessionStatus } from '../../src/shared/types'
import {
  computeCurrentActivity,
  formatDiffInlineComments,
} from '../../src/renderer/contexts/workspace/session.utils'
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

function activitySession(status: SessionStatus, agentSessionId: string | null): Session {
  return {
    status,
    agentSessionId,
    messages: [],
    currentActivity: '',
    permissionQueue: [],
    questionQueue: [],
    isStreamingText: false,
    isReconnecting: false,
  } as Session
}

describe('computeCurrentActivity', () => {
  test('reports the session startup lifecycle before falling back to thinking', () => {
    expect(computeCurrentActivity(activitySession('connecting', null))).toBe('Starting session...')
    expect(computeCurrentActivity(activitySession('connecting', 'session-1'))).toBe('Resuming...')
    expect(computeCurrentActivity(activitySession('running', 'session-1'))).toBe('Thinking...')
  })

  test('keeps an explicit startup phase after the transport reports running', () => {
    const session = activitySession('running', 'session-1')
    session.currentActivity = 'Connecting...'

    // WHY: session_init marks the transport running before the provider has
    // actually begun reasoning. The row must not jump to "Thinking" early.
    expect(computeCurrentActivity(session)).toBe('Connecting...')
  })
})

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
