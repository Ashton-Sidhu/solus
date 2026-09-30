import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { HostOrganizationsResponse, UplinkLinkConfig } from '@solus/contracts/uplink'
import type { WorkspaceCreateTask, WorkspaceCreateWork, WorkspaceTask, WorkspaceWork } from '@solus/contracts/solus-api'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/009-organization-vms.md §1, §3, §4: on a machine attached for organization
// work, a new root session starts in an organization on the Solus API or not at all;
// the API accepts it before its provider starts, and its record is born published,
// owned by the verified person. Existing personal sessions continue where they live.
// Its agent's tools read and write where the session's records live. A pairing
// connection keeps only Local records. The API takes a session's owner from the
// admission, never from the host's report.

let turnOrganization: typeof import('@solus/server/execution/sessions/turn-organization')
let actorFor: typeof import('@solus/server/admission/actor')['actorFor']
let organizations: typeof import('@solus/server/host/organizations')
let hostCategory: typeof import('@solus/server/host/host-category')
let attachment: typeof import('@solus/server/host/organization-attachment')
let insightMirror: typeof import('@solus/server/sync/mirror/insight-mirror')
let records: typeof import('@solus/server/data/sessions/session-records')
let principalModule: typeof import('@solus/server/admission/principal')
let toolContext: typeof import('@solus/server/data/workspace/tool-context')
let service: typeof import('@solus/server/data/workspace/service')
let taskTools: typeof import('@solus/server/execution/agents/tools/task-tools')
let workTools: typeof import('@solus/server/execution/agents/tools/work-tools')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let works: typeof import('@solus/server/data/works/works')
let intake: typeof import('@solus/server/sync/runner-intake')
let sessionApi: typeof import('@solus/server/data/sessions/api-operations')
let shareManager: typeof import('@solus/server/sharing/share-manager')
let database: typeof import('@solus/server/db/database')
let dbModule: typeof import('@solus/server/db')
type Principal = import('@solus/server/admission/principal').Principal
type WorkspaceOperations = import('@solus/server/data/workspace/operations').WorkspaceOperations
type AgentToolContext = import('@solus/server/execution/agents/tools/agent-tool').AgentToolContext

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let hostOrganizations: InstanceType<typeof organizations.HostOrganizations>
let shares: import('@solus/server/sharing/share-manager').ShareManager

const LINK: UplinkLinkConfig = { hostId: 'VM', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', hostname: 'h-VM.lab.invalid', proxiedPort: 1, connectionGeneration: 1, apiUrl: 'https://api.invalid' }
const STANDING: HostOrganizationsResponse = {
  hostId: 'VM',
  category: 'self-hosted',
  owner: { userId: 'alice', email: 'alice@example.test', name: 'Alice' },
  organizations: [
    { organizationId: 'A', name: 'Acme', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: true } },
    { organizationId: 'B', name: 'Bolt', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false } },
  ],
}

