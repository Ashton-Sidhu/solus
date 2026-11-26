import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ProviderHistoryPage } from '@solus/contracts/session-history'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/session-open-latency.md: an opening read describes and watches the
// session while its page is read, so the open costs the slowest step, not the
// sum. The watch keeps its rules: none for a session with a run.

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
  const activeRunRequests = new Map<string, unknown>()
  const server = new serverModule.SolusServer()
  historyHandlers.registerHistoryHandlers(server, {
    // The fixture supplies the page read, the description, and the run lookups the open checks.
    sessionRuntime: {
      activeSessions: new Map(), activeRunRequests, launcher: { pendingSetupControllers: new Map() },
      history: {
        loadSessionPage: () => {
          started.push('page')
          return new Promise<ProviderHistoryPage>((resolve) => { releasePage = resolve })
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
    return { runtime: null }
  })
  const steps = async () => {
    // Let every step that does not wait for the page begin.
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve))
    return [...started].sort()
  }
  return { server, started, steps, activeRunRequests, release: (page: ProviderHistoryPage) => releasePage(page) }
}

test('an opening read describes and watches the session while its page is read', async () => {
  const host = hostWithSlowPage()
  const opened = host.server.handle('loadSessionPage', [opening], ctx)
  expect(await host.steps()).toEqual(['describe', 'page', 'watch'])
  host.release({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }], before: null })
  expect(await opened).toMatchObject({
    messages: [{ role: 'user', content: 'hello' }],
    openingDescription: { lineage: null, meta: null },
    resumedWatch: { runtime: null },
  })
})

test('an opening read of a session with a run describes it and leaves the watch to the client', async () => {
  const host = hostWithSlowPage()
  host.activeRunRequests.set('resting', {})
  const opened = host.server.handle('loadSessionPage', [opening], ctx)
  expect(await host.steps()).toEqual(['describe', 'page'])
  host.release({ messages: [], before: null })
  const page = await opened
  expect(page.openingDescription).toEqual({ lineage: null, meta: null })
  expect(page.resumedWatch).toBeUndefined()
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
