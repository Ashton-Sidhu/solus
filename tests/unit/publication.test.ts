import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import type { Publication } from '@solus/contracts/organization-scope'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { resetTestDatabase } from './helpers/test-db'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §7: a publication is the one recoverable
// operation that moves a Local work or session into one organization on the
// Solus API. It reserves the destination first, sends, waits for the service's
// receipt, and only then commits the record's new state. A failure keeps the
// row and its story and the local copy; a second destination is refused while
// one is on its way.

let publication: typeof import('@solus/server/sync/publication')
let delivery: typeof import('@solus/server/sync/runner-delivery')
let delegationsModule: typeof import('@solus/server/sync/delegations')
let transcriptMirrorModule: typeof import('@solus/server/sync/mirror/transcript-mirror')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let mirrorLog: typeof import('@solus/server/sync/mirror/mirror-log')
let records: typeof import('@solus/server/data/sessions/session-records')
let principal: typeof import('@solus/server/admission/principal')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-publication-'))
  process.env.SOLUS_DATA_DIR = dataDir
  publication = await import('@solus/server/sync/publication')
  delivery = await import('@solus/server/sync/runner-delivery')
  delegationsModule = await import('@solus/server/sync/delegations')
  transcriptMirrorModule = await import('@solus/server/sync/mirror/transcript-mirror')
  outbox = await import('@solus/server/sync/outbox/outbox-store')
  mirrorLog = await import('@solus/server/sync/mirror/mirror-log')
  records = await import('@solus/server/data/sessions/session-records')
  principal = await import('@solus/server/admission/principal')
  dbModule = await import('@solus/server/db')
  ;(await import('@solus/server/host/host-category')).resetHostCategoryForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const HOST_ID = 'runner-host-1'

const reportsBodySchema = z.object({ hostId: z.string(), reports: z.array(z.object({ seq: z.number(), record: z.object({ sessionId: z.string(), runnerHostId: z.string().nullable().optional() }) })) })
const mirrorBodySchema = z.object({ hostId: z.string(), items: z.array(z.object({ seq: z.number(), domain: z.string(), key: z.string(), payload: z.unknown() })) })

/** The organization's Solus API routes a publication uses; the delivering token names the organization (plans/010-standard-oauth.md). */
class FakeCloud {
  readonly reports: Array<z.infer<typeof reportsBodySchema>> = []
  readonly mirrored: Array<z.infer<typeof mirrorBodySchema>> = []
  /** Every organization whose delegated token delivered something. */
  readonly deliveredFor: string[] = []
  private server: Server | null = null
  url = ''

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        const json = (status: number, body: unknown) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(body))
        }
        const authorization = request.headers.authorization ?? null
        const organization = authorization?.replace('Bearer delegated-', '') ?? ''
        if (request.url?.startsWith('/runner/') && !this.deliveredFor.includes(organization)) this.deliveredFor.push(organization)
        if (request.url === '/runner/session-records') {
          const body = reportsBodySchema.parse(JSON.parse(raw))
          this.reports.push(body)
          return json(200, { lastSeq: Math.max(0, ...body.reports.map((entry) => entry.seq)) })
        }
        if (request.url === '/runner/mirror') {
          const body = mirrorBodySchema.parse(JSON.parse(raw))
          this.mirrored.push(body)
          return json(200, { lastSeq: Math.max(0, ...body.items.map((entry) => entry.seq)) })
        }
        json(404, { error: 'not found' })
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const transcripts = new Map<string, SessionLoadMessage[]>()

interface Harness {
  cloud: FakeCloud
  runner: InstanceType<typeof delivery.RunnerDelivery>
  coordinator: InstanceType<typeof publication.PublicationCoordinator>
  changes: Publication[]
  forgotten: Publication['resource'][]
  turnRunning: Set<string>
  finished: (resource: Publication['resource']) => Promise<Publication>
  stop: () => Promise<void>
}

/** People the host cannot act for until they connect again: their rows wait. */
async function harness(away = new Set<string>()): Promise<Harness> {
  const cloud = new FakeCloud()
  await cloud.start()
  const link: UplinkLinkConfig = { hostId: HOST_ID, issuer: cloud.url, jwksUrl: `${cloud.url}/jwks`, directoryUrl: cloud.url, hostname: 'h.lab.invalid', proxiedPort: 1, connectionGeneration: 1, apiUrl: cloud.url }
  const runner = new delivery.RunnerDelivery({
    link: () => link,
    // The host acts for each publisher with their delegated token; here it names the organization.
    delegations: {
      ensure: async (userId) => {
        if (away.has(userId)) throw new delegationsModule.DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Your sign-in for this machine expired. Reconnect and send again.')
      },
      accessToken: async (_userId, organizationId) => `delegated-${organizationId}`,
      holders: () => [],
    },
    linker: () => 'owner',
    setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 20))) as typeof setTimeout,
  })
  runner.start()
  const transcriptMirror = new transcriptMirrorModule.TranscriptMirror({ loadSession: async (_provider, sessionId) => transcripts.get(sessionId) ?? [], debounceMs: 5 })
  const changes: Publication[] = []
  const forgotten: Publication['resource'][] = []
  const completions = new Map<string, (row: Publication) => void>()
  const turnRunning = new Set<string>()
  const coordinator = new publication.PublicationCoordinator({
    delivery: runner,
    transcriptMirror,
    transcriptSource: (sessionId) => ({ provider: 'claude-code', projectPath: '-repo', agentSessionId: sessionId }),
    isTurnRunning: (sessionId) => turnRunning.has(sessionId),
    hostId: () => HOST_ID,
    forgetResource: async (resource) => { forgotten.push(resource) },
    onChanged: (row) => {
      changes.push(row)
      if (row.state === 'committed' || row.state === 'failed') completions.get(row.resource.id)?.(row)
    },
    waitMs: 3_000,
    pollMs: 5,
  })
  // As boot-server does: every delivery pass picks up what is still on its way.
  const stopResuming = runner.onCycle(() => coordinator.resume())
  return {
    cloud, runner, coordinator, changes, forgotten, turnRunning,
    finished: (resource) => new Promise((resolve) => { completions.set(resource.id, resolve) }),
    stop: async () => {
      stopResuming()
      transcriptMirror.dispose()
      await runner.stop()
      await cloud.stop()
    },
  }
}

