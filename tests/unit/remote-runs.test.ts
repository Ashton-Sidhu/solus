import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import type { RemoteHost } from '@solus/server/execution/orchestration/remote-hosts'
import { followRemoteRun, type RunHooks } from '@solus/server/execution/orchestration/remote-runs'
import type { RunExchanges, SettledRun } from '@solus/server/execution/orchestration/session-orchestrator'
import type { ResolvedInput } from '@solus/server/execution/orchestration/session-outputs'

// WHY: a session an agent starts on another host must behave for its sender
// like a local child (docs/plans/cross-host-sessions.md §5.4). Host B's events
// drive the same run hooks a local run calls, so the card, notices, waits and
// report need no second implementation. The watch comes before the start, or a
// child that ends at once is never heard; a follow that ended hears nothing more.

const SESSION = 'child-on-b'
const RUN: RunExchanges = { runId: 'remote:m1', sessionId: SESSION, exchangeIds: ['m1'] }

interface Calls {
  watched: string[]
  unwatched: string[]
  started: RunExchanges[]
  requested: string[]
  resolved: ResolvedInput[]
  events: string[]
  settled: SettledRun[]
}

function remoteHost() {
  const events = new HostEventSubscriber()
  const reconnects = new Set<() => void>()
  const calls: Calls = { watched: [], unwatched: [], started: [], requested: [], resolved: [], events: [], settled: [] }
  const api = {
    watchSession: async (input: { sessionId: string }) => { calls.watched.push(input.sessionId); return {} },
    unwatchSession: async (sessionId: string) => { calls.unwatched.push(sessionId) },
  }
  const host: RemoteHost = {
    hostId: 'host-b', installationId: 'install-b', label: 'Host B',
    // SAFETY: the follow calls only the two watch methods above.
    api: api as unknown as HostApi,
    events,
    onReconnected: (listener) => { reconnects.add(listener); return () => { reconnects.delete(listener) } },
    call: (_what, request) => request(),
  }
  const hooks: RunHooks = {
    runStarted: (run) => { calls.started.push(run) },
    inputRequested: (_run, event) => { calls.requested.push(event.type) },
    inputResolved: (_run, resolved) => { calls.resolved.push(resolved) },
    runEvent: (_run, event) => { calls.events.push(event.type) },
    runSettled: (run) => { calls.settled.push(run) },
  }
  const emit = (event: WireNormalizedEvent, sessionId = SESSION) =>
    events.receive({ type: 'session.eventReceived', payload: { sessionId, event }, occurredAt: Date.now() })
  const reconnect = () => { for (const listener of reconnects) listener() }
  return { host, hooks, calls, emit, reconnect }
}

