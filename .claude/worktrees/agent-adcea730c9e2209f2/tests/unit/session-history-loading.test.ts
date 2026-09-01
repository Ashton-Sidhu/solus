import { describe, expect, test } from 'bun:test'
import { SessionHistoryLoader } from '../../src/renderer/lib/sessionPickerHistory'
import { takeSessionScanBatch } from '../../src/main/server/session-scan'
import type { SessionMeta } from '../../src/shared/types'

function session(index: number): SessionMeta {
  return {
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
  test('a bounded home load requests only the needed provider rows without opening a scan stream', async () => {
    const calls: unknown[][] = []
    let subscriptions = 0
    const loader = new SessionHistoryLoader({
      listSessions: (async (...args: unknown[]) => {
        calls.push(args)
        return [session(3), session(2), session(1)]
      }) as Window['solus']['listSessions'],
      onSessionScan: (() => {
        subscriptions++
        return () => {}
      }) as Window['solus']['onSessionScan'],
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

  test('a full scan splits an oversized provider result into bounded batches', () => {
    const buffer = Array.from({ length: 45 }, (_, index) => session(index))
    const batches: SessionMeta[][] = []
    while (buffer.length > 0) batches.push(takeSessionScanBatch(buffer, 20))

    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5])
    expect(buffer).toEqual([])
  })
})