/** What the host's delegations were asked, and how they answer: the Solus API and account plane stand behind them (sync/delegations.ts). */
class FakeDelegations {
  readonly calls: Array<{ sessionId: string; userId: string; organizationId: string; admit: boolean }> = []
  refusal: { code: string; message: string } | null = null
  async actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean }): Promise<void> {
    this.calls.push(input)
    if (this.refusal) throw Object.assign(new Error(this.refusal.message), { code: this.refusal.code })
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-organization-vm-records-'))
  process.env.SOLUS_DATA_DIR = dataDir
  turnOrganization = await import('@solus/server/execution/sessions/turn-organization')
  ;({ actorFor } = await import('@solus/server/admission/actor'))
  organizations = await import('@solus/server/host/organizations')
  hostCategory = await import('@solus/server/host/host-category')
  attachment = await import('@solus/server/host/organization-attachment')
  insightMirror = await import('@solus/server/sync/mirror/insight-mirror')
  records = await import('@solus/server/data/sessions/session-records')
  principalModule = await import('@solus/server/admission/principal')
  toolContext = await import('@solus/server/data/workspace/tool-context')
  service = await import('@solus/server/data/workspace/service')
  taskTools = await import('@solus/server/execution/agents/tools/task-tools')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  taskStore = await import('@solus/server/data/tasks/task-store')
  works = await import('@solus/server/data/works/works')
  intake = await import('@solus/server/sync/runner-intake')
  sessionApi = await import('@solus/server/data/sessions/api-operations')
  shareManager = await import('@solus/server/sharing/share-manager')
  database = await import('@solus/server/db/database')
  dbModule = await import('@solus/server/db')
  shares = new shareManager.ShareManager({ db: database.getDatabase() })
  hostOrganizations = new organizations.HostOrganizations({
    link: () => LINK,
    hostToken: () => 'sht_token',
    fetchImpl: async () => new Response(JSON.stringify(STANDING), { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeoutFn: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  })
  await hostOrganizations.refresh()
  insightMirror.useInsightsPolicy({ syncAllInsights: () => null, optedIn: () => false, attached: () => false })
})

beforeEach(() => {
  // A customer's own VM, attached for organization work.
  hostCategory.resetHostCategoryForTests()
  hostCategory.applyHostCategory('self-hosted')
  attachment.useOrganizationAttachment(() => 1_000)
})

afterAll(async () => {
  hostCategory.resetHostCategoryForTests()
  attachment.useOrganizationAttachment(() => null)
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const PAIRED: Principal = { kind: 'local-owner', deviceId: 'phone', deviceLabel: 'Phone' }
const ALICE: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'account-session', expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }
const BOB_IN_A: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd-bob', expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }

const ctx = (sessionId: string, organizationId?: string, extra: Partial<IpcContext['session']> = {}): IpcContext => ({ session: { sessionId, organizationId, ...extra } } as IpcContext)
const localRecord = (sessionId: string) => records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
const recordOf = (sessionId: string) => records.getSessionRecord(principalModule.ANY_ORGANIZATION, sessionId)

describe('the link transition', () => {
  test('a new root on an attached machine needs an organization: a pairing connection and an owner\'s Local window are refused, and nothing is born', async () => {
    const authorities = new FakeDelegations()
    const deps = { hostOrganizations, delegations: authorities }
    await expect(turnOrganization.admitTurnOrganization(ctx('s-paired'), actorFor(PAIRED), deps)).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED' })
    await expect(turnOrganization.admitTurnOrganization(ctx('s-local-window', 'local'), actorFor(ALICE), deps)).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED' })
    expect(authorities.calls).toEqual([])
    expect(turnOrganization.pendingOrganizationFor('s-paired')).toBeNull()
    expect(turnOrganization.pendingOrganizationFor('s-local-window')).toBeNull()
  })

  test('the owner\'s window in A starts an API session: the API admits it first, and the record is born published, owned by the verified person, under that admission', async () => {
    const authorities = new FakeDelegations()
    expect(await turnOrganization.admitTurnOrganization(ctx('s-new', 'A'), actorFor(ALICE), { hostOrganizations, delegations: authorities })).toBe('A')
    expect(authorities.calls).toEqual([{ sessionId: 's-new', userId: 'alice', organizationId: 'A', admit: true }])
    // The provider thread id arrives at session start; the record is born in its API home.
    turnOrganization.applyPendingAssignment('s-new', 'thread-new')
    expect(await localRecord('thread-new')).toMatchObject({ organizationId: 'A', publication: 'published', ownerUserId: 'alice' })
    expect(records.admissionIdFor('thread-new')).toBe('s-new')

    // The indexer can write the record first, as Local: the admitted home is applied whole.
    await turnOrganization.admitTurnOrganization(ctx('s-raced', 'B'), actorFor(ALICE), { hostOrganizations, delegations: authorities })
    await localRecord('thread-raced')
    turnOrganization.applyPendingAssignment('s-raced', 'thread-raced')
    // The assignment is queued behind the record's other writes; the next write waits for it.
    await records.setSessionRecordTitle(principalModule.ANY_ORGANIZATION, 'thread-raced', null)
    expect(await recordOf('thread-raced')).toMatchObject({ organizationId: 'B', publication: 'published', ownerUserId: 'alice' })
  })

  test('an API refusal or outage prevents the start; nothing waits to be born, and the next attempt asks again', async () => {
    const authorities = new FakeDelegations()
    authorities.refusal = { code: 'ORGANIZATION_API_UNAVAILABLE', message: 'The Solus API is not reachable.' }
    await expect(turnOrganization.admitTurnOrganization(ctx('s-outage', 'A'), actorFor(ALICE), { hostOrganizations, delegations: authorities })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(turnOrganization.pendingOrganizationFor('s-outage')).toBeNull()
    authorities.refusal = null
    expect(await turnOrganization.admitTurnOrganization(ctx('s-outage', 'A'), actorFor(ALICE), { hostOrganizations, delegations: authorities })).toBe('A')
    // The retry is the same admission (the API answers the same one); a later prompt before the record exists asks nothing more.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-outage', 'A'), actorFor(ALICE), { hostOrganizations, delegations: authorities })).toBe('A')
    expect(authorities.calls.map((call) => [call.sessionId, call.admit])).toEqual([['s-outage', true], ['s-outage', true]])
  })

  test('a session admitted before the attachment continues Local, even from a pairing connection; a personal fork stays personal; an organization fork is a new admission', async () => {
    const authorities = new FakeDelegations()
    const deps = { hostOrganizations, delegations: authorities }
    attachment.useOrganizationAttachment(() => null)
    await localRecord('s-before')
    attachment.useOrganizationAttachment(() => 1_000)
    expect(await turnOrganization.admitTurnOrganization(ctx('s-before', 'A'), actorFor(PAIRED), deps)).toBe('local')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-before', 'A'), actorFor(ALICE), deps)).toBe('local')
    // Nothing assigned it, and nothing asked the API.
    expect(await recordOf('s-before')).toMatchObject({ organizationId: 'local', publication: 'local' })
    expect(authorities.calls).toEqual([])
    expect(await turnOrganization.admitTurnOrganization(ctx('s-fork-personal', 'A', { forked: true, agentSessionId: 's-before' }), actorFor(ALICE), deps)).toBe('local')
    expect(authorities.calls).toEqual([])
    expect(await turnOrganization.admitTurnOrganization(ctx('s-fork-org', 'B', { forked: true, agentSessionId: 'thread-new' }), actorFor(ALICE), deps)).toBe('A')
    expect(authorities.calls).toEqual([{ sessionId: 's-fork-org', userId: 'alice', organizationId: 'A', admit: true }])
  })

  test('each turn of an API session needs the person again: a removed membership stops new turns and new answers, and another organization is unaffected', async () => {
    const authorities = new FakeDelegations()
    const deps = { hostOrganizations, delegations: authorities }
    expect(await turnOrganization.admitTurnOrganization(ctx('s-new', 'A', { agentSessionId: 'thread-new' }), actorFor(ALICE), deps)).toBe('A')
    expect(authorities.calls).toEqual([{ sessionId: 's-new', userId: 'alice', organizationId: 'A', admit: false }])
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-new', 'thread-new', deps)).toBe(true)
    authorities.refusal = { code: 'ORGANIZATION_ACCESS_REFUSED', message: 'You are no longer a member of this organization.' }
    await expect(turnOrganization.admitTurnOrganization(ctx('s-new', 'A', { agentSessionId: 'thread-new' }), actorFor(ALICE), deps)).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-new', 'thread-new', deps)).toBe(false)
    // A Local session needs no organization authority to answer.
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-before', 's-before', deps)).toBe(true)
  })

  test('a member admitted for organization work records the attachment; a person\'s own computer is never attached', async () => {
    let marked = 0
    const authorities = new FakeDelegations()
    expect(await turnOrganization.admitTurnOrganization(ctx('s-bob', 'A'), actorFor(BOB_IN_A), { hostOrganizations, delegations: authorities, markAttached: () => { marked++ } })).toBe('A')
    expect(marked).toBe(1)
    expect(authorities.calls.at(-1)).toEqual({ sessionId: 's-bob', userId: 'bob', organizationId: 'A', admit: true })

    // The desktop's own host, shared with an organization: its owner's scratch stays Local.
    hostCategory.applyHostCategory('personal')
    expect(attachment.isOrganizationAttached()).toBe(false)
    await localRecord('s-laptop')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-laptop', 'B'), actorFor(PAIRED), { hostOrganizations, delegations: authorities })).toBe('local')
  })
})

describe('shared compute, access on the record', () => {
  test('the organization\'s other members may open and watch an organization session on the VM, as on its API; the machine stays its owner\'s to administer', async () => {
    const scoped = new shareManager.ShareManager({ db: database.getDatabase(), organizationOfResource: async (resource) => (await recordOf(resource.id))?.organizationId ?? null })
    // A watch claimed the not-yet-admitted session first, for the machine's owner, as Local.
    await scoped.claimOwner({ kind: 'session', id: 's-live' }, ALICE)
    const authorities = new FakeDelegations()
    const admitted = await turnOrganization.admitTurnOrganization(ctx('s-live', 'A'), actorFor(ALICE), {
      hostOrganizations, delegations: authorities,
      adoptSession: (sessionId, organizationId, ownerUserId, options) => scoped.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerUserId, options),
    })
    expect(admitted).toBe('A')
    // The verified person owns it, in the organization; a colleague in A may edit it; B's members see nothing.
    expect(await scoped.ownerOf({ kind: 'session', id: 's-live' })).toBe('alice')
    const carolInA: Principal = { ...BOB_IN_A, userId: 'carol', organizationRole: 'owner' }
    expect(await scoped.roleFor(carolInA, { kind: 'session', id: 's-live' })).toBe('editor')
    const danInB: Principal = { ...BOB_IN_A, userId: 'dan', organizationId: 'B' }
    expect(await scoped.roleFor(danInB, { kind: 'session', id: 's-live' })).toBe('none')
    // Owning an organization is not administering a customer's machine.
    expect(principalModule.isHostAdmin(carolInA)).toBe(false)
    // A resource of another organization is never taken over by a later admission.
    await scoped.adoptForOrganization({ kind: 'session', id: 's-live' }, 'B', 'mallory', { shareWithOrganization: true })
    expect(await scoped.ownerOf({ kind: 'session', id: 's-live' })).toBe('alice')
  })

  // plans/004-shared-host-collaboration.md D14: a project session starts shared with
  // the organization; a chat is organization work too, but private until shared.
  test('a member\'s new chat is theirs alone until they share it; their new project session is the organization\'s', async () => {
    const scoped = new shareManager.ShareManager({ db: database.getDatabase(), organizationOfResource: async (resource) => (await recordOf(resource.id))?.organizationId ?? null })
    const deps = {
      hostOrganizations, delegations: new FakeDelegations(),
      adoptSession: (sessionId: string, organizationId: string, ownerUserId: string, options: { shareWithOrganization: boolean }) =>
        scoped.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerUserId, options),
    }
    const carolInA: Principal = { ...BOB_IN_A, userId: 'carol' }
    const chat = { kind: 'session', id: 's-bob-chat' } as const
    const project = { kind: 'session', id: 's-bob-project' } as const

    expect(await turnOrganization.admitTurnOrganization(ctx(chat.id, 'A', { workingDirectory: '~' }), actorFor(BOB_IN_A), deps)).toBe('A')
    expect(await turnOrganization.admitTurnOrganization(ctx(project.id, 'A', { workingDirectory: '/srv/repo' }), actorFor(BOB_IN_A), deps)).toBe('A')

    expect(await scoped.ownerOf(chat)).toBe('bob')
    expect(await scoped.roleFor(carolInA, chat)).toBe('none')
    expect(await scoped.roleFor(carolInA, project)).toBe('editor')

    await scoped.setGrants({ resource: chat, grants: [{ subject: { kind: 'organization', id: 'A' }, role: 'editor' }] }, BOB_IN_A)
    expect(await scoped.roleFor(carolInA, chat)).toBe('editor')
  })
})

describe('record scope on an attached machine', () => {
  test('a pairing connection keeps only its Local records; the owner\'s account and the host itself read the whole disk', async () => {
    expect(principalModule.recordScopeOf(PAIRED)).toBe('local')
    expect(principalModule.recordScopeOf(ALICE)).toBe(principalModule.ANY_ORGANIZATION)
    expect(principalModule.recordScopeOf(principalModule.INTERNAL_PRINCIPAL)).toBe(principalModule.ANY_ORGANIZATION)
    const scoped = new shareManager.ShareManager({ db: database.getDatabase(), organizationOfResource: async (resource) => (await recordOf(resource.id))?.organizationId ?? null })
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 's-before' })).toBe('owner')
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 'thread-new' })).toBe('none')
    expect(await scoped.roleFor(ALICE, { kind: 'session', id: 'thread-new' })).toBe('owner')
    // An unattached machine keeps the old owner rule.
    attachment.useOrganizationAttachment(() => null)
    expect(principalModule.recordScopeOf(PAIRED)).toBe(principalModule.ANY_ORGANIZATION)
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 'thread-new' })).toBe('owner')
  })
})

