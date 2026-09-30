import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import type { Publication } from '@solus/contracts/organization-scope'
import { runnerOutboxRequestSchema } from '@solus/server/sync/runner-protocol'
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
let tasks: typeof import('@solus/server/data/tasks/task-store')
let taskModule: typeof import('@solus/server/data/tasks/task')
let works: typeof import('@solus/server/data/works/works')
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
  tasks = await import('@solus/server/data/tasks/task-store')
  taskModule = await import('@solus/server/data/tasks/task')
  works = await import('@solus/server/data/works/works')
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

const workBodySchema = z.object({ hostId: z.string(), actorUserId: z.string(), transfer: z.object({ fingerprint: z.string(), work: z.object({ id: z.string(), title: z.string(), organizationId: z.string(), content: z.string() }) }) })
const reportsBodySchema = z.object({ hostId: z.string(), reports: z.array(z.object({ seq: z.number(), record: z.object({ sessionId: z.string(), runnerHostId: z.string().nullable().optional() }) })) })
const mirrorBodySchema = z.object({ hostId: z.string(), items: z.array(z.object({ seq: z.number(), domain: z.string(), key: z.string(), payload: z.unknown() })) })

type WorkBody = z.infer<typeof workBodySchema>

/** The organization's Solus API routes a publication uses; the delivering token names the organization (plans/010-standard-oauth.md). */
class FakeCloud {
  readonly worksReceived: Array<{ organization: string; body: WorkBody }> = []
  readonly reports: Array<z.infer<typeof reportsBodySchema>> = []
  readonly mirrored: Array<z.infer<typeof mirrorBodySchema>> = []
  /** Every organization whose delegated token delivered something. */
  readonly deliveredFor: string[] = []
  /** Answer `/runner/works` with this status and error instead of importing. */
  refuseWorks: { status: number; error: string } | null = null
  /** Hold every `/runner/works` answer until `releaseWorks()`. */
  refuseOutboxName: string | null = null
  readonly taskOperations: string[] = []
  holdWorks = false
  private held: Array<() => void> = []
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
        if (request.url === '/runner/works') {
          const body = workBodySchema.parse(JSON.parse(raw))
          const answer = () => {
            if (this.refuseWorks) return json(this.refuseWorks.status, { error: this.refuseWorks.error })
            this.worksReceived.push({ organization, body })
            json(200, { workId: body.transfer.work.id, organizationId: organization })
          }
          if (this.holdWorks) this.held.push(answer)
          else answer()
          return
        }
        if (request.url === '/runner/outbox') {
          const { ops } = runnerOutboxRequestSchema.parse(JSON.parse(raw))
          this.taskOperations.push(...ops.map(({ op }) => op.name))
          const failed = ops.filter(({ op }) => op.name === this.refuseOutboxName)
            .map(({ seq }) => ({ seq, error: 'Required task data was refused.', permanent: true }))
          return json(200, { lastSeq: Math.max(0, ...ops.map(({ seq }) => seq)), failed })
        }
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