describe('a run followed on another host', () => {
  test('is watched before the caller starts the session', async () => {
    const { host, hooks, calls } = remoteHost()
    const follow = followRemoteRun(host, RUN, 'claude-code', hooks)
    await follow.watching
    expect(calls.watched).toEqual([SESSION])
  })

  test('drives the hooks a local run calls, and settles with the reply host B reported', async () => {
    const { host, hooks, calls, emit } = remoteHost()
    await followRemoteRun(host, RUN, 'codex', hooks).watching
    emit({ type: 'status_change', status: 'running', oldStatus: 'idle' })
    emit({ type: 'permission_request', questionId: 'q1', toolName: 'Bash', options: [] })
    emit({ type: 'permission_resolved', questionId: 'q1', decision: 'denied' })
    emit({ type: 'work_created', workId: 'w1', title: 'Notes', docType: 'doc', content: '' })
    emit({ type: 'task_complete', result: 'Done on B.', costUsd: 0, durationMs: 42, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0 }, sessionId: 'thread' } as WireNormalizedEvent)
    emit({ type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 1 })

    expect(calls.started).toEqual([RUN])
    expect(calls.requested).toEqual(['permission_request'])
    expect(calls.resolved).toEqual([{ kind: 'permission', toolName: 'Bash', allowed: false }])
    expect(calls.events).toEqual(['work_created'])
    expect(calls.settled).toEqual([{ ...RUN, outcome: 'completed', resultText: 'Done on B.', durationMs: 42, provider: 'codex' }])
    expect(calls.unwatched).toEqual([SESSION])
  })

  test('hears nothing after its turn settled', async () => {
    const { host, hooks, calls, emit } = remoteHost()
    await followRemoteRun(host, RUN, 'codex', hooks).watching
    emit({ type: 'turn_settled', turnId: 't1', outcome: 'interrupted', settledAt: 1 })
    emit({ type: 'turn_settled', turnId: 't2', outcome: 'completed', settledAt: 2 })
    expect(calls.settled.map((run) => run.outcome)).toEqual(['interrupted'])
  })

  test('ignores the events of other sessions on that host', async () => {
    const { host, hooks, calls, emit } = remoteHost()
    await followRemoteRun(host, RUN, 'codex', hooks).watching
    emit({ type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 1 }, 'another-session')
    expect(calls.settled).toEqual([])
  })

  test('reports a provider that died as a failed turn', async () => {
    const { host, hooks, calls, emit } = remoteHost()
    await followRemoteRun(host, RUN, 'codex', hooks).watching
    emit({ type: 'turn_settled', turnId: 't1', outcome: 'dead', settledAt: 1 })
    expect(calls.settled[0]?.outcome).toBe('failed')
  })

  test('watches again after a reconnect, and not after it was stopped', async () => {
    const { host, hooks, calls, reconnect } = remoteHost()
    const follow = followRemoteRun(host, RUN, 'codex', hooks)
    await follow.watching
    reconnect()
    await Promise.resolve()
    expect(calls.watched).toEqual([SESSION, SESSION])
    follow.stop()
    reconnect()
    await Promise.resolve()
    expect(calls.watched).toEqual([SESSION, SESSION])
    expect(calls.unwatched).toEqual([SESSION])
  })

  test('a message to a session in another turn follows only the turn that answers it', async () => {
    // WHY: a message to an existing session can arrive while it runs another
    // turn. That turn's questions and its end are not the message's: the
    // sender would get someone else's reply as its own.
    const { host, hooks, calls, emit } = remoteHost()
    await followRemoteRun(host, RUN, 'codex', hooks, 'm1').watching
    emit({ type: 'status_change', status: 'running', oldStatus: 'idle' })
    emit({ type: 'permission_request', questionId: 'q0', toolName: 'Bash', options: [] })
    emit({ type: 'turn_settled', turnId: 't0', outcome: 'completed', settledAt: 1 })
    expect(calls).toMatchObject({ started: [], requested: [], settled: [] })

    emit({ type: 'user_message', text: 'More work.', clientPromptId: 'm1' })
    emit({ type: 'status_change', status: 'running', oldStatus: 'idle' })
    emit({ type: 'task_complete', result: 'Done.', costUsd: 0, durationMs: 7, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0 }, sessionId: 'thread' } as WireNormalizedEvent)
    emit({ type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 2 })
    expect(calls.settled).toEqual([{ ...RUN, outcome: 'completed', resultText: 'Done.', durationMs: 7, provider: 'codex' }])
  })

  test('a queued message runs when host B takes it from the queue, and a dropped one settles as interrupted', async () => {
    const ran = remoteHost()
    const follow = followRemoteRun(ran.host, RUN, 'codex', ran.hooks, 'm1')
    await follow.watching
    follow.queuedAs('queue-1')
    ran.emit({ type: 'prompt_dequeued', queueId: 'queue-1' })
    ran.emit({ type: 'user_message', text: 'More work.', clientPromptId: 'm1' })
    ran.emit({ type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 1 })
    expect(ran.calls.settled.map((run) => run.outcome)).toEqual(['completed'])

    // A Stop on host B drains the queue: the prompt never runs, so the sender
    // must not wait for a turn that will not come.
    const dropped = remoteHost()
    const drained = followRemoteRun(dropped.host, RUN, 'codex', dropped.hooks, 'm1')
    await drained.watching
    drained.queuedAs('queue-1')
    dropped.emit({ type: 'prompt_dequeued', queueId: 'queue-1' })
    dropped.emit({ type: 'turn_settled', turnId: 't0', outcome: 'interrupted', settledAt: 1 })
    expect(dropped.calls.settled.map((run) => run.outcome)).toEqual(['interrupted'])
  })
})