/** An organization's Solus API as an agent run reaches it: an in-memory record store behind the shared operations. */
function fakeOrganizationApi(organizationId: string) {
  const tasks = new Map<string, WorkspaceTask>()
  const createdWorks = new Map<string, WorkspaceWork>()
  const calls: string[] = []
  const now = new Date(0).toISOString()
  const home = { kind: 'organization' as const, serviceId: 'api', organizationId }
  const notFound = () => Object.assign(new Error('Resource not found.'), { status: 404, code: 'NOT_FOUND' })
  const operations: Partial<WorkspaceOperations> = {
    createTask: async (_context, input: WorkspaceCreateTask) => {
      calls.push(`createTask:${input.originSessionId}:${input.projectKey}`)
      const task: WorkspaceTask = { id: `task-${tasks.size + 1}`, home, organizationId, ownerUserId: 'alice', version: '1', createdAt: now, updatedAt: now, title: input.title, body: input.body ?? '', projectKey: input.projectKey ?? null, projectId: null, status: input.status ?? 'todo', assignee: null, priority: input.priority ?? null, labels: input.labels ?? [], dueDate: null, originSessionId: input.originSessionId ?? null, shortId: tasks.size + 1 }
      tasks.set(task.id, task)
      return task
    },
    getTask: async (_context, taskId) => { calls.push(`getTask:${taskId}`); const task = tasks.get(taskId); if (!task) throw notFound(); return task },
    updateTask: async (_context, taskId, input) => { calls.push(`updateTask:${taskId}`); const task = { ...tasks.get(taskId)!, ...input, version: '2' } as WorkspaceTask; tasks.set(taskId, task); return task },
    listTasks: async () => { calls.push('listTasks'); return { items: [...tasks.values()].map(({ body: _body, ...summary }) => summary), nextCursor: null } },
    createWork: async (_context, input: WorkspaceCreateWork) => {
      calls.push(`createWork:${input.originSessionId}`)
      const work: WorkspaceWork = { id: `work-${createdWorks.size + 1}`, home, organizationId, ownerUserId: 'alice', version: '1', createdAt: now, updatedAt: now, title: input.title, type: input.type, preview: '', sessionIds: input.originSessionId ? [input.originSessionId] : [], projectId: null, pinned: false, editable: true, cwd: '~', agentProvider: 'claude-code', content: input.content }
      createdWorks.set(work.id, work)
      return work
    },
    getWork: async (_context, workId) => { calls.push(`getWork:${workId}`); const work = createdWorks.get(workId); if (!work) throw notFound(); return work },
  }
  return { operations: operations as WorkspaceOperations, calls, tasks, works: createdWorks }
}

