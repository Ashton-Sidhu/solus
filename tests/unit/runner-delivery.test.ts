import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { beforeEach, afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { HostRegistration } from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/simplify-auth-and-sync.md §4.5, plans/010-standard-oauth.md: every row of
// the host's one queue — session record facts and mirrored rows — names its
// organization and the person whose work it is.
// A pass visits every destination and sends its rows on one route, `/runner/deliver`,
// with that person's delegated token, in sequence order, and acknowledges per
// destination. Writes inside a collect window go in one request. A person the host
// cannot act for yet waits; a refused person's rows are dropped, and nobody else's.
// Delivery never blocks the tool, survives a restart, and backs off.

let delivery: typeof import('@solus/server/sync/runner-delivery')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let queue: typeof import('@solus/server/sync/delivery-queue')
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
  queue = await import('@solus/server/sync/delivery-queue')
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
  hostCategory.adoptProvisionedRegistration(organizationId ? { organizationId } : null)
}

/**
 * An organization session on this attached machine: its record is born published in
 * the organization, and its tools answer the Solus API, which these tests never reach
 * for a create or read, so the installed operations refuse every call.
 */
async function installOrganizationSession(sessionId: string, organizationId: string, api?: Partial<import('@solus/server/data/workspace/operations').WorkspaceOperations>): Promise<() => void> {
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  const { useOrganizationAttachment } = await import('@solus/server/host/organization-attachment')
  const { createWorkspaceOperations } = await import('@solus/server/data/workspace/service')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  records.rememberSessionBirth(sessionId, { organizationId, published: true, ownerKey: 'user-alice', admissionId: sessionId })
  await records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
  useOrganizationAttachment(() => 1)
  const unreachable = new Proxy(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), {
    get: (_target, name) => (api && typeof name === 'string' && name in api ? Reflect.get(api, name) : () => Promise.reject(new Error('the test API is not called'))),
  })
  const uninstall = installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'test-host', () => unreachable)
  return () => { uninstall(); useOrganizationAttachment(() => null) }
}

/** One transcript row queued for org1 as `actorUserId`'s, as a published session's turn is. */
let queuedLines = 0
function queueLine(content: string, actorUserId = 'bob'): void {
  const position = queuedLines++
  queue.appendDelivery({ organizationId: 'org1', actorUserId }, 'transcript', [{ key: `s-org:${position}`, payload: { sessionId: 's-org', position, message: { role: 'user', content } } }])
}

const HOST_ID = 'runner-host-1'

const deliverBodySchema = z.object({ hostId: z.string(), items: z.array(z.object({ seq: z.number(), kind: z.string(), payload: z.unknown() })) })
type DeliverBody = z.infer<typeof deliverBodySchema>

/** The Solus API's runner route. Each batch records the token it came with: whose work, in which organization. */
class FakeApi {
  readonly batches: Array<{ authorization: string | null; protocol: string | null; body: DeliverBody }> = []
  online = true
  unauthorizedOnce = false
  /** Items the API refuses for good: skipped and named. */
  permanentSeqs = new Set<number>()
  /** An item the API cannot apply yet: the batch stops before it, once. */
  transientSeq: number | null = null
  private waiters: Array<() => void> = []
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
        if (request.url !== '/runner/deliver') return json(404, { error: 'not found' })
        const body = deliverBodySchema.parse(JSON.parse(raw))
        const protocol = typeof request.headers['solus-protocol'] === 'string' ? request.headers['solus-protocol'] : null
        this.batches.push({ authorization, protocol, body })
        let lastSeq = 0
        const failed: Array<{ seq: number; error: string }> = []
        for (const item of body.items) {
          if (item.seq === this.transientSeq) { this.transientSeq = null; break }
          if (this.permanentSeqs.has(item.seq)) failed.push({ seq: item.seq, error: 'gone' })
          lastSeq = item.seq
        }
        for (const wake of this.waiters.splice(0)) wake()
        json(200, { lastSeq, failed })
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

  /** Resolves on the next request: the test waits on the wire, never on a timer. */
  next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  items(): DeliverBody['items'] {
    return this.batches.flatMap((batch) => batch.body.items)
  }
}

