import { describe, expect, test } from 'bun:test'
import {
  HistorySessionOrder,
  SessionHistoryLoader,
  sortedDedupedHistorySessions,
} from '../../src/renderer/lib/sessionPickerHistory'
import { updateSessionHistoryStatus } from '../../src/renderer/contexts/workspace/session-history.store.svelte'
import { takeSessionScanBatch } from '../../src/main/server/session-scan'
import type { SessionMeta, SessionScanEvent } from '../../src/shared/types'

function session(index: number): SessionMeta {
  return {
    serverId: 'primary',
    provider: 'codex',
    sessionId: `session-${index}`,
    slug: null,
    firstMessage: `Session ${index}`,
    lastTimestamp: new Date(index * 1_000).toISOString(),
    size: index,
    cwd: '/repo',
    projectPath: '/repo',
    isWorktree: false,
  }
}

describe('session history loading', () => {
  test('a closed running session keeps receiving live status in picker history', () => {
    // WHY: closing a task unloads its tab, not its provider run. The history
    // row becomes the only place where the user can see that background state.
    const sessions = [session(1)]

    updateSessionHistoryStatus(sessions, 'primary', 'session-1', 'running')

    expect(sessions[0].status).toBe('running')
  })

  test('a status event updates only the matching host row', () => {
    // WHY: provider session ids can collide across hosts. A remote status event
    // must not change the same-id row from another machine.
    const primary = session(1)
    const remote = { ...session(1), serverId: 'laptop' }

    updateSessionHistoryStatus([primary, remote], 'laptop', 'session-1', 'running')

    expect(primary.status).toBeUndefined()
    expect(remote.status).toBe('running')
  })

  test('a bounded home load requests only the needed provider rows without opening a scan stream', async () => {
    const calls: unknown[][] = []
    let subscriptions = 0
    const loader = new SessionHistoryLoader({
      hostFor: () => ({
        serverId: 'primary',
        listSessions: (async (...args: unknown[]) => {
          calls.push(args)
          return [session(3), session(2), session(1)]
        }) as Window['solus']['listSessions'],
        onSessionScan: () => {
          subscriptions++
          return () => {}
        },
      }),
    })

    const result = await loader.load({
      sources: [{ id: '/repo', projectPath: '/repo' }],
      ctx: {} as never,
      onBatch: () => {},
      limitPerProvider: 3,
    })

    expect(result).toHaveLength(3)
    expect(subscriptions).toBe(0)
    expect(calls[0]?.[3]).toBeUndefined()
    expect(calls[0]?.[4]).toBe(3)
  })

  test('each source is scanned on its own host and its rows say which one', async () => {
    // WHY: a session lives on the machine it was created on. If a remote row
    // arrived unstamped, resuming it would start the session on this client's
    // host instead — a different machine, a different checkout.
    const scanned: { serverId: string | undefined; projectPath: unknown }[] = []
    const loader = new SessionHistoryLoader({
      hostFor: (serverId) => ({
        serverId: serverId ?? 'primary',
        listSessions: (async (projectPath: unknown) => {
          scanned.push({ serverId, projectPath })
          return [session(1)]
        }) as Window['solus']['listSessions'],
        onSessionScan: () => () => {},
      }),
    })

    const result = await loader.load({
      sources: [
        { id: '/repo', projectPath: '/repo' },
        { id: 'laptop:/home/me/repo', serverId: 'laptop', projectPath: '/home/me/repo' },
      ],
      ctx: {} as never,
      onBatch: () => {},
    })

    expect(scanned).toEqual([
      { serverId: undefined, projectPath: '/repo' },
      { serverId: 'laptop', projectPath: '/home/me/repo' },
    ])
    // One session id, two hosts, two rows — collapsing them would hide one.
    expect(result).toHaveLength(2)
    expect(new Set(result.map((meta) => meta.serverId))).toEqual(new Set(['primary', 'laptop']))
  })

  test('a host discovered mid-scan joins it, and one that never answers costs nothing', async () => {
    // WHY: resolving which remote hosts hold this project takes a round trip.
    // Waiting for it before scanning would make every picker open as slow as
    // the sleepiest saved machine.
    const scanned: (string | undefined)[] = []
    const loader = new SessionHistoryLoader({
      hostFor: (serverId) => ({
        serverId: serverId ?? 'primary',
        listSessions: (async () => {
          scanned.push(serverId)
          return [session(1)]
        }) as Window['solus']['listSessions'],
        onSessionScan: () => () => {},
      }),
    })

    const joined = await loader.load({
      sources: [{ id: '/repo', projectPath: '/repo' }],
      deferredSources: Promise.resolve([
        { id: 'laptop:/home/me/repo', serverId: 'laptop', projectPath: '/home/me/repo' },
      ]),
      ctx: {} as never,
      onBatch: () => {},
    })
    expect(scanned).toEqual([undefined, 'laptop'])
    expect(joined).toHaveLength(2)

    scanned.length = 0
    const survived = await loader.load({
      sources: [{ id: '/repo', projectPath: '/repo' }],
      deferredSources: Promise.reject(new Error('every saved host is asleep')),
      ctx: {} as never,
      onBatch: () => {},
    })
    expect(scanned).toEqual([undefined])
    expect(survived).toHaveLength(1)
  })

  test('a streamed batch is stamped with the host whose stream carried it', async () => {
    // WHY: rows land through the scan event stream long before the request
    // resolves. An unstamped batch would let the user click a remote session
    // during the exact window in which the picker is most useful.
    const listeners = new Map<string | undefined, (event: SessionScanEvent) => void>()
    const batches: SessionMeta[] = []
    const loader = new SessionHistoryLoader({
      hostFor: (serverId) => ({
        serverId: serverId ?? 'primary',
        listSessions: (async (
          _projectPath: unknown,
          _ctx: unknown,
          _provider: unknown,
          streamId: string,
        ) => {
          listeners.get(serverId)?.({ streamId, type: 'batch', sessions: [session(1)] })
          return []
        }) as unknown as Window['solus']['listSessions'],
        onSessionScan: (listener) => {
          listeners.set(serverId, listener)
          return () => listeners.delete(serverId)
        },
      }),
    })

    await loader.load({
      sources: [{ id: 'laptop:/home/me/repo', serverId: 'laptop', projectPath: '/home/me/repo' }],
      ctx: {} as never,
      onBatch: (sessions) => batches.push(...sessions),
    })

    expect(batches.map((meta) => meta.serverId)).toEqual(['laptop'])
  })

  test('a streamed scan lands the same list a single sorted result would', () => {
    // WHY: the picker reads this list directly, so folding batches in one at a
    // time must not change what it shows.
    const batches = [[session(3), session(7)], [session(5)], [session(1), session(9)]]
    const streamed: SessionMeta[] = []
    const order = new HistorySessionOrder()
    for (const batch of batches) order.insert(streamed, batch)

    expect(streamed).toEqual(sortedDedupedHistorySessions(batches.flat()))
  })

  test('a batch is spliced into the live list rather than rebuilding it', () => {
    // WHY: a project with thousands of sessions arrives in a hundred-odd
    // batches, into reactive state the picker's whole derived chain reads.
    // Handing it a new array per batch re-sorts and re-proxies every row.
    const streamed: SessionMeta[] = [session(2)]
    const order = new HistorySessionOrder()
    order.reset(streamed)

    order.insert(streamed, [session(4)])
    order.insert(streamed, [session(1)])

    expect(streamed.map((meta) => meta.sessionId)).toEqual(
      ['session-4', 'session-2', 'session-1'],
    )
  })

  test('a newer row for a listed session moves it, an older restream is ignored', () => {
    // WHY: two hosts can answer for the same session, and a scan can restream a
    // row that has since been used. It must show once, where its newest
    // timestamp puts it — a stale copy must not drag it back down the list.
    const streamed: SessionMeta[] = []
    const order = new HistorySessionOrder()

    order.insert(streamed, [session(4), session(2), session(1)])
    order.insert(streamed, [{ ...session(1), lastTimestamp: new Date(9_000).toISOString() }])
    order.insert(streamed, [{ ...session(4), lastTimestamp: new Date(1_000).toISOString() }])

    expect(streamed.map((meta) => meta.sessionId)).toEqual(
      ['session-1', 'session-4', 'session-2'],
    )
    expect(streamed.map((meta) => meta.lastTimestamp)).toEqual(
      [new Date(9_000).toISOString(), new Date(4_000).toISOString(), new Date(2_000).toISOString()],
    )
  })

  test('a full scan splits an oversized provider result into bounded batches', () => {
    const buffer = Array.from({ length: 45 }, (_, index) => session(index))
    const batches: SessionMeta[][] = []
    while (buffer.length > 0) batches.push(takeSessionScanBatch(buffer, 20))

    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5])
    expect(buffer).toEqual([])
  })
})