describe('an agent\'s record tools follow its session\'s home', () => {
  const agentIn = (recordId: string, solusSessionId: string): AgentToolContext => ({
    provider: 'claude-code', cwd: dataDir, sessionId: () => recordId, solusSessionId: () => solusSessionId,
    abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
  })

  test('an organization session reads and writes its Solus API, and the reads agree with the writes; nothing lands on this machine', async () => {
    const api = fakeOrganizationApi('A')
    const runs: Array<{ recordId: string; solusSessionId?: string }> = []
    const uninstall = toolContext.installWorkspaceToolOperations(service.createWorkspaceOperations(shares), 'vm', (run) => { runs.push(run); return api.operations })
    try {
      const created = await taskTools.createTaskAgentTool.execute({ title: 'Ship the VM plan' }, agentIn('thread-new', 's-new'))
      expect(created.ok).toBe(true)
      const taskId = /Task (\S+) —/.exec(created.text)?.[1]
      expect(taskId).toBe('task-1')
      const read = await taskTools.readTaskAgentTool.execute({ task_id: taskId! }, agentIn('thread-new', 's-new'))
      expect(read.text).toContain('Ship the VM plan')
      expect((await taskTools.updateTaskStatusAgentTool.execute({ task_id: taskId!, status: 'in_review' }, agentIn('thread-new', 's-new'))).text).toContain('in_review')
      const work = await workTools.createWorkAgentTool.execute({ title: 'VM notes', doc_type: 'doc', content: '# Notes' }, agentIn('thread-new', 's-new'))
      expect(work.text).toContain("saved in the organization's Solus API")
      const workId = /id: ([^)]+)\)/.exec(work.text)?.[1]
      expect((await workTools.readWorkAgentTool.execute({ work_id: workId! }, agentIn('thread-new', 's-new'))).text).toContain('# Notes')
      expect(api.calls).toEqual([`createTask:thread-new:${dataDir}`, `getTask:${taskId}`, `getTask:${taskId}`, `updateTask:${taskId}`, 'createWork:thread-new', `getWork:${workId}`])
      expect(runs.every((run) => run.recordId === 'thread-new' && run.solusSessionId === 's-new')).toBe(true)
      // Not one of them is in this machine's own store.
      expect((await taskStore.listTasks(principalModule.ANY_ORGANIZATION)).tasks).toEqual([])
      expect(await works.listWorks(principalModule.ANY_ORGANIZATION)).toEqual([])

      // A personal session on the same machine keeps writing here.
      const personal = await taskTools.createTaskAgentTool.execute({ title: 'Personal note' }, agentIn('s-before', 's-before'))
      expect(personal.ok).toBe(true)
      expect((await taskStore.listTasks('local')).tasks.map((task) => task.title)).toEqual(['Personal note'])
      expect(api.calls.filter((call) => call.startsWith('createTask'))).toHaveLength(1)
    } finally {
      uninstall()
    }
  })

  test('when the host acts for nobody in an organization session, its tool writes nothing anywhere and says why', async () => {
    const uninstall = toolContext.installWorkspaceToolOperations(service.createWorkspaceOperations(shares), 'vm', () => null)
    try {
      const refused = await taskTools.createTaskAgentTool.execute({ title: 'Lost?' }, agentIn('thread-new', 's-new'))
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain('holds no authority')
      expect((await taskStore.listTasks(principalModule.ANY_ORGANIZATION)).tasks.map((task) => task.title)).toEqual(['Personal note'])
    } finally {
      uninstall()
    }
  })
})

