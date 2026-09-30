import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { beforeEach, afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §6, plans/010-standard-oauth.md: every queued row
// — a cloud-bound outbox op, a session-record report, a mirror row — names its
// organization and the person whose work it is; a pass visits every destination and
// sends it with that person's delegated token, in sequence order, acking per
// destination. A person the host cannot act for yet waits; a refused person's rows are
// dropped, and nobody else's. An organization session's comments and links travel
// here; a personal machine keeps its agent's writes local. Delivery never blocks the
// tool, survives a restart, and backs off.

let delivery: typeof import('@solus/server/sync/runner-delivery')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let mirrorLog: typeof import('@solus/server/sync/mirror/mirror-log')
let principal: typeof import('@solus/server/admission/principal')
let taskTools: typeof import('@solus/server/execution/agents/tools/task-tools')
let workTools: typeof import('@solus/server/execution/agents/tools/work-tools')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let works: typeof import('@solus/server/data/works/works')
let records: typeof import('@solus/server/data/sessions/session-records')
let dbModule: typeof import('@solus/server/db')
let hostCategory: typeof import('@solus/server/host/host-category')
let delegationsModule: typeof import('@solus/server/sync/delegations')
type AgentToolContext = import('@solus/server/execution/agents/tools/agent-tool').AgentToolContext

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-runner-delivery-'))
  process.env.SOLUS_DATA_DIR = dataDir
  delivery = await import('@solus/server/sync/runner-delivery')
  outbox = await import('@solus/server/sync/outbox/outbox-store')
  mirrorLog = await import('@solus/server/sync/mirror/mirror-log')
  principal = await import('@solus/server/admission/principal')
  taskTools = await import('@solus/server/execution/agents/tools/task-tools')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  taskStore = await import('@solus/server/data/tasks/task-store')
  works = await import('@solus/server/data/works/works')
  records = await import('@solus/server/data/sessions/session-records')
  dbModule = await import('@solus/server/db')
  hostCategory = await import('@solus/server/host/host-category')
  delegationsModule = await import('@solus/server/sync/delegations')
  onManagedHost('org1')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  hostCategory.resetHostCategoryForTests()
})

/** A managed host's link names the one organization it was provisioned for; a personal machine's names none. */
function onManagedHost(organizationId: string | null): void {
  hostCategory.resetHostCategoryForTests()
  hostCategory.adoptProvisionedLink(organizationId ? { organizationId } : null)
}

/**
 * An organization session on this attached machine: its record is born published in
 * the organization, and its tools answer the Solus API, which these tests never reach
 * for a create or read, so the installed operations refuse every call.
 */
async function installOrganizationSession(recordId: string, organizationId: string): Promise<() => void> {
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  const { useOrganizationAttachment } = await import('@solus/server/host/organization-attachment')
  const { createWorkspaceOperations } = await import('@solus/server/data/workspace/service')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  records.rememberSessionBirth(recordId, { organizationId, published: true, ownerUserId: 'user-alice', admissionId: 'solus-org' })
  await records.upsertOwnSessionRecord({ sessionId: recordId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
  useOrganizationAttachment(() => 1)
  const unreachable = new Proxy(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), { get: () => () => Promise.reject(new Error('the test API is not called')) })
  const uninstall = installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'test-host', () => unreachable)
  return () => { uninstall(); useOrganizationAttachment(() => null) }
}

/** A cloud-bound task write queued for org1 as `actorUserId`'s, as an organization session's comment or a publication would be. */
function queueTask(title: string, actorUserId = 'bob'): void {
  outbox.recordOutboxOp({ domain: 'tasks', resourceId: `task-${title}`, name: 'create', payload: { title }, destination: 'cloud', organizationId: 'org1', actorUserId })
}

const HOST_ID = 'runner-host-1'

const outboxBodySchema = z.object({ hostId: z.string(), ops: z.array(z.object({ seq: z.number(), op: z.object({ id: z.string(), domain: z.string(), resourceId: z.string(), name: z.string(), payload: z.unknown() }) })) })
const reportsBodySchema = z.object({ hostId: z.string(), reports: z.array(z.object({ seq: z.number(), record: z.object({ sessionId: z.string(), runnerHostId: z.string().nullable().optional(), title: z.string().nullable().optional(), customTitle: z.string().nullable().optional(), status: z.string().optional() }) })) })
const mirrorBodySchema = z.object({ hostId: z.string(), items: z.array(z.object({ seq: z.number(), domain: z.string(), key: z.string(), payload: z.unknown() })) })