/** Waits for the publication of a resource to leave its active states. */
async function settled(harness: Harness, resource: Publication['resource']): Promise<Publication> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const [latest] = harness.coordinator.list(resource)
    if (latest && latest.state !== 'pending' && latest.state !== 'sent') return latest
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`The publication of ${resource.kind} ${resource.id} did not settle.`)
}

/** Waits for a queue the delivery drains on its own. */
async function drained(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

const statesOf = (changes: Publication[], resource: Publication['resource']) => changes.filter((row) => row.resource.kind === resource.kind && row.resource.id === resource.id).map((row) => row.state)

describe('what the machine does not publish', () => {
  test('a work or a task is not published by the machine: the client uploads it with its own sign-in', async () => {
    // WHY: sharing a work or a task must not depend on the host link (docs/plans/cloud-sharing.md).
    const h = await harness()
    try {
      for (const resource of [{ kind: 'work', id: 'w1' }, { kind: 'task', id: 't1' }] as const) {
        await expect(h.coordinator.start({ resource, organizationId: 'A' }, 'alice')).rejects.toThrow(/with your sign-in/)
        expect(h.coordinator.reservedOrganization(resource)).toBeNull()
      }
    } finally {
      await h.stop()
    }
  })
})

describe('publishing a session', () => {
  test('a Local session is assigned to A, its record and transcript are delivered, and the record says published only after both were received', async () => {
    const h = await harness()
    try {
      await records.upsertOwnSessionRecord({ sessionId: 's-pub', provider: 'claude-code', projectPath: '-repo', title: 'Ship it', lastActivityAt: 1 })
      transcripts.set('s-pub', [{ role: 'user', content: 'ship it', timestamp: 1 }, { role: 'assistant', content: 'shipped', timestamp: 2 }])
      const resource = { kind: 'session', id: 's-pub' } as const
      expect(h.coordinator.reservedOrganization(resource)).toBeNull()

      // A turn is running: the publication waits for the boundary and reserves A meanwhile.
      h.turnRunning.add('s-pub')
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      expect(h.coordinator.reservedOrganization(resource)).toBe('A')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect((await records.getSessionRecord(principal.ANY_ORGANIZATION, 's-pub'))).toMatchObject({ organizationId: 'A', publication: 'local' })
      expect(h.cloud.reports).toEqual([])
      h.turnRunning.delete('s-pub')

      const done = await settled(h, resource)
      expect(done.state).toBe('committed')
      expect(statesOf(h.changes, resource)).toEqual(['pending', 'sent', 'committed'])
      const record = await records.getSessionRecord('A', 's-pub')
      expect(record).toMatchObject({ organizationId: 'A', publication: 'published', title: 'Ship it' })
      // The record went stamped with this host, and both transcript rows went with it — all as a person of A.
      // Saying `published` is itself a change to the record, so one more report follows the commit.
      expect(h.cloud.deliveredFor).toEqual(['A'])
      expect(h.cloud.mirrored.flatMap((batch) => batch.items.map((item) => item.key)).sort()).toEqual(['s-pub:0', 's-pub:1'])
      expect(mirrorLog.mirrorDestinations()).toEqual([])
      await drained(() => outbox.sessionReportDestinations().length === 0)
      const reported = h.cloud.reports.flatMap((batch) => batch.reports.map((entry) => [entry.record.sessionId, entry.record.runnerHostId]))
      expect(reported.length).toBeGreaterThanOrEqual(1)
      expect(reported.every(([sessionId, hostId]) => sessionId === 's-pub' && hostId === HOST_ID)).toBe(true)
      expect(h.coordinator.reservedOrganization(resource)).toBeNull()

      // Once published, the session belongs to A: it cannot be published to B.
      await expect(h.coordinator.start({ resource, organizationId: 'B' }, 'alice')).rejects.toThrow(/belongs to another organization/)
    } finally {
      await h.stop()
    }
  })

  test('a session shared by its Solus id finds the record keyed by its provider thread id', async () => {
    const h = await harness()
    // Insights and the tab name the Solus session id; the record carries the thread id.
    records.useLiveRecordIds((sessionId) => sessionId === 'solus-live' ? 'thread-live' : null)
    try {
      await records.upsertOwnSessionRecord({ sessionId: 'thread-live', provider: 'claude-code', projectPath: '-repo', title: 'Live', lastActivityAt: 1 })
      transcripts.set('solus-live', [{ role: 'user', content: 'hi', timestamp: 1 }])
      const resource = { kind: 'session', id: 'solus-live' } as const
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')

      const done = await settled(h, resource)
      expect(done.error ?? null).toBeNull()
      expect(done.state).toBe('committed')
      expect(await records.getSessionRecord('A', 'thread-live')).toMatchObject({ organizationId: 'A', publication: 'published' })
    } finally {
      records.useLiveRecordIds(() => null)
      await h.stop()
    }
  })
})
