import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §16: on a runner linked to an organization the
// agent's work writes are cloud-owned — recorded, delivered in order, never
// applied locally — and its session records are mirrored. Task writes are
// cloud-owned only on a cloud instance, a managed host (project-model.md §4), so
// this runner is managed until the last test. Delivery never blocks the tool,
// survives a restart, backs off, and mints a fresh grant on 401.

let delivery: typeof import('@solus/server/server/uplink/runner-delivery')
let outbox: typeof import('@solus/server/outbox/outbox-store')
let ownership: typeof import('@solus/server/outbox/cloud-ownership')
let taskTools: typeof import('@solus/server/tasks/task-tools')
let workTools: typeof import('@solus/server/folio/work-tools')
let artifactTools: typeof import('@solus/server/folio/artifact-tools')
let taskStore: typeof import('@solus/server/tasks/task-store')
let works: typeof import('@solus/server/folio/works')
let records: typeof import('@solus/server/sessions/session-records')
let dbModule: typeof import('@solus/server/db')
let managedMode: typeof import('@solus/server/server/managed-mode')
type AgentToolContext = import('@solus/server/agents/tools/agent-tool').AgentToolContext

const previousDataDir = process.env.SOLUS_DATA_DIR
const previousManaged = process.env.SOLUS_MANAGED
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-runner-delivery-'))
  process.env.SOLUS_DATA_DIR = dataDir
  delivery = await import('@solus/server/server/uplink/runner-delivery')
  outbox = await import('@solus/server/outbox/outbox-store')
  ownership = await import('@solus/server/outbox/cloud-ownership')
  taskTools = await import('@solus/server/tasks/task-tools')
  workTools = await import('@solus/server/folio/work-tools')
  artifactTools = await import('@solus/server/folio/artifact-tools')
  taskStore = await import('@solus/server/tasks/task-store')
  works = await import('@solus/server/folio/works')
  records = await import('@solus/server/sessions/session-records')
  dbModule = await import('@solus/server/db')
  managedMode = await import('@solus/server/server/managed-mode')
  process.env.SOLUS_MANAGED = '1'
  managedMode.resetManagedModeForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousManaged === undefined) delete process.env.SOLUS_MANAGED
  else process.env.SOLUS_MANAGED = previousManaged
  managedMode.resetManagedModeForTests()
})

const HOST_ID = 'runner-host-1'
const HOST_TOKEN = 'sht_test_token'

const outboxBodySchema = z.object({ hostId: z.string(), ops: z.array(z.object({ seq: z.number(), op: z.object({ id: z.string(), domain: z.string(), resourceId: z.string(), name: z.string(), payload: z.unknown() }) })) })
const reportsBodySchema = z.object({ hostId: z.string(), reports: z.array(z.object({ seq: z.number(), record: z.object({ sessionId: z.string(), runnerHostId: z.string().nullable().optional(), title: z.string().nullable().optional() }) })) })

type OutboxBody = z.infer<typeof outboxBodySchema>
type ReportsBody = z.infer<typeof reportsBodySchema>

/** The control plane's runner-grant route and the workspace service's two runner routes, in one process. */
class FakeCloud {
  readonly outboxBatches: Array<{ authorization: string | null; body: OutboxBody }> = []
  readonly reportBatches: Array<{ authorization: string | null; body: ReportsBody }> = []
  mints = 0
  shared = true
  online = true
  unauthorizedOnce = false
  permanentSeqs = new Set<number>()
  private waiters: Array<{ kind: 'outbox' | 'reports'; resolve: () => void }> = []
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
        if (request.url === `/v1/hosts/${HOST_ID}/runner-grant`) {
          if (authorization !== `Bearer ${HOST_TOKEN}`) return json(401, { error: 'invalid_host_token' })
          if (!this.shared) return json(404, { error: 'host_not_in_organization' })
          this.mints += 1
          return json(200, { grant: `grant-${this.mints}`, hostId: 'workspace:org1', expiresAt: Date.now() + 600_000, organizationId: 'org1', routes: [{ kind: 'tunnel', url: this.url }] })
        }
        if (!this.online) return json(503, { error: 'down' })
        if (this.unauthorizedOnce) {
          this.unauthorizedOnce = false
          return json(401, { error: 'Unauthorized' })
        }
        if (request.url === '/runner/outbox') {
          const body = outboxBodySchema.parse(JSON.parse(raw))
          this.outboxBatches.push({ authorization, body })
          const applied = body.ops.map((entry) => entry.seq)
          const failed = applied.filter((seq) => this.permanentSeqs.has(seq)).map((seq) => ({ seq, error: 'gone', permanent: true }))
          this.wake('outbox')
          return json(200, { lastSeq: Math.max(0, ...applied), failed })
        }
        if (request.url === '/runner/session-records') {
          const body = reportsBodySchema.parse(JSON.parse(raw))
          this.reportBatches.push({ authorization, body })
          this.wake('reports')
          return json(200, { lastSeq: Math.max(0, ...body.reports.map((entry) => entry.seq)) })
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

  /** Resolves on the next request of that kind: the test waits on the wire, never on a timer. */
  next(kind: 'outbox' | 'reports'): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ kind, resolve }))
  }

  private wake(kind: 'outbox' | 'reports'): void {
    const [ready, rest] = [this.waiters.filter((waiter) => waiter.kind === kind), this.waiters.filter((waiter) => waiter.kind !== kind)]
    this.waiters = rest
    for (const waiter of ready) waiter.resolve()
  }
}