/** The host's delegations as delivery sees them: who is away, who was refused, and every token asked for. */
class FakeDelegations {
  readonly asked: string[] = []
  /** People with no token here yet: their rows wait. */
  readonly away = new Set<string>()
  /** People the account plane refused: removal ends everything. */
  readonly refused = new Set<string>()
  async accessToken(userId: string, scope: { organizationId: string }, _resource: { kind: 'api' }): Promise<string> {
    if (this.refused.has(userId)) throw new delegationsModule.DelegationError('ORGANIZATION_ACCESS_REFUSED', 'The person is not a member of the organization.')
    if (this.away.has(userId)) throw new delegationsModule.DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'Nobody has connected as this person yet.')
    this.asked.push(`${userId}/${scope.organizationId}`)
    return `delegated-${userId}-${scope.organizationId}`
  }
}

function link(api: FakeApi): HostRegistration {
  return { hostId: HOST_ID, issuer: api.url, jwksUrl: `${api.url}/jwks`, directoryUrl: api.url, hostname: 'h.lab.invalid', proxiedPort: 1, generation: 1, apiUrl: api.url }
}

function startDelivery(api: FakeApi, delegations: delivery.DeliveryDelegations = new FakeDelegations(), options: { linked?: () => boolean; maxDelayMs?: number } = {}) {
  const linked = options.linked ?? (() => true)
  const maxDelayMs = options.maxDelayMs ?? 20
  const instance = new delivery.RunnerDelivery({
    registration: () => (linked() ? link(api) : null),
    delegations,
    // Rows no person was named for go as the person who linked the host.
    owner: () => 'owner',
    // Backoff and waiting delays are real; the test shortens them to keep the proof fast.
    setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, maxDelayMs))) as typeof setTimeout,
  })
  instance.start()
  return instance
}

