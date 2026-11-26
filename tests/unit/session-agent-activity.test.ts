import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { agentActivityKind, agentActivityOfTool } from '@solus/contracts/agent-activity'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { BackendSession, NormalizedEvent, SessionStatus } from '@solus/contracts/types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import { Turns } from '@solus/server/execution/sessions/turns'
import { ACTIVITY_WINDOW_MS, SessionActivity, type ActivityClock } from '@solus/server/execution/sessions/session-activity'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let SessionStatuses: typeof import('@solus/server/execution/sessions/session-statuses')['SessionStatuses']
beforeAll(async () => {
  ;({ SessionStatuses } = await import('@solus/server/execution/sessions/session-statuses'))
})

type ActivityEvent = HostEventMap['session.activityChanged']

/** A clock the test moves by hand: a timer runs only when the time passes it. */
function manualClock() {
  let now = 1_000
  let nextId = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: ActivityClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++nextId
      timers.set(id, { at: now + ms, run })
      // SAFETY: the class only hands the value back to clearTimeout below.
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number) },
  }
  function advance(ms: number) {
    now += ms
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue
      timers.delete(id)
      timer.run()
    }
  }
  return { clock, advance, pending: () => timers.size }
}

function tracker() {
  const sent: ActivityEvent[] = []
  const time = manualClock()
  const activity = new SessionActivity((event) => sent.push(event), time.clock)
  return { sent, activity, ...time, activities: () => sent.map((event) => event.activity) }
}

const thinking: NormalizedEvent = { type: 'thinking', state: 'start' }
const reading: NormalizedEvent = { type: 'tool_call', toolName: 'Read', toolId: 't1', index: 0 }
const editing: NormalizedEvent = { type: 'tool_call', toolName: 'Edit', toolId: 't2', index: 0 }
const running: NormalizedEvent = { type: 'tool_call', toolName: 'exec_command', toolId: 't3', index: 0 }
const replying: NormalizedEvent = { type: 'text_chunk', text: 'Done.' }
const settled: NormalizedEvent = { type: 'turn_settled', turnId: 'turn-1', outcome: 'completed', settledAt: 0 }

// WHY: every row that shows a session's state marks reads what the agent does
// now from this one host fact. A wrong or noisy fact makes every surface lie,
// or makes the status consumers run many times for each turn.
describe('the agent activity of a session', () => {
  test('follows the top-level events of a turn, one event for each change', () => {
    const { activity, activities, advance } = tracker()
    for (const event of [thinking, reading, editing, running, replying, settled]) {
      activity.observe('s1', event)
      advance(ACTIVITY_WINDOW_MS)
    }
    expect(activities()).toEqual(['think', 'read', 'edit', 'run', 'reply', null])
  })

  test('sends nothing when the event repeats the activity', () => {
    const { activity, sent, advance } = tracker()
    activity.observe('s1', reading)
    advance(ACTIVITY_WINDOW_MS)
    activity.observe('s1', { ...reading, toolId: 't9' })
    activity.observe('s1', { type: 'thinking', state: 'stop' })
    advance(ACTIVITY_WINDOW_MS)
    expect(sent).toHaveLength(1)
  })

  test('ignores the events of a sub-agent', () => {
    const { activity, activities, advance } = tracker()
    activity.observe('s1', thinking)
    advance(ACTIVITY_WINDOW_MS)
    activity.observe('s1', { ...editing, parentToolUseId: 'agent-1' })
    activity.observe('s1', { type: 'text_chunk', text: 'sub', parentToolUseId: 'agent-1' })
    advance(ACTIVITY_WINDOW_MS)
    expect(activities()).toEqual(['think'])
  })

  test('a question is not an activity: the Input state shows it', () => {
    const { activity, activities, advance } = tracker()
    activity.observe('s1', reading)
    advance(ACTIVITY_WINDOW_MS)
    activity.observe('s1', { type: 'tool_call', toolName: 'AskUserQuestion', toolId: 'q', index: 0 })
    activity.observe('s1', { type: 'tool_call', toolName: 'request_user_input', toolId: 'q2', index: 0 })
    advance(ACTIVITY_WINDOW_MS)
    expect(activities()).toEqual(['read'])
  })

  test('sends at most one event in each window, and the newest change at its end', () => {
    const { activity, sent, advance } = tracker()
    activity.observe('s1', thinking)
    activity.observe('s1', reading)
    activity.observe('s1', editing)
    expect(sent.map((event) => event.activity)).toEqual(['think'])
    advance(ACTIVITY_WINDOW_MS - 1)
    expect(sent).toHaveLength(1)
    advance(1)
    expect(sent.map((event) => [event.activity, event.at])).toEqual([['think', 1_000], ['edit', 1_250]])
  })

  test('a change undone inside the window sends nothing', () => {
    const { activity, activities, advance, pending } = tracker()
    activity.observe('s1', thinking)
    activity.observe('s1', reading)
    activity.observe('s1', thinking)
    advance(ACTIVITY_WINDOW_MS)
    expect(activities()).toEqual(['think'])
    expect(pending()).toBe(0)
  })

  test('the settle of a turn clears the activity, and the next turn starts at once', () => {
    const { activity, activities, advance } = tracker()
    activity.observe('s1', running)
    activity.observe('s1', settled)
    expect(activities()).toEqual(['run'])
    advance(ACTIVITY_WINDOW_MS)
    expect(activities()).toEqual(['run', null])
    activity.observe('s1', thinking)
    expect(activities()).toEqual(['run', null, 'think'])
  })

  test('a settle with nothing sent before it sends nothing', () => {
    const { activity, sent } = tracker()
    activity.observe('s1', settled)
    expect(sent).toEqual([])
  })

  test('keeps each session apart', () => {
    const { activity, sent } = tracker()
    activity.observe('s1', thinking)
    activity.observe('s2', reading)
    expect(sent.map((event) => [event.sessionId, event.activity])).toEqual([['s1', 'think'], ['s2', 'read']])
  })
})