function link(cloud: FakeCloud): UplinkLinkConfig {
  return { hostId: HOST_ID, issuer: cloud.url, jwksUrl: `${cloud.url}/jwks`, directoryUrl: cloud.url, hostname: 'h.lab.invalid', proxiedPort: 1, connectionGeneration: 1 }
}

function startDelivery(cloud: FakeCloud, linked = true) {
  const instance = new delivery.RunnerDelivery({
    link: () => (linked ? link(cloud) : null),
    hostToken: () => HOST_TOKEN,
    // Backoff waits are real delays; the test shortens every one to keep the proof under a second.
    setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 20))) as typeof setTimeout,
  })
  instance.start()
  return instance
}

const toolContext = (): AgentToolContext => ({
  provider: 'claude-code',
  cwd: dataDir,
  sessionId: () => 'thread-1',
  solusSessionId: () => 'solus-1',
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
})

/** Lets the delivery's own `setTimeout(0)` kick run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runner delivery', () => {
  test('a linked host shared with an organization delivers cloud-owned agent writes in order and applies none of them locally', async () => {
    const cloud = new FakeCloud()
    await cloud.start()
    const runner = startDelivery(cloud)
    try {
      // The grant exchange happens on the first cycle; the ownership flag follows it.
      await tick()
      let attempts = 0
      while (ownership.cloudOwnedOrganization() === null && attempts++ < 50) await tick()
      expect(ownership.cloudOwnedOrganization()).toBe('org1')
      expect(runner.currentStatus()).toMatchObject({ organizationId: 'org1', workspaceUrl: cloud.url, error: null })

      const firstBatch = cloud.next('outbox')
      const created = await taskTools.createTaskAgentTool.execute({ title: 'Cloud task', body: 'body' }, toolContext())
      expect(created.ok).toBe(true)
      const taskId = /Task (\S+) —/.exec(created.text)?.[1]
      expect(taskId).toBeTruthy()
      const commented = await taskTools.commentTaskAgentTool.execute({ task_id: taskId!, body: 'note' }, toolContext())
      expect(commented.ok).toBe(true)
      const work = await workTools.createWorkAgentTool.execute({ title: 'Cloud doc', doc_type: 'doc', content: '# Doc' }, toolContext())
      expect(work.ok).toBe(true)
      const workId = /id: ([0-9a-f-]+)\)/.exec(work.text)?.[1]
      expect(workId).toBeTruthy()
      const artifact = await artifactTools.executeArtifactTool({ html: '<html><title>Chart</title></html>', link_to_task: true }, { ctx: { sessionId: 'thread-1', agentProvider: 'claude-code', cwd: dataDir } })
      expect(artifact.text).toContain('links to the session')

      // Not one of them is in the runner's own tables.
      expect((await taskStore.listTasks('local')).tasks).toEqual([])
      expect(await works.listWorks('local')).toEqual([])
      // And none of them is a client courier's business.
      expect(outbox.listOutboxOps()).toEqual([])

      await firstBatch
      while (cloud.outboxBatches.flatMap((batch) => batch.body.ops).length < 4) await cloud.next('outbox')
      const ops = cloud.outboxBatches.flatMap((batch) => batch.body.ops)
      expect(cloud.outboxBatches.every((batch) => batch.body.hostId === HOST_ID && batch.authorization === 'Bearer grant-1')).toBe(true)
      expect(ops.map((entry) => [entry.op.domain, entry.op.name, entry.op.resourceId])).toEqual([
        ['tasks', 'create', taskId],
        ['tasks', 'comment', taskId],
        ['works', 'create', workId],
        ['works', 'create', expect.any(String)],
      ])
      expect(ops.map((entry) => entry.seq)).toEqual([...ops.map((entry) => entry.seq)].sort((a, b) => a - b))
      expect(ops[3]?.op.payload).toMatchObject({ docType: 'artifact', linkToSessionTask: true })
      // Acked by sequence: the queue is empty once the service answered.
      await tick()
      expect(outbox.listCloudOutboxOps(10)).toEqual([])
    } finally {
      await runner.stop()
      await cloud.stop()
    }
  })

  test('a session record of this host is mirrored, stamped with the host, and merged while it waits', async () => {
    const cloud = new FakeCloud()
    await cloud.start()
    cloud.online = false
    const runner = startDelivery(cloud)
    try {
      await records.upsertSessionRecord('local', { sessionId: 's-mirror', provider: 'claude-code', projectPath: '-repo', title: 'First words', lastActivityAt: 1 })
      await records.setSessionRecordStatus('local', 's-mirror', 'running')
      await records.setSessionRecordTitle('local', 's-mirror', 'Renamed')
      // One queued report per session, holding everything reported so far.
      const queued = outbox.listSessionReports(10)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.record).toMatchObject({ sessionId: 's-mirror', title: 'First words', status: 'running', customTitle: 'Renamed', runnerHostId: HOST_ID })
      const delivered = cloud.next('reports')
      cloud.online = true
      await delivered
      expect(cloud.reportBatches[0]?.body.reports.map((entry) => entry.record.sessionId)).toEqual(['s-mirror'])
      expect(cloud.reportBatches[0]?.body.reports[0]?.record.runnerHostId).toBe(HOST_ID)
      await tick()
      expect(outbox.listSessionReports(10)).toEqual([])
    } finally {
      await runner.stop()
      await cloud.stop()
    }
  })

  test('a refused grant mints a fresh one; an outage backs off and a restart resumes from the queue', async () => {
    const cloud = new FakeCloud()
    await cloud.start()
    let runner = startDelivery(cloud)
    try {
      while (ownership.cloudOwnedOrganization() === null) await tick()
      cloud.unauthorizedOnce = true
      const redelivered = cloud.next('outbox')
      const task = await taskTools.createTaskAgentTool.execute({ title: 'After a 401' }, toolContext())
      expect(task.ok).toBe(true)
      await redelivered
      expect(cloud.mints).toBe(2)
      expect(cloud.outboxBatches.at(-1)?.authorization).toBe('Bearer grant-2')

      // The service goes away; the write is queued, the host keeps working, and the next process delivers it.
      cloud.online = false
      await tick()
      const queuedTask = await taskTools.createTaskAgentTool.execute({ title: 'While offline' }, toolContext())
      expect(queuedTask.ok).toBe(true)
      await tick()
      expect(outbox.listCloudOutboxOps(10).map((entry) => entry.op.name)).toEqual(['create'])
      await runner.stop()
      expect(ownership.cloudOwnedOrganization()).toBeNull()
      cloud.online = true
      const resumed = cloud.next('outbox')
      runner = startDelivery(cloud)
      await resumed
      expect(cloud.outboxBatches.at(-1)?.body.ops.map((entry) => entry.op.payload)).toMatchObject([{ title: 'While offline' }])
      await tick()
      expect(outbox.listCloudOutboxOps(10)).toEqual([])
    } finally {
      await runner.stop()
      await cloud.stop()
    }
  })

  test('a permanent failure is dead-lettered where a person can see it; an unshared host applies locally as before', async () => {
    const cloud = new FakeCloud()
    await cloud.start()
    let runner = startDelivery(cloud)
    try {
      while (ownership.cloudOwnedOrganization() === null) await tick()
      const answered = cloud.next('outbox')
      const statusChange = await taskTools.updateTaskStatusAgentTool.execute({ task_id: 'gone-task', status: 'in_review' }, toolContext())
      expect(statusChange.ok).toBe(true)
      const [queued] = outbox.listCloudOutboxOps(1)
      cloud.permanentSeqs.add(queued!.seq)
      await answered
      await tick()
      expect(outbox.listOutboxOps().map((op) => [op.name, op.state, op.error])).toEqual([['set-status', 'failed', 'gone']])
      outbox.ackOutboxOps(outbox.listOutboxOps().map((op) => op.id))

      // The control plane says the host is in no organization: its writes are its own again.
      await runner.stop()
      cloud.shared = false
      runner = startDelivery(cloud)
      await tick()
      let attempts = 0
      while (runner.currentStatus().organizationId !== null && attempts++ < 50) await tick()
      expect(ownership.cloudOwnedOrganization()).toBeNull()
      const local = await taskTools.createTaskAgentTool.execute({ title: 'Local again' }, toolContext())
      expect(local.ok).toBe(true)
      expect((await taskStore.listTasks('local')).tasks.map((row) => row.title)).toEqual(['Local again'])
      expect(outbox.listCloudOutboxOps(10)).toEqual([])
    } finally {
      await runner.stop()
      await cloud.stop()
    }
  })

  test('a linked personal machine keeps its agent tasks local; its works still go to the cloud', async () => {
    delete process.env.SOLUS_MANAGED
    managedMode.resetManagedModeForTests()
    const cloud = new FakeCloud()
    await cloud.start()
    const runner = startDelivery(cloud)
    try {
      while (ownership.cloudOwnedOrganization() === null) await tick()
      const created = await taskTools.createTaskAgentTool.execute({ title: 'Personal task' }, toolContext())
      expect(created.ok).toBe(true)
      expect((await taskStore.listTasks('local')).tasks.map((row) => row.title)).toContain('Personal task')
      const delivered = cloud.next('outbox')
      const work = await workTools.createWorkAgentTool.execute({ title: 'Shared doc', doc_type: 'doc', content: '# Doc' }, toolContext())
      expect(work.ok).toBe(true)
      await delivered
      expect(cloud.outboxBatches.flatMap((batch) => batch.body.ops).map((entry) => entry.op.domain)).toEqual(['works'])
    } finally {
      await runner.stop()
      await cloud.stop()
      process.env.SOLUS_MANAGED = '1'
      managedMode.resetManagedModeForTests()
    }
  })
})