const toolContext = (): AgentToolContext => ({
  provider: 'claude-code',
  cwd: dataDir,
  sessionId: () => 'solus-1',
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits, a tick at a time, for a condition the delivery reaches on its own. */
async function until(condition: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

const bobIn = (organizationId: string) => ({ organizationId, actorUserId: 'bob' })
/** A destination no person was named for: the host's linker carries it. */
const linkerIn = (organizationId: string) => ({ organizationId, actorUserId: '' })

async function ownRecord(sessionId: string) {
  await records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', title: 'First words', lastActivityAt: 1 })
}

describe('who delivers a record', () => {
  test('a person with an account delivers their own records; the host\'s own records go as the account that linked it', () => {
    // WHY (docs/plans/access-model.md §2.2): every record has an owner now, and the host's own
    // records are its `local` user's. No delegation names a local user, so those rows must
    // travel with the linking account's token or they wait forever.
    expect(queue.deliveryActorOf('user-alice')).toBe('user-alice')
    expect(queue.deliveryActorOf('local:host-1')).toBe('')
    // With no host user, a record of the host's own is the host-owner sentinel's: the linker carries it.
    expect(queue.deliveryActorOf('host-owner')).toBe('')
    expect(queue.deliveryActorOf('')).toBe('')
  })
})

describe('runner delivery', () => {
  test('ten writes within the collect window go in one request, on the one route, with the protocol the API checks', async () => {
    // WHY: a host sent one request per write, about one a second in production (§1).
    const api = new FakeApi()
    await api.start()
    const runner = startDelivery(api)
    try {
      const sent = api.next()
      for (let write = 0; write < 10; write++) queueLine(`note ${write}`)
      await sent
      expect(api.batches).toHaveLength(1)
      expect(api.batches[0]).toMatchObject({ authorization: 'Bearer delegated-bob-org1', protocol: '2', body: { hostId: HOST_ID } })
      expect(api.items().map((item) => item.kind)).toEqual(Array(10).fill('transcript'))
      await until(() => queue.deliveryDestinations().length === 0)
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test("an organization session's comment and links reach its Solus API directly; nothing is queued and nothing is applied here", async () => {
    // WHY (docs/plans/simplify-auth-and-sync.md §4.5): a runner's remaining organization
    // writes call the Solus API, as task and work creation do; the delivery stream carries none.
    const api = new FakeApi()
    await api.start()
    const runner = startDelivery(api)
    const calls: Array<[string, unknown]> = []
    const stopTools = await installOrganizationSession('solus-org', 'org1', {
      createTaskComment: async (_context, taskId, input) => { calls.push(['createTaskComment', { taskId, ...input }]); return { id: 'c1', taskId, body: input.body, author: null, originSessionId: input.originSessionId ?? null, createdAt: new Date().toISOString() } },
      putLink: async (_context, input) => { calls.push(['putLink', input]) },
    })
    const inOrganizationSession = (): AgentToolContext => ({ ...toolContext(), sessionId: () => 'solus-org' })
    try {
      // The published session's own record goes first, as its owner.
      await until(() => api.items().some((item) => item.kind === 'session'))
      await until(() => queue.deliveryDestinations().length === 0)
      const sent = api.items().length

      const commented = await taskTools.commentTaskAgentTool.execute({ task_id: 'task-org', body: 'note' }, inOrganizationSession())
      expect(commented).toEqual({ ok: true, text: 'Comment added to task task-org.' })
      expect((await taskTools.linkAgentTool.execute({ task_id: 'task-org', kind: 'session' }, inOrganizationSession())).ok).toBe(true)
      expect((await taskTools.linkAgentTool.execute({ task_id: 'task-org', kind: 'work', target_id: 'work-1', title: 'Spec' }, inOrganizationSession())).ok).toBe(true)
      expect(calls).toEqual([
        ['createTaskComment', { taskId: 'task-org', body: 'note', originSessionId: 'solus-org' }],
        ['putLink', { from: { kind: 'task', id: 'task-org' }, to: { kind: 'session', id: 'solus-org' }, role: 'working' }],
        ['putLink', { from: { kind: 'task', id: 'task-org' }, to: { kind: 'work', id: 'work-1' }, title: 'Spec', originSessionId: 'solus-org' }],
      ])
      await tick()
      expect(queue.deliveryDestinations()).toEqual([])
      expect(api.items()).toHaveLength(sent)
      expect(outbox.listOutboxOps()).toEqual([])
      expect((await taskStore.listTasks(principal.ANY_ORGANIZATION)).tasks).toEqual([])
    } finally {
      stopTools()
      await runner.stop()
      await api.stop()
    }
  })

  test('a session record is queued only once it is published, stamped with the host, and its facts coalesce while it waits', async () => {
    // WHY: assigning a session to an organization sends its Insights, not its
    // record or transcript (§3); those leave only through a publication (§7). A
    // turn changes a record many times: one row per session waits, not one per change.
    const api = new FakeApi()
    await api.start()
    api.online = false
    const runner = startDelivery(api)
    try {
      await records.upsertSessionRecord('local', { sessionId: 's-local', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
      await records.markSessionPublished('s-local')
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-local', 'running')
      expect(queue.deliveryDestinations()).toEqual([])

      await ownRecord('s-mirror')
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-mirror', 'running')
      expect(queue.deliveryDestinations()).toEqual([])

      await records.markSessionPublished('s-mirror')
      await records.setSessionRecordTitle(principal.ANY_ORGANIZATION, 's-mirror', 'Renamed')
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-mirror', 'idle')
      const queued = queue.listDelivery(linkerIn('org1'), 10)
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ kind: 'session', payload: { sessionId: 's-mirror', title: 'First words', status: 'idle', customTitle: 'Renamed', runnerHostId: HOST_ID } })

      api.online = true
      await until(() => queue.deliveryDestinations().length === 0)
      const sent = api.items().filter((item) => item.kind === 'session')
      expect(sent).toHaveLength(1)
      expect(api.batches.at(-1)?.authorization).toBe('Bearer delegated-owner-org1')
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('session records are followed only while a link exists, so an unlinked host pays nothing per record write', async () => {
    // WHY: following records makes every record write read the row back, several
    // times per turn. An unlinked host would drop the facts anyway.
    const api = new FakeApi()
    await api.start()
    api.online = false
    let linked = false
    const runner = startDelivery(api, new FakeDelegations(), { linked: () => linked })
    const connection = dbModule.getDb() as unknown as { prepare: (text: string) => unknown }
    const prepare = connection.prepare.bind(connection)
    let readBacks = 0
    connection.prepare = (text: string) => {
      if (/^\s*select[\s\S]*from "session_records"/i.test(text)) readBacks++
      return prepare(text)
    }
    try {
      await ownRecord('s-follow')
      await records.markSessionPublished('s-follow')
      readBacks = 0
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'running')
      expect(readBacks).toBe(0)

      linked = true
      runner.registrationChanged()
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'idle')
      expect(readBacks).toBe(1)
      expect(queue.listDelivery(linkerIn('org1'), 10).filter((item) => item.kind === 'session')).toHaveLength(1)

      linked = false
      runner.registrationChanged()
      readBacks = 0
      await records.setSessionRecordStatus(principal.ANY_ORGANIZATION, 's-follow', 'running')
      expect(readBacks).toBe(0)
    } finally {
      connection.prepare = prepare
      await runner.stop()
      await api.stop()
      queue.dropQueuedFor(linkerIn('org1'))
    }
  })

  test('a permanent failure skips one item and the rest are delivered; it stays named in the queue', async () => {
    const api = new FakeApi()
    await api.start()
    api.online = false
    const runner = startDelivery(api)
    try {
      queueLine('first')
      queueLine('doomed')
      queueLine('third')
      const [, doomed] = queue.listDelivery(bobIn('org1'), 10)
      api.permanentSeqs.add(doomed!.seq)
      api.online = true
      await until(() => queue.deliveryDestinations().length === 0)
      expect(api.items()).toHaveLength(3)
      expect(queue.deliveryBacklog()).toEqual([{ organizationId: 'org1', pending: 0, failed: 1 }])
      expect(runner.currentStatus().error).toBeNull()
    } finally {
      await runner.stop()
      await api.stop()
      queue.dropQueuedFor(bobIn('org1'))
    }
  })

  test('a transient failure stops the batch there; the rest is sent again and lands', async () => {
    const api = new FakeApi()
    await api.start()
    api.online = false
    const runner = startDelivery(api)
    try {
      queueLine('one')
      queueLine('not yet')
      queueLine('three')
      const [, deferred, last] = queue.listDelivery(bobIn('org1'), 10)
      api.transientSeq = deferred!.seq
      api.online = true
      await until(() => queue.deliveryDestinations().length === 0)
      // The first request applied only the first item; the second carried the rest.
      expect(api.batches.map((batch) => batch.body.items.map((item) => item.seq))).toEqual([[deferred!.seq - 1, deferred!.seq, last!.seq], [deferred!.seq, last!.seq]])
      expect(queue.deliveryBacklog()).toEqual([])
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('a 401 or an outage backs off and tries again; a restart resumes from the queue', async () => {
    const api = new FakeApi()
    await api.start()
    let runner = startDelivery(api)
    try {
      queueLine('First')
      await until(() => api.items().length === 1)

      api.unauthorizedOnce = true
      queueLine('After a 401')
      await until(() => api.items().length === 2)

      // The service goes away; the write is queued, the host keeps working, and the next process delivers it.
      api.online = false
      queueLine('While offline')
      await until(() => runner.currentStatus().error !== null)
      expect(runner.currentStatus().error).toContain('503')
      expect(queue.listDelivery(bobIn('org1'), 10)).toHaveLength(1)
      await runner.stop()
      api.online = true
      runner = startDelivery(api)
      await until(() => queue.deliveryDestinations().length === 0)
      expect(api.items().at(-1)?.payload).toMatchObject({ message: { content: 'While offline' } })
      expect(runner.currentStatus().error).toBeNull()
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('the rows of a person with no token here wait until they connect, then go with their token', async () => {
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    delegations.away.add('dana')
    const runner = startDelivery(api, delegations)
    try {
      queueLine('While Dana is away', 'dana')
      await until(() => delegations.asked.length === 0 && api.batches.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(api.batches).toEqual([])
      expect(runner.currentStatus().error).toBeNull()

      delegations.away.delete('dana')
      runner.retryWaiting()
      await until(() => api.batches.length === 1)
      expect(api.batches[0]).toMatchObject({ authorization: 'Bearer delegated-dana-org1' })
      await until(() => queue.deliveryDestinations().length === 0)
    } finally {
      await runner.stop()
      await api.stop()
    }
  })

  test('a 403 from the token endpoint waits for the person to connect; a stream of writes does not turn it into a request loop', async () => {
    // WHY: a 403 was treated as an outage. Every queued write kicked a new pass past
    // the backoff, so a busy turn asked Solus for a token hundreds of times.
    const api = new FakeApi()
    await api.start()
    let exchanges = 0
    const delegations = new delegationsModule.Delegations({
      registration: () => link(api),
      credential: () => ({ clientId: 'host-client', tokenEndpoint: 'https://cloud.invalid/api/auth/oauth2/token', assertion: async () => 'signed-assertion' }),
      onRevoked: () => {},
      fetchImpl: async (_url, init) => {
        // Erin's client made the delegation; its first token is about to end, and every refresh is forbidden.
        if (new URLSearchParams(String(init?.body)).get('grant_type') !== 'refresh_token') return Response.json({ access_token: 'erin-first', refresh_token: 'erin-refresh', expires_in: 1 })
        exchanges++
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
      },
    })
    delegations.clear()
    const erinsToken = `e30.${Buffer.from(JSON.stringify({ sub: 'erin', grant_id: 'grant_erin' })).toString('base64url')}.c2ln`
    await delegations.establish(erinsToken, { organizationId: 'org1' })
    const erin = { organizationId: 'org1', actorUserId: 'erin' }
    // Delays run as written, so a pass that ignores the waiting time shows up as extra exchanges.
    const runner = startDelivery(api, delegations, { maxDelayMs: 60_000 })
    try {
      queueLine('For Erin', 'erin')
      await until(() => exchanges === 1)
      expect(runner.currentStatus().error).toBeNull()
      for (let write = 0; write < 30; write++) {
        queueLine(`Busy turn ${write}`, 'erin')
        await tick()
      }
      expect(exchanges).toBe(1)
      expect(queue.listDelivery(erin, 100)).toHaveLength(31)
    } finally {
      await runner.stop()
      await api.stop()
      queue.dropQueuedFor(erin)
    }
  })

  test('a failed pass keeps its backoff while writes keep arriving', async () => {
    const api = new FakeApi()
    await api.start()
    api.online = false
    let passes = 0
    const counting = new FakeDelegations()
    const accessToken = counting.accessToken.bind(counting)
    counting.accessToken = async (userId, scope, resource) => { passes++; return accessToken(userId, scope, resource) }
    const runner = startDelivery(api, counting, { maxDelayMs: 60_000 })
    try {
      queueLine('While down')
      await until(() => runner.currentStatus().error !== null)
      const afterFailure = passes
      for (let write = 0; write < 30; write++) {
        queueLine(`Still down ${write}`)
        await tick()
      }
      expect(passes).toBe(afterFailure)
    } finally {
      await runner.stop()
      await api.stop()
      queue.dropQueuedFor(bobIn('org1'))
    }
  })

  test('removal ends everything: a refused person\'s undelivered rows are dropped, and another person\'s in the same organization still go', async () => {
    // WHY: removal ends everything, including output waiting to be sent (plans/010-standard-oauth.md §2).
    const api = new FakeApi()
    await api.start()
    const delegations = new FakeDelegations()
    delegations.refused.add('mallory')
    queue.appendDelivery({ organizationId: 'orgA', actorUserId: 'mallory' }, 'activity', [{ key: 'm', payload: {} }])
    queue.appendDelivery({ organizationId: 'orgA', actorUserId: 'mallory' }, 'transcript', [{ key: 's-m:0', payload: { sessionId: 's-m', position: 0, message: { role: 'user', content: 'hi' } } }])
    queue.appendDelivery({ organizationId: 'orgA', actorUserId: 'carol' }, 'activity', [{ key: 'c', payload: {} }])
    const runner = startDelivery(api, delegations)
    try {
      await until(() => queue.deliveryDestinations().length === 0)
      expect(api.batches.map((batch) => [batch.authorization, batch.body.items.map((item) => item.kind)])).toEqual([['Bearer delegated-carol-orgA', ['activity']]])
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
      expect(queue.deliveryDestinations()).toEqual([])
      expect(delegations.asked).toEqual([])
    } finally {
      await runner.stop()
      await api.stop()
      onManagedHost('org1')
    }
  })
})