describe('the Solus API takes a session\'s owner from its admission', () => {
  const runner = (ownerUserId: string) => principalModule.runnerPrincipalFor({ hostId: 'VM', organizationId: 'A', ownerUserId, expiresAt: Date.now() + 600_000 })
  const delegatedContext = (userId = 'bob') => ({
    principal: { ...BOB_IN_A, userId } as Principal,
    home: { kind: 'organization' as const, serviceId: 'api', organizationId: 'A' },
    scopes: ['sessions:admit' as const],
    delegation: { hostId: 'VM' },
  })

  test('only a host acting for a person admits a session, once, for that person on that host', async () => {
    // WHY: the session's owner is the person the host's delegated token names (plans/010-standard-oauth.md).
    const operations = new sessionApi.SessionApiOperations(shares)
    const admitted = await operations.admit(delegatedContext(), { sessionId: 'solus-bob' })
    expect(admitted).toMatchObject({ sessionId: 'solus-bob', organizationId: 'A', ownerUserId: 'bob', hostId: 'VM' })
    expect(await operations.admit(delegatedContext(), { sessionId: 'solus-bob' })).toEqual(admitted)
    await expect(operations.admit(delegatedContext('mallory'), { sessionId: 'solus-bob' })).rejects.toMatchObject({ status: 409 })
    const { delegation: _delegation, ...withoutDelegation } = delegatedContext()
    await expect(operations.admit(withoutDelegation, { sessionId: 'solus-bob' })).rejects.toMatchObject({ status: 403 })
  })

  test('the first report takes the admission\'s owner, not the linker\'s or the report\'s; later reports and replays cannot change it', async () => {
    const report = (seq: number, sessionId: string, extra: Record<string, string> = {}) => ({ seq, record: { sessionId, provider: 'claude-code' as const, projectPath: '-repo', lastActivityAt: seq, ...extra } })
    await intake.applyRunnerSessionRecords(runner('alice'), { hostId: 'VM', reports: [report(1, 'thread-bob', { admissionId: 'solus-bob', ownerUserId: 'mallory' })] }, shares)
    expect(await records.getSessionRecord('A', 'thread-bob')).toMatchObject({ ownerUserId: 'bob', runnerHostId: 'VM' })
    expect(await shares.ownerOf({ kind: 'session', id: 'thread-bob' })).toBe('bob')
    // Existing organization access: the organization's members may open it (editor), as anything made in its space.
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, { kind: 'session', id: 'thread-bob' })).toBe('editor')
    await intake.applyRunnerSessionRecords(runner('alice'), { hostId: 'VM', reports: [report(2, 'thread-bob', { ownerUserId: 'mallory', title: 'Renamed' })] }, shares)
    expect(await records.getSessionRecord('A', 'thread-bob')).toMatchObject({ ownerUserId: 'bob', title: 'Renamed' })
    expect(await shares.ownerOf({ kind: 'session', id: 'thread-bob' })).toBe('bob')
    // A record with no admission — a published Local session — belongs to the account that linked the runner.
    await intake.applyRunnerSessionRecords(runner('alice'), { hostId: 'VM', reports: [report(3, 'thread-published', { ownerUserId: 'mallory' })] }, shares)
    expect(await records.getSessionRecord('A', 'thread-published')).toMatchObject({ ownerUserId: 'alice' })
  })

  test('a chat the runner reports is its owner\'s alone on the API until they share it (plan 004 D14)', async () => {
    const chat = { kind: 'session', id: 'thread-bob-chat' } as const
    await intake.applyRunnerSessionRecords(runner('alice'), { hostId: 'VM', reports: [{ seq: 10, record: { sessionId: chat.id, provider: 'claude-code', projectPath: '-chat', lastActivityAt: 10, privateToOwner: true } }] }, shares)
    expect(await shares.ownerOf(chat)).toBe('alice')
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, chat)).toBe('none')
    expect(await records.getSessionRecord('A', chat.id)).not.toHaveProperty('privateToOwner')
  })
})
