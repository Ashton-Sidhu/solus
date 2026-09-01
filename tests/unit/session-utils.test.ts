import { describe, expect, test } from 'bun:test'
import type { TaskSessionLink } from '@solus/contracts/task-types'
import type { DiffComment, Session, SessionStatus } from '@solus/contracts/types'
import {
  computeCurrentActivity,
  formatDiffInlineComments,
} from '@solus/workspace-ui/contexts/workspace/session.utils'
import {
  attemptServerId,
  findOpenTabForSession,
  getStatusLabel,
  sessionDisplayName,
} from '@solus/workspace-ui/lib/sessionUtils'

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
  const tabs = {
    'tab-1': { id: 'tab-1', sessionId: 'local-session-1' },
  }
  const sessions = {
    'local-session-1': {
      agentSessionId: 'agent-session-1',
      run: { provider: 'codex', serverId: 'host-a' },
    },
  }

  test('reuses the existing tab for a host-scoped provider session', () => {
    expect(
      findOpenTabForSession(
        'agent-session-1',
        tabs as any,
        sessions as any,
        ['tab-1'],
        'codex',
        'host-a',
      ),
    ).toBe('tab-1')
  })

  test('a provider id never matches without its host, or with the wrong one', () => {
    // WHY: dispatch-client step 1 — provider ids are host-minted and collide
    // across hosts (the same repo, cloned twice). A bare provider id must not
    // steal another host's tab.
    expect(
      findOpenTabForSession('agent-session-1', tabs as any, sessions as any, ['tab-1'], 'codex'),
    ).toBeNull()
    expect(
      findOpenTabForSession('agent-session-1', tabs as any, sessions as any, ['tab-1'], 'codex', 'host-b'),
    ).toBeNull()
  })

  test('our own session id still matches hostless — it is client-minted', () => {
    expect(
      findOpenTabForSession('local-session-1', tabs as any, sessions as any, ['tab-1']),
    ).toBe('tab-1')
  })
})

describe('sessionDisplayName', () => {
  const link = (overrides: Partial<TaskSessionLink> = {}): TaskSessionLink => ({
    sessionId: 'e1dbb2b0-3c2f-4f7a-9a51-0c4a1f2b7d33',
    sessionTitle: null,
    provider: null,
    startedAt: null,
    lastActivityAt: null,
    linkedAt: 1,
    ...overrides,
  })

  test('prefers the live title while the history index is catching up', () => {
    // WHY: a newly started attempt is mounted before its persisted session
    // metadata exists, but every surface must still show the title the user
    // already sees on the tab.
    expect(sessionDisplayName({
      link: link({ sessionTitle: 'Indexed name' }),
      liveTitle: 'Fix task labels',
    })).toBe('Fix task labels')
  })

  test('names a closed attempt from the metadata joined onto its link', () => {
    // WHY: this is the whole reason links carry session metadata — an attempt
    // with no mounted tab is the common case on a task opened from history.
    expect(sessionDisplayName({
      link: link({ sessionTitle: 'Indexed session name' }),
      taskTitle: 'Owning task',
    })).toBe('Indexed session name')
  })

  test('falls back to the owning task before it ever shows an id', () => {
    // WHY: session_init and provider-history indexing are independent, and
    // their brief race must not expose a provider UUID anywhere in the UI.
    expect(sessionDisplayName({ link: link(), taskTitle: 'Fix task labels' }))
      .toBe('Fix task labels')
  })

  test('every surface answers identically for the same link', () => {
    // WHY: three surfaces each had their own fallback chain, so one missing
    // title produced three different wrong labels and read as three bugs.
    // One function is the point; this pins that they cannot drift again.
    const unnamed = link()
    expect(sessionDisplayName({ link: unnamed })).toBe('e1dbb2b0')
    expect(sessionDisplayName({ link: unnamed, liveTitle: '   ' }))
      .toBe('e1dbb2b0')
  })
})

describe('attemptServerId', () => {
  const link = (executionServerId: string | null): TaskSessionLink => ({
    sessionId: 'e1dbb2b0-3c2f-4f7a-9a51-0c4a1f2b7d33',
    sessionTitle: null,
    provider: null,
    startedAt: null,
    lastActivityAt: null,
    executionServerId,
    linkedAt: 1,
  })

  test('a dispatched attempt reports its execution host once its tab is closed', () => {
    // WHY: the link is written on the *task's* host while the agent runs
    // somewhere else, so the recorded host is the only thing that survives the
    // tab. Without it a closed dispatch is indistinguishable from a local run.
    expect(attemptServerId({ link: link('studio'), taskServerId: 'local' }))
      .toBe('studio')
  })

  test('an attempt that was never a dispatch answers with the task’s host', () => {
    // WHY: falling through to the reading client is the defect — a session on
    // another machine’s project ran there, not here, and nothing about opening
    // the task from this laptop changes that.
    expect(attemptServerId({ link: link(null), taskServerId: 'workshop' }))
      .toBe('workshop')
  })

  test('a mounted tab outranks both, since it knows its host outright', () => {
    // WHY: a session moved to another host mid-life would otherwise keep
    // reporting the host it was first linked from.
    expect(attemptServerId({
      link: link('studio'),
      liveServerId: 'workshop',
      taskServerId: 'local',
    })).toBe('workshop')
  })
})

describe('getStatusLabel', () => {
  test('names every status a picker row can be in except idle', () => {
    // WHY: the picker row no longer carries an "open tab" dot, so this label is
    // the only thing on the row that reports what a session is doing. A status
    // with no label would leave an active session looking like a dormant one.
    const active: SessionStatus[] = [
      'connecting',
      'running',
      'awaiting_input',
      'awaiting_plan',
      'rate_limited',
      'completed',
      'failed',
      'interrupted',
      'dead',
    ]

    expect(active.filter((status) => !getStatusLabel(status))).toEqual([])
    expect(getStatusLabel('idle')).toBeNull()
  })
})