  releaseWorks(): void {
    this.holdWorks = false
    for (const answer of this.held.splice(0)) answer()
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

describe('publishing a work', () => {
  test('a Local work goes pending → sent → committed, arrives whole with the actor, and leaves this host', async () => {
    const h = await harness()
    try {
      const work = await works.createWork('local', 'Design notes', 'doc', '# Notes', '', undefined, 'claude-code', '/repo')
      const resource = { kind: 'work', id: work.id } as const
      await expect(h.coordinator.start({ resource, organizationId: 'local' }, 'alice')).rejects.toThrow(/Choose an organization/)
      const started = await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      expect(started).toMatchObject({ resource, organizationId: 'A', actorUserId: 'alice', state: 'pending' })
      expect(h.coordinator.reservedOrganization(resource)).toBe('A')

      const done = await settled(h, resource)
      expect(done.state).toBe('committed')
      expect(done.error).toBeUndefined()
      expect(statesOf(h.changes, resource)).toEqual(['pending', 'sent', 'committed'])
      expect(h.cloud.deliveredFor).toEqual(['A'])
      expect(h.cloud.worksReceived).toHaveLength(1)
      expect(h.cloud.worksReceived[0]).toMatchObject({ organization: 'A', body: { hostId: HOST_ID, actorUserId: 'alice', transfer: { work: { id: work.id, title: 'Design notes', content: '# Notes', organizationId: 'local' } } } })
      // The service holds it now; the local copy is gone and nothing is reserved any more.
      expect(await works.loadWork(principal.ANY_ORGANIZATION, work.id)).toBeNull()
      expect(h.coordinator.reservedOrganization(resource)).toBeNull()
      expect(h.forgotten).toEqual([resource])
    } finally {
      await h.stop()
    }
  })

  test('a work on its way to A cannot be sent to B; the reservation holds until the receipt', async () => {
    // WHY: two Shares racing, or a Share and an Insights assignment, must not
    // send one record to two organizations (§7).
    const h = await harness()
    try {
      h.cloud.holdWorks = true
      const work = await works.createWork('local', 'Contested', 'doc', '# One', '', undefined, 'claude-code', '/repo')
      const resource = { kind: 'work', id: work.id } as const
      const first = await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      await expect(h.coordinator.start({ resource, organizationId: 'B' }, 'alice')).rejects.toThrow(/already on its way to another organization/)
      // Asking for A again resumes the same publication rather than starting another.
      expect((await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')).id).toBe(first.id)
      expect(h.coordinator.reservedOrganization(resource)).toBe('A')
      expect(await works.loadWork('local', work.id)).not.toBeNull()

      h.cloud.releaseWorks()
      expect((await settled(h, resource)).state).toBe('committed')
      expect(h.coordinator.list(resource)).toHaveLength(1)
      expect(await works.loadWork(principal.ANY_ORGANIZATION, work.id)).toBeNull()
    } finally {
      await h.stop()
    }
  })

  test('a service that refuses the work fails the publication with its reason and keeps the local copy', async () => {
    const h = await harness()
    try {
      h.cloud.refuseWorks = { status: 409, error: 'The cloud already has a different version. Open it before sharing.' }
      const work = await works.createWork('local', 'Stale', 'doc', '# Old', '', undefined, 'claude-code', '/repo')
      const resource = { kind: 'work', id: work.id } as const
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      const done = await settled(h, resource)
      expect(done).toMatchObject({ state: 'failed', error: 'The cloud already has a different version. Open it before sharing.' })
      expect(statesOf(h.changes, resource)).toEqual(['pending', 'sent', 'failed'])
      expect((await works.loadWork('local', work.id))?.content).toBe('# Old')
      // A failed publication reserves nothing: the work may be sent elsewhere.
      expect(h.coordinator.reservedOrganization(resource)).toBeNull()
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


describe('publishing a task', () => {
  test('a permanent failure of a required comment keeps the local task even after the dead letter is dismissed', async () => {
    const h = await harness()
    const stop = outbox.onOutboxChanged(() => {
      const failed = outbox.listOutboxOps().filter((op) => op.state === 'failed')
      if (failed.length) outbox.ackOutboxOps(failed.map((op) => op.id))
    })
    try {
      h.cloud.refuseOutboxName = 'comment'
      const created = await tasks.createTask('local', { title: 'Keep my task', body: 'Source data' })
      const task = await taskModule.Task.byId('local', created.id)
      await task.comment('Required comment', { by: BY })
      const resource = { kind: 'task', id: task.id } as const
      const finished = h.finished(resource)
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      expect(await finished).toMatchObject({ state: 'failed', error: 'Required task data was refused.' })
      expect((await taskModule.Task.byId('local', task.id)).body).toBe('Source data')
      expect((await task.details()).comments.map((comment) => comment.body)).toContain('Required comment')
      expect(outbox.listOutboxOps().filter((op) => op.state === 'failed')).toEqual([])
      h.coordinator.resume()
      expect(h.coordinator.list(resource)[0].state).toBe('failed')
    } finally { stop(); await h.stop() }
  })

  test('a task whose publisher must reconnect says so at once, stays quiet while it waits, and commits once they connect', async () => {
    // WHY: delivery parked the rows until the person connected, and the publication
    // waited for a receipt that could not come. It said nothing, so the share dialog
    // showed "pending" forever and polled the host twice a second.
    const away = new Set(['alice'])
    const h = await harness(away)
    try {
      const created = await tasks.createTask('local', { title: 'Publish after sign-in' })
      const resource = { kind: 'task', id: created.id } as const
      const finished = h.finished(resource)
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      await drained(() => (h.coordinator.list(resource)[0]?.error ?? '').includes('Reconnect'))
      expect(h.coordinator.list(resource)[0].state).toBe('sent')
      expect(h.cloud.taskOperations).toEqual([])

      // Later delivery passes resume it without a new event each time.
      const eventsWhileWaiting = h.changes.length
      for (let pass = 0; pass < 5; pass++) {
        h.coordinator.resume()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.changes.length).toBe(eventsWhileWaiting)

      away.delete('alice')
      h.runner.retryWaiting()
      const done = await finished
      expect(done.state).toBe('committed')
      expect(done.error).toBeUndefined()
      expect(h.cloud.taskOperations).toEqual(['create'])
    } finally { await h.stop() }
  })

  test('only successful receipts for all required task operations allow source removal', async () => {
    const h = await harness()
    try {
      const created = await tasks.createTask('local', { title: 'Publish my task' })
      const task = await taskModule.Task.byId('local', created.id)
      await task.comment('Required comment', { by: BY })
      const resource = { kind: 'task', id: task.id } as const
      const finished = h.finished(resource)
      await h.coordinator.start({ resource, organizationId: 'A' }, 'alice')
      expect((await finished).state).toBe('committed')
      expect(h.cloud.taskOperations).toEqual(['create', 'comment'])
      await expect(taskModule.Task.byId('local', task.id)).rejects.toThrow()
    } finally { await h.stop() }
  })
})