type OutboxBody = z.infer<typeof outboxBodySchema>
type ReportsBody = z.infer<typeof reportsBodySchema>
type MirrorBody = z.infer<typeof mirrorBodySchema>
type Stream = 'outbox' | 'reports' | 'mirror'

/** The Solus API's runner routes. Each batch records the token it came with: whose work, in which organization. */
class FakeApi {
  readonly outboxBatches: Array<{ authorization: string | null; body: OutboxBody }> = []
  readonly reportBatches: Array<{ authorization: string | null; body: ReportsBody }> = []
  readonly mirrorBatches: Array<{ authorization: string | null; body: MirrorBody }> = []
  online = true
  unauthorizedOnce = false
  permanentSeqs = new Set<number>()
  private waiters: Array<{ kind: Stream; resolve: () => void }> = []
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
        if (request.url === '/runner/mirror') {
          const body = mirrorBodySchema.parse(JSON.parse(raw))
          this.mirrorBatches.push({ authorization, body })
          this.wake('mirror')
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

  /** Resolves on the next request of that kind: the test waits on the wire, never on a timer. */
  next(kind: Stream): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ kind, resolve }))
  }

  private wake(kind: Stream): void {
    const [ready, rest] = [this.waiters.filter((waiter) => waiter.kind === kind), this.waiters.filter((waiter) => waiter.kind !== kind)]
    this.waiters = rest
    for (const waiter of ready) waiter.resolve()
  }
}

/** The host's delegations as delivery sees them: who is away, who was refused, and every token asked for. */
class FakeDelegations {
  readonly asked: string[] = []
  /** People with no token here yet: their rows wait. */
  readonly away = new Set<string>()
  /** People the account plane refused: removal ends everything. */
  readonly refused = new Set<string>()
  async ensure(userId: string, _organizationId: string): Promise<void> {
    if (this.refused.has(userId)) throw new delegationsModule.DelegationError('ORGANIZATION_ACCESS_REFUSED', 'The person is not a member of the organization.')
    if (this.away.has(userId)) throw new delegationsModule.DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Nobody has connected as this person yet.')
  }
  async accessToken(userId: string, organizationId: string): Promise<string> {
    this.asked.push(`${userId}/${organizationId}`)
    return `delegated-${userId}-${organizationId}`
  }
  holders(): Array<{ userId: string; organizationId: string }> {
    return []
  }
}

function link(api: FakeApi): UplinkLinkConfig {
  return { hostId: HOST_ID, issuer: api.url, jwksUrl: `${api.url}/jwks`, directoryUrl: api.url, hostname: 'h.lab.invalid', proxiedPort: 1, connectionGeneration: 1, apiUrl: api.url }
}

