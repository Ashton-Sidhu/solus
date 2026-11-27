import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ProviderHistoryPage } from '@solus/contracts/session-history'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/session-open-latency.md: an opening read describes the session
// while its page is read, so the open costs the slowest step, not the sum.
// docs/plans/running-turn-open.md: the watch joins first and the page is read
// after it, leaving out the turn the watch replays, so a running session opens
// with each row once.

type Principal = import('@solus/server/admission/principal').Principal

const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-open-parallel-'))
let serverModule: typeof import('@solus/server/transport/server')
let historyHandlers: typeof import('@solus/server/transport/handlers/history-handlers')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  serverModule = await import('@solus/server/transport/server')
  historyHandlers = await import('@solus/server/transport/handlers/history-handlers')
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Phone' }
const ctx = { clientId: 'phone', principal: OWNER }
const opening = { sessionId: 'resting', provider: 'claude-code' as const, turnLimit: 5, knownHistoryBlocks: [], openSession: true }

/** A host whose page read waits until the test releases it. */
function hostWithSlowPage() {
  const started: string[] = []
  let releasePage!: (page: ProviderHistoryPage) => void
  let failPage!: (error: Error) => void
  const unwatched: string[] = []
  const pageTurns: Array<number | null | undefined> = []
  const activeRunRequests = new Map<string, unknown>()
  let replayedTurn: number | undefined
  const server = new serverModule.SolusServer()
  historyHandlers.registerHistoryHandlers(server, {
    // The fixture supplies the page read, the description, and the run lookups the open checks.
    sessionRuntime: {
      hasRun: (sessionId: string) => activeRunRequests.has(sessionId),
      runningTurnStartedAt: () => undefined,
      history: {
        loadSessionPage: (_request: unknown, _profile: unknown, runningTurnStartedAt?: number | null) => {
          started.push('page')
          pageTurns.push(runningTurnStartedAt)
          return new Promise<ProviderHistoryPage>((resolve, reject) => { releasePage = resolve; failPage = reject })
        },
        describeSession: async () => {
          started.push('describe')
          return { lineage: null, meta: null }
        },
      },
    } as never as SessionRuntime,
    events: {} as HostEventPublisher,
    agentIdFromContext: () => 'claude-code',
    exchangeProgress: () => undefined,
  })
  server.register('watchSession', ([input], caller) => {
    expect(caller.clientId).toBe(ctx.clientId)
    expect(input).toEqual({ sessionId: 'resting', attachRuntime: true })
    started.push('watch')
    return replayedTurn === undefined ? { runtime: null } : { runtime: null, runningTurnStartedAt: replayedTurn }
  })
  server.register('unwatchSession', ([sessionId], caller) => {
    expect(caller.clientId).toBe(ctx.clientId)
    unwatched.push(sessionId)
  })
  const steps = async () => {
    // Let every step that does not wait for the page begin.
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve))
    return [...started].sort()
  }
  return { server, started, unwatched, pageTurns, steps, activeRunRequests, replays: (startedAt: number) => { replayedTurn = startedAt }, release: (page: ProviderHistoryPage) => releasePage(page), fail: (error: Error) => failPage(error) }
}

test('an opening read describes the session while its page is read, and watches it first', async () => {
  const host = hostWithSlowPage()
  const opened = host.server.handle('loadSessionPage', [opening], ctx)
  expect(await host.steps()).toEqual(['describe', 'page', 'watch'])
  expect(host.started.indexOf('watch')).toBeLessThan(host.started.indexOf('page'))
  // No turn was replayed: the page leaves nothing out.
  expect(host.pageTurns).toEqual([null])
  host.release({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }], before: null })
  expect(await opened).toMatchObject({
    messages: [{ role: 'user', content: 'hello' }],
    openingDescription: { lineage: null, meta: null },
    resumedWatch: { runtime: null },
  })
})

test('an opening read of a running session leaves out the very turn its watch replayed', async () => {
  const host = hostWithSlowPage()
  host.activeRunRequests.set('resting', {})
  host.replays(1_000)
  const opened = host.server.handle('loadSessionPage', [opening], ctx)
  expect(await host.steps()).toEqual(['describe', 'page', 'watch'])
  expect(host.pageTurns).toEqual([1_000])
  host.release({ messages: [], before: null, runningTurnStartedAt: 1_000 })
  const page = await opened
  expect(page.openingDescription).toEqual({ lineage: null, meta: null })
  expect(page.resumedWatch).toEqual({ runtime: null, runningTurnStartedAt: 1_000 })
  expect(page.runningTurnStartedAt).toBe(1_000)
})

test('a jump of an opening read to an entry neither describes nor watches', async () => {
  const host = hostWithSlowPage()
  const opened = host.server.handle('loadSessionPage', [{ ...opening, throughEntryId: 'entry-1' }], ctx)
  expect(await host.steps()).toEqual(['page'])
  host.release({ messages: [], before: null })
  const page = await opened
  expect(page.openingDescription).toBeUndefined()
  expect(page.resumedWatch).toBeUndefined()
})

test('an opening read whose page fails removes the watch it started', async () => {
  const host = hostWithSlowPage()
  const opened = host.server.handle('loadSessionPage', [opening], ctx)
  expect(await host.steps()).toEqual(['describe', 'page', 'watch'])
  host.fail(new Error('provider file unreadable'))
  await expect(opened).rejects.toThrow('provider file unreadable')
  // The client shows an error and opens the session again; it must not keep receiving its events meanwhile.
  expect(host.unwatched).toEqual(['resting'])
})