// WHY: the transcript summary and the state marks name the same kinds. A tool
// that a provider names and the map misses shows as Working, not as what it is.
describe('the kind of a tool', () => {
  test('knows the Claude tools', () => {
    expect(['Read', 'Grep', 'Glob', 'WebFetch', 'Edit', 'Write', 'Bash'].map(agentActivityKind))
      .toEqual(['read', 'search', 'search', 'search', 'edit', 'edit', 'run'])
  })

  test('knows the names the Codex normalizer gives', () => {
    // codexToolNameForItem: commandExecution, fileChange, webSearch.
    expect(['exec_command', 'Edit', 'WebSearch'].map(agentActivityKind)).toEqual(['run', 'edit', 'search'])
  })

  test('a question tool of either provider is asking, and has no agent activity', () => {
    expect(agentActivityKind('AskUserQuestion')).toBe('ask')
    expect(agentActivityKind('solus.request_user_input')).toBe('ask')
    expect(agentActivityOfTool('AskUserQuestion')).toBeNull()
  })

  test('an MCP, sub-agent, or unknown tool is other, also for a name the object prototype has', () => {
    expect(['mcp__linear__create_issue', 'solus.charts__chart', 'spawnAgent', 'ImageGeneration', 'constructor', undefined].map(agentActivityKind))
      .toEqual(['other', 'other', 'other', 'other', 'other', 'other'])
  })
})

// WHY: a row with no open tab knows only the status feed. Approval and Input
// are different states with different glyphs, so the feed must say which one waits.
describe('the approval fact on the status feed', () => {
  const permission = { type: 'permission_request', questionId: 'p1', toolName: 'Bash', options: [] } as unknown as NormalizedEvent
  const question = { type: 'question_request', questionId: 'q1', questions: [] } as unknown as NormalizedEvent

  function statusFeed(session: BackendSession) {
    const feed: Array<{ channel: string; event: HostEventMap['session.statusChanged'] }> = []
    const turns = new Turns()
    turns.begin(session.sessionId, { phase: 'running' })
    const runtime = {
      activeSessions: new Map([[session.sessionId, session]]),
      turns,
      isShuttingDown: false,
      restarts: { restartRuns: undefined },
      rateLimitPark: { rateLimits: { peek: () => null } },
      activeUnattendedAgentRuns: new Set(),
      hasWorkForUpdate: () => false,
      emit: (channel: string, event: HostEventMap['session.statusChanged']) => {
        if (channel === 'session-status' || channel === 'session-question') feed.push({ channel, event })
      },
      publish: () => {},
    }
    // SAFETY: a session with no provider thread id reads only the members above.
    return { statuses: new SessionStatuses(runtime as unknown as SessionRuntime), feed }
  }

  function session(sessionId: string, status: SessionStatus, pendingInputEvents: NormalizedEvent[]): BackendSession {
    return {
      sessionId, agentSessionId: null, backendId: 'claude-code', status,
      pendingInputEvents, hasPendingInput: pendingInputEvents.length > 0, lastActivityAt: 0, promptCount: 1,
    } as BackendSession
  }

  test('says a permission request waits', () => {
    const { statuses, feed } = statusFeed(session('approval-1', 'running', [permission]))
    statuses.refresh('approval-1')
    expect(feed.at(-1)?.event).toMatchObject({ status: 'awaiting_input', awaitingApproval: true })
  })

  test('says nothing of approval when a question waits', () => {
    const { statuses, feed } = statusFeed(session('approval-2', 'running', [question]))
    statuses.refresh('approval-2')
    expect(feed.at(-1)?.event.status).toBe('awaiting_input')
    expect(feed.at(-1)?.event.awaitingApproval).toBeUndefined()
  })

  test('the newest waiting input decides, and a change without a new status still reaches the feed', () => {
    const pending: NormalizedEvent[] = [question]
    const { statuses, feed } = statusFeed(session('approval-3', 'running', pending))
    statuses.refresh('approval-3')
    pending.push(permission)
    statuses.refresh('approval-3')
    expect(feed.at(-1)).toMatchObject({ channel: 'session-question', event: { status: 'awaiting_input', awaitingApproval: true } })
  })

  test('the fact ends when the wait ends', () => {
    const pending: NormalizedEvent[] = [permission]
    const waiting = session('approval-4', 'running', pending)
    const { statuses, feed } = statusFeed(waiting)
    statuses.refresh('approval-4')
    pending.length = 0
    waiting.hasPendingInput = false
    statuses.refresh('approval-4')
    expect(feed.at(-1)?.event).toMatchObject({ status: 'running' })
    expect(feed.at(-1)?.event.awaitingApproval).toBeUndefined()
  })
})