function startDelivery(api: FakeApi, delegations = new FakeDelegations(), linked: () => boolean = () => true) {
  const instance = new delivery.RunnerDelivery({
    link: () => (linked() ? link(api) : null),
    delegations,
    // Rows no person was named for go as the person who linked the host.
    linker: () => 'owner',
    // Backoff and waiting delays are real; the test shortens every one to keep the proof under a second.
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

/** Waits, a tick at a time, for a condition the delivery reaches on its own. */
async function until(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt++) await tick()
  expect(condition()).toBe(true)
}

const bobIn = (organizationId: string) => ({ organizationId, actorUserId: 'bob' })
/** A destination no person was named for: the host's linker carries it. */
const linkerIn = (organizationId: string) => ({ organizationId, actorUserId: '' })

async function ownRecord(sessionId: string) {
  await records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', title: 'First words', lastActivityAt: 1 })
}

describe('runner delivery', () => {
  test('an organization session\'s queued comment and link reach its organization in order, with its owner\'s token; nothing is applied here', async () => {
    // WHY: an organization session's tasks and works are written on its Solus API
    // synchronously (organization-vm-records.test.ts); comments and links, which the
    // record API does not carry, travel through this queue, in order, as the person
    // whose session it is (plans/010-standard-oauth.md).
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    const runner = startDelivery(api, delegations)
    const recordReported = api.next('reports')
    const stopTools = await installOrganizationSession('thread-org', 'org1')
    const inOrganizationSession = (): AgentToolContext => ({ ...toolContext(), sessionId: () => 'thread-org', solusSessionId: () => 'solus-org' })
    try {
      // The published session's own record goes first, as its owner.
      await recordReported
      expect(api.reportBatches[0]).toMatchObject({ authorization: 'Bearer delegated-user-alice-org1' })
      await until(() => outbox.sessionReportDestinations().length === 0)
      expect(runner.currentStatus()).toEqual({ error: null })

      const firstBatch = api.next('outbox')
      const commented = await taskTools.commentTaskAgentTool.execute({ task_id: 'task-org', body: 'note' }, inOrganizationSession())
      expect(commented).toMatchObject({ ok: true })
      expect(commented.text).toContain('queued for the organization')
      const linked = await taskTools.linkAgentTool.execute({ task_id: 'task-org', kind: 'session' }, inOrganizationSession())
      expect(linked.ok).toBe(true)
      expect(outbox.listOutboxOps()).toEqual([])

      await firstBatch
      while (api.outboxBatches.flatMap((batch) => batch.body.ops).length < 2) await api.next('outbox')
      const ops = api.outboxBatches.flatMap((batch) => batch.body.ops)
      expect(api.outboxBatches.every((batch) => batch.body.hostId === HOST_ID && batch.authorization === 'Bearer delegated-user-alice-org1')).toBe(true)
      expect(ops.map((entry) => [entry.op.domain, entry.op.name, entry.op.resourceId])).toEqual([
        ['tasks', 'comment', 'task-org'],
        ['tasks', 'link-session', 'task-org'],
      ])
      // Acked by sequence: the queue is empty once the service answered.
      await tick()
      expect(outbox.listCloudOutboxOps({ organizationId: 'org1', actorUserId: 'user-alice' }, 10)).toEqual([])
      expect((await taskStore.listTasks(principal.ANY_ORGANIZATION)).tasks).toEqual([])
    } finally {
      stopTools()
      await runner.stop()
      await api.stop()
    }
  })

  test('a session record is reported to its organization only once it is published, stamped with the host, and merged while it waits', async () => {
    // WHY: assigning a session to an organization sends its Insights, not its
    // record or transcript (§3); those leave only through a publication (§7).
    const api = new FakeApi()
    await api.start()
    api.online = false
    const runner = startDelivery(api)
    try {
      // A Local record is this machine's own, published or not.
      await records.upsertSessionRecord('local', { sessionId: 's-local', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
      await records.markSessionPublished('s-local')
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-local', 'running')
      expect((await records.getSessionRecord('local', 's-local'))?.publication).toBe('local')
      expect(outbox.sessionReportDestinations()).toEqual([])

      // A record of the organization is not reported while it is unpublished.
      await ownRecord('s-mirror')
      expect(await records.getSessionRecord('org1', 's-mirror')).toMatchObject({ organizationId: 'org1', publication: 'local' })
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-mirror', 'running')
      expect(outbox.sessionReportDestinations()).toEqual([])

      // Published: the record, and every later change to it, is queued for org1; nobody owns it, so the linker carries it.
      await records.markSessionPublished('s-mirror')
      await records.setSessionRecordTitle(principal.ANY_ORGANIZATION, 's-mirror', 'Renamed')
      const queued = outbox.listSessionReports(linkerIn('org1'), 10)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.record).toMatchObject({ sessionId: 's-mirror', title: 'First words', status: 'running', customTitle: 'Renamed', runnerHostId: HOST_ID })
      expect(outbox.sessionReportDestinations()).toEqual([linkerIn('org1')])

      const delivered = api.next('reports')
      api.online = true
      await delivered
      expect(api.reportBatches[0]?.authorization).toBe('Bearer delegated-owner-org1')
      expect(api.reportBatches[0]?.body.reports.map((entry) => entry.record.sessionId)).toEqual(['s-mirror'])
      expect(api.reportBatches[0]?.body.reports[0]?.record.runnerHostId).toBe(HOST_ID)
      await tick()
      expect(outbox.listSessionReports(linkerIn('org1'), 10)).toEqual([])
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('session records are followed only while a link exists, so an unlinked host pays nothing per record write', async () => {
    // WHY: following records makes every record write read the row back, several
    // times per turn. An unlinked host would drop the report anyway.
    const api = new FakeApi()
    await api.start()
    api.online = false
    let linked = false
    const runner = new delivery.RunnerDelivery({
      link: () => (linked ? link(api) : null),
      delegations: new FakeDelegations(),
      linker: () => 'owner',
      setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 20))) as typeof setTimeout,
    })
    // Count the record read-backs a status write triggers.
    const connection = dbModule.getDb() as unknown as { prepare: (text: string) => unknown }
    const prepare = connection.prepare.bind(connection)
    let readBacks = 0
    connection.prepare = (text: string) => {
      if (/^\s*select[\s\S]*from "session_records"/i.test(text)) readBacks++
      return prepare(text)
    }
    runner.start()
    try {
      await ownRecord('s-follow')
      await records.markSessionPublished('s-follow')
      readBacks = 0
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'running')
      expect(readBacks).toBe(0)

      linked = true
      runner.linkChanged()
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'idle')
      expect(readBacks).toBe(1)
      expect(outbox.listSessionReports(linkerIn('org1'), 10).filter((report) => report.record.sessionId === 's-follow')).toHaveLength(1)

      linked = false
      runner.linkChanged()
      readBacks = 0
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'running')
      expect(readBacks).toBe(0)
    } finally {
      connection.prepare = prepare
      await runner.stop()
      await api.stop()
      outbox.ackSessionReportsThrough(linkerIn('org1'), Number.MAX_SAFE_INTEGER)
    }
  })

  test('a 401 or an outage backs off and tries again; a restart resumes from the queue', async () => {
    const api = new FakeApi()
    await api.start()
    let runner = startDelivery(api)
    try {
      const first = api.next('outbox')
      queueTask('First')
      await first

      api.unauthorizedOnce = true
      const redelivered = api.next('outbox')
      queueTask('After a 401')
      await redelivered
      expect(api.outboxBatches.at(-1)?.body.ops.map((entry) => entry.op.payload)).toMatchObject([{ title: 'After a 401' }])

      // The service goes away; the write is queued, the host keeps working, and the next process delivers it.
      api.online = false
      await tick()
      queueTask('While offline')
      await tick()
      expect(outbox.listCloudOutboxOps(bobIn('org1'), 10).map((entry) => entry.op.name)).toEqual(['create'])
      await until(() => runner.currentStatus().error !== null)
      expect(runner.currentStatus().error).toContain('503')
      await runner.stop()
      api.online = true
      const resumed = api.next('outbox')
      runner = startDelivery(api)
      await resumed
      expect(api.outboxBatches.at(-1)?.body.ops.map((entry) => entry.op.payload)).toMatchObject([{ title: 'While offline' }])
      await tick()
      expect(outbox.listCloudOutboxOps(bobIn('org1'), 10)).toEqual([])
      expect(runner.currentStatus().error).toBeNull()
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('a permanent failure is dead-lettered where a person can see it; the rows of a person with no token here wait until they connect', async () => {
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    const runner = startDelivery(api, delegations)
    try {
      // The service is down while the op is written, so it is still queued when the test marks it doomed.
      api.online = false
      outbox.recordOutboxOp({ domain: 'tasks', resourceId: 'gone-task', name: 'set-status', payload: { status: 'in_review' }, destination: 'cloud', organizationId: 'org1', actorUserId: 'bob' })
      const [queued] = outbox.listCloudOutboxOps(bobIn('org1'), 1)
      api.permanentSeqs.add(queued!.seq)
      const answered = api.next('outbox')
      api.online = true
      await answered
      await tick()
      expect(outbox.listOutboxOps().map((op) => [op.name, op.state, op.error])).toEqual([['set-status', 'failed', 'gone']])
      outbox.ackOutboxOps(outbox.listOutboxOps().map((op) => op.id))
      // The outage's error is gone once a pass reached the service: the status says what is wrong now, not what was.
      await until(() => runner.currentStatus().error === null)

      // Dana has not connected to this host since it restarted: her rows wait, untouched, and nothing is wrong.
      delegations.away.add('dana')
      queueTask('While Dana is away', 'dana')
      await until(() => outbox.listCloudOutboxOps({ organizationId: 'org1', actorUserId: 'dana' }, 10).length === 1)
      await tick()
      expect(api.outboxBatches.some((batch) => batch.authorization === 'Bearer delegated-dana-org1')).toBe(false)
      expect(runner.currentStatus().error).toBeNull()

      // She connects: her rows go, with her token.
      delegations.away.delete('dana')
      const delivered = api.next('outbox')
      runner.retryWaiting()
      await delivered
      expect(api.outboxBatches.at(-1)).toMatchObject({ authorization: 'Bearer delegated-dana-org1' })
      await tick()
      expect(outbox.listCloudOutboxOps({ organizationId: 'org1', actorUserId: 'dana' }, 10)).toEqual([])
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('a 403 from the token exchange waits for the person to connect; a stream of writes does not turn it into a request loop', async () => {
    // WHY: a 403 was treated as an outage. Every queued write kicked a new pass past
    // the backoff, so a busy turn asked Solus for a token hundreds of times, the
    // rows never moved, and nobody was told to reconnect.
    const api = new FakeApi()
    await api.start()
    let exchanges = 0
    const delegations = new delegationsModule.Delegations({
      link: () => link(api),
      client: () => ({ clientId: 'host-client', clientSecret: 'host-secret' }),
      personToken: () => 'erin-access-token',
      onRevoked: () => {},
      fetchImpl: async () => {
        exchanges++
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
      },
    })
    const erin = { organizationId: 'org1', actorUserId: 'erin' }
    const runner = new delivery.RunnerDelivery({
      link: () => link(api),
      delegations,
      linker: () => 'owner',
      // Delays run as written, so a pass that ignores the waiting time shows up as extra exchanges.
      setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 60_000))) as typeof setTimeout,
    })
    runner.start()
    try {
      queueTask('For Erin', 'erin')
      await until(() => runner.waitingReason(erin) !== null)
      expect(runner.waitingReason(erin)).toContain('Reconnect')
      expect(runner.currentStatus().error).toBeNull()

      for (let write = 0; write < 30; write++) {
        queueTask(`Busy turn ${write}`, 'erin')
        await tick()
      }
      expect(exchanges).toBe(1)
      expect(outbox.listCloudOutboxOps(erin, 100)).toHaveLength(31)
    } finally {
      await runner.stop()
      await api.stop()
      outbox.ackCloudOutboxOpsThrough(erin, Number.MAX_SAFE_INTEGER)
    }
  })

  test('a failed pass keeps its backoff while writes keep arriving', async () => {
    const api = new FakeApi()
    await api.start()
    api.online = false
    let passes = 0
    const counting = new FakeDelegations()
    const accessToken = counting.accessToken.bind(counting)
    counting.accessToken = async (userId, organizationId) => { passes++; return accessToken(userId, organizationId) }
    const runner = new delivery.RunnerDelivery({
      link: () => link(api),
      delegations: counting,
      linker: () => 'owner',
      setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 60_000))) as typeof setTimeout,
    })
    runner.start()
    try {
      queueTask('While down')
      await until(() => runner.currentStatus().error !== null)
      const afterFailure = passes
      for (let write = 0; write < 30; write++) {
        queueTask(`Still down ${write}`)
        await tick()
      }
      expect(passes).toBe(afterFailure)
    } finally {
      await runner.stop()
      await api.stop()
      outbox.ackCloudOutboxOpsThrough(bobIn('org1'), Number.MAX_SAFE_INTEGER)
    }
  })

  test('removal ends everything: a refused person\'s undelivered rows are dropped, and another person\'s in the same organization still go', async () => {
    // WHY: removal ends everything, including output waiting to be sent (plans/010-standard-oauth.md §2).
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    delegations.refused.add('mallory')
    outbox.recordOutboxOp({ domain: 'works', resourceId: 'work-m', name: 'create', payload: { title: 'M' }, destination: 'cloud', organizationId: 'orgA', actorUserId: 'mallory' })
    mirrorLog.appendMirror({ organizationId: 'orgA', actorUserId: 'mallory' }, 'transcripts', [{ key: 's-m:0', payload: { sessionId: 's-m', position: 0, message: { role: 'user', content: 'hi' } } }])
    outbox.recordOutboxOp({ domain: 'works', resourceId: 'work-c', name: 'create', payload: { title: 'C' }, destination: 'cloud', organizationId: 'orgA', actorUserId: 'carol' })
    const runner = startDelivery(api, delegations)
    try {
      await api.next('outbox')
      await until(() => outbox.cloudOutboxDestinations().length === 0 && mirrorLog.mirrorDestinations().length === 0)
      expect(api.outboxBatches.map((batch) => [batch.authorization, batch.body.ops.map((entry) => entry.op.resourceId)])).toEqual([['Bearer delegated-carol-orgA', ['work-c']]])
      expect(api.mirrorBatches).toEqual([])
      expect(runner.currentStatus().error).toBeNull()
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('a linked personal machine keeps its agent\'s tasks and works local; nothing is queued for any organization', async () => {
    onManagedHost(null)
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    const runner = startDelivery(api, delegations)
    try {
      const created = await taskTools.createTaskAgentTool.execute({ title: 'Personal task' }, toolContext())
      expect(created.ok).toBe(true)
      expect((await taskStore.listTasks('local')).tasks.map((row) => row.title)).toContain('Personal task')
      const work = await workTools.createWorkAgentTool.execute({ title: 'Personal doc', doc_type: 'doc', content: '# Doc' }, toolContext())
      expect(work.ok).toBe(true)
      expect((await works.listWorks('local')).map((row) => row.title)).toEqual(['Personal doc'])
      await tick()
      expect(outbox.cloudOutboxDestinations()).toEqual([])
      expect(delegations.asked).toEqual([])
    } finally {
      await runner.stop()
      await api.stop()
      onManagedHost('org1')
    }
  })
})
