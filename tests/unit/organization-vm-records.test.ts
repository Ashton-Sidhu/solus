import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { HostOrganizationsResponse, HostRegistration } from '@solus/contracts/uplink'
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

const LINK: HostRegistration = { hostId: 'VM', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', generation: 1, apiUrl: 'https://api.invalid' }
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
    registration: () => LINK,
    credential: () => ({ hostAccessToken: async () => 'control-token' }),
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

const PAIRED: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: 'phone', deviceLabel: 'Phone' }
const ALICE: Principal = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'account-session', expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }
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
    // The record is keyed by the session id, so it is born in its API home whenever it is first written.
    expect(await localRecord('s-new')).toMatchObject({ organizationId: 'A', publication: 'published', ownerKey: 'alice' })
    expect(records.admissionIdFor('s-new')).toBe('s-new')
    turnOrganization.applyPendingAssignment('s-new')
    expect(turnOrganization.pendingOrganizationFor('s-new')).toBeNull()

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
    // `s-new` is a thread that is its own session, so the fork's source record is `s-new`.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-fork-org', 'B', { forked: true, agentSessionId: 's-new' }), actorFor(ALICE), deps)).toBe('A')
    expect(authorities.calls).toEqual([{ sessionId: 's-fork-org', userId: 'alice', organizationId: 'A', admit: true }])
  })

  test('each turn of an API session needs the person again: a removed membership stops new turns and new answers, and another organization is unaffected', async () => {
    const authorities = new FakeDelegations()
    const deps = { hostOrganizations, delegations: authorities }
    expect(await turnOrganization.admitTurnOrganization(ctx('s-new', 'A', { agentSessionId: 'thread-new' }), actorFor(ALICE), deps)).toBe('A')
    expect(authorities.calls).toEqual([{ sessionId: 's-new', userId: 'alice', organizationId: 'A', admit: false }])
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-new', deps)).toBe(true)
    authorities.refusal = { code: 'ORGANIZATION_ACCESS_REFUSED', message: 'You are no longer a member of this organization.' }
    await expect(turnOrganization.admitTurnOrganization(ctx('s-new', 'A', { agentSessionId: 'thread-new' }), actorFor(ALICE), deps)).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-new', deps)).toBe(false)
    // A Local session needs no organization authority to answer.
    expect(await turnOrganization.mayAnswerFor(ALICE, 's-before', deps)).toBe(true)
  })

  test('a member admitted for organization work records the attachment; a person\'s own computer is never attached', async () => {
    let marked = 0
    const authorities = new FakeDelegations()
    expect(await turnOrganization.admitTurnOrganization(ctx('s-bob', 'A'), actorFor(BOB_IN_A), { hostOrganizations, delegations: authorities, markAttached: () => { marked++ } })).toBe('A')
    expect(marked).toBe(1)
    expect(authorities.calls.at(-1)).toEqual({ sessionId: 's-bob', userId: 'bob', organizationId: 'A', admit: true })

    // The desktop's own host, shared with an organization: its owner's scratch
    // names their organization, and stays their own work on this machine.
    hostCategory.applyHostCategory('personal')
    expect(attachment.isOrganizationAttached()).toBe(false)
    await localRecord('s-laptop')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-laptop', 'B'), actorFor(PAIRED), { hostOrganizations, delegations: authorities })).toBe('B')
    expect(records.isOrganizationWork(await recordOf('s-laptop'))).toBe(false)
    // WHY: a host restart continues this machine's own work and leaves the
    // organization's to its Solus API, before and after the record is written.
    expect(await records.sessionIsOrganizationWork('s-laptop')).toBe(false)
    expect(await records.sessionIsOrganizationWork('s-bob')).toBe(true)
  })
})

describe('every new session passes the turn admission', () => {
  // N1 (verify-multiplayer TRIAGE): `createHeadlessSession` — a cross-host child, a
  // client's background start — is a new root like a first prompt. A local child
  // (`start_session` on this machine) is new work too. Both are admitted inside
  // `PromptDispatch.createSession`, so an attached machine never starts a Local root,
  // and a person whose authority was removed starts no new child run (organization-vms §4).
  type Handler = (args: unknown[], handlerCtx: { principal: Principal; clientId?: string }) => Promise<unknown>
  async function harness() {
    const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
    const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
    const { withActor } = await import('./helpers/actors')
    const authorities = new FakeDelegations()
    /** The runs that reached the provider: nothing before admission accepts them. */
    const runs: Array<{ sessionId: string; actor?: { principal: Principal } }> = []
    const prompted: string[] = []
    const actors = new Map<string, ReturnType<typeof actorFor>>()
    const activeSessions = new Map<string, { runInput?: { workingDirectory: string } }>()
    const rt = {
      activeSessions,
      sessionPermissionModes: new Map([['parent-a', 'full-access'], ['parent-local', 'full-access']]),
      actorOfSession: (sessionId: string) => actors.get(sessionId),
      seatForTurn: async () => null,
      turnOrganization: async (sessionId: string) => {
        const organizationId = (await recordOf(sessionId))?.organizationId
        return organizationId && organizationId !== 'local' ? organizationId : undefined
      },
      runTurn: async (request: { sessionId: string; actor?: { principal: Principal } }) => {
        runs.push(request)
        return { disposition: 'started', agentSessionId: Promise.resolve({ agentSessionId: `thread-${request.sessionId}` }) }
      },
      emit: () => {},
    }
    const dispatch = new PromptDispatch(rt as never)
    dispatch.admission = {
      hostOrganizations, delegations: authorities,
      adoptSession: (sessionId, organizationId, ownerKey, options) => shares.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
    }
    dispatch.promptSession = (async (sessionId: string) => { prompted.push(sessionId); return { disposition: 'started' } }) as never
    const handlers = new Map<string, Handler>()
    registerSessionHandlers(
      { register: (name: string, handler: Handler) => handlers.set(name, (args, handlerCtx) => handler(args, withActor(handlerCtx))) } as never,
      { sessionRuntime: { activeSessions, dispatch } as never, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code', shares },
    )
    const start = (principal: Principal, organizationId?: string) => handlers.get('createHeadlessSession')!([{ prompt: 'Go.', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: dataDir, organizationId }], { principal })
    const promptFromHost = (principal: Principal, sessionId: string) => handlers.get('promptHeadlessSession')!([{ sessionId, prompt: 'More.', delivery: 'queue', promptId: `p-${sessionId}` }], { principal })
    /** `start_session` from a running parent on this machine, as the orchestrator calls it: no actor of its own. */
    const startChild = (parentSessionId = 'parent-a') => dispatch.createSession({ prompt: 'Help.', provider: 'claude-code', modelId: 'opus', reasoningEffort: 'medium', contextWindow: null, cwd: dataDir, delegation: { parentSessionId, messageId: 'exchange-1', intent: 'delegate', createdAt: 1 } })
    return { start, promptFromHost, startChild, runs, prompted, authorities, actors, activeSessions }
  }

  /** An organization session on the Solus API, run for Bob: its record is published in A. */
  async function bobsParent(actors: Map<string, ReturnType<typeof actorFor>>) {
    records.rememberSessionBirth('parent-a', { organizationId: 'A', published: true, ownerKey: 'bob' })
    await records.upsertOwnSessionRecord({ sessionId: 'parent-a', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
    actors.set('parent-a', actorFor(BOB_IN_A))
  }

  test('a headless start with no organization is refused before anything starts, as a prompt would be', async () => {
    const { start, runs, authorities } = await harness()
    await expect(start(PAIRED)).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED' })
    await expect(start(ALICE)).rejects.toMatchObject({ code: 'ORGANIZATION_REQUIRED' })
    expect(runs).toEqual([])
    expect(authorities.calls).toEqual([])
  })

  test('a headless start with the requester\'s organization is admitted on the Solus API before its provider runs', async () => {
    const { start, runs, authorities } = await harness()
    const started = await start(ALICE, 'A') as { sessionId: string }
    // The API writes the session's record from the facts the admission carries.
    expect(authorities.calls).toEqual([{ sessionId: started.sessionId, userId: 'alice', organizationId: 'A', admit: true, record: expect.objectContaining({ provider: 'claude-code', privateToOwner: false }) }])
    expect(runs.map((run) => run.sessionId)).toEqual([started.sessionId])
    expect(turnOrganization.pendingOrganizationFor(started.sessionId)).toBe('A')
    expect((await shares.homeOf({ kind: 'session', id: started.sessionId }))?.ownerKey).toBe('alice')
  })

  test('a local child is admitted on the Solus API in its parent\'s organization, for its parent\'s person', async () => {
    const { startChild, runs, authorities, actors } = await harness()
    await bobsParent(actors)
    const child = await startChild()
    expect(authorities.calls).toEqual([{ sessionId: child.sessionId, userId: 'bob', organizationId: 'A', admit: true, record: expect.objectContaining({ privateToOwner: false }) }])
    expect(runs.map((run) => run.sessionId)).toEqual([child.sessionId])
    expect(turnOrganization.pendingOrganizationFor(child.sessionId)).toBe('A')
    expect((await shares.homeOf({ kind: 'session', id: child.sessionId }))?.ownerKey).toBe('bob')
  })

  test('a local child of a person whose authority was removed is refused before its provider starts', async () => {
    const { startChild, runs, authorities, actors } = await harness()
    await bobsParent(actors)
    authorities.refusal = { code: 'ORGANIZATION_AUTHORITY_MISSING', message: 'Bob no longer holds authority in Acme.' }
    await expect(startChild()).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(runs).toEqual([])
  })

  test('a local child of a Local session stays Local, as a personal fork does (organization-vms §1: children inherit)', async () => {
    const { startChild, runs, authorities, actors } = await harness()
    await localRecord('parent-local')
    actors.set('parent-local', actorFor(ALICE))
    const child = await startChild('parent-local')
    expect(authorities.calls).toEqual([])
    expect(runs.map((run) => run.sessionId)).toEqual([child.sessionId])
    expect(turnOrganization.pendingOrganizationFor(child.sessionId)).toBeNull()
  })

  test('a prompt from another host on an organization session checks the person\'s authority, as a prompt does', async () => {
    const { promptFromHost, prompted, authorities, actors, activeSessions } = await harness()
    await bobsParent(actors)
    activeSessions.set('parent-a', { runInput: { workingDirectory: dataDir } })
    await promptFromHost(BOB_IN_A, 'parent-a')
    expect(authorities.calls).toEqual([{ sessionId: 'parent-a', userId: 'bob', organizationId: 'A', admit: false }])
    authorities.refusal = { code: 'ORGANIZATION_AUTHORITY_MISSING', message: 'Bob no longer holds authority in Acme.' }
    await expect(promptFromHost(BOB_IN_A, 'parent-a')).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(prompted).toEqual(['parent-a'])
  })

  test('a link guest\'s prompt on an organization session runs for the person who shared it, while they hold authority (host-sharing.md §4.2 step 5)', async () => {
    const { promptFromHost, prompted, authorities, actors, activeSessions } = await harness()
    await bobsParent(actors)
    activeSessions.set('parent-a', { runInput: { workingDirectory: dataDir } })
    const maya: Principal = { kind: 'guest', guestId: 'maya', displayName: 'Maya', deviceId: 'maya', share: { resource: { kind: 'session', id: 'parent-a' }, role: 'editor', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: Date.now() + 600_000, deviceLabel: 'Guest link' }
    await promptFromHost(maya, 'parent-a')
    expect(authorities.calls).toEqual([{ sessionId: 'parent-a', userId: 'bob', organizationId: 'A', admit: false }])
    authorities.refusal = { code: 'ORGANIZATION_AUTHORITY_MISSING', message: 'Bob no longer holds authority in Acme.' }
    await expect(promptFromHost(maya, 'parent-a')).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(prompted).toEqual(['parent-a'])
  })
})

describe('shared compute, access on the record', () => {
  test('the organization\'s other members may open and watch an organization session on the VM, as on its API; the machine stays its owner\'s to administer', async () => {
    const scoped = new shareManager.ShareManager({ db: database.getDatabase() })
    // A watch claimed the not-yet-admitted session first, for the machine's owner, as Local.
    await scoped.claimSession('s-live', ALICE)
    const authorities = new FakeDelegations()
    const admitted = await turnOrganization.admitTurnOrganization(ctx('s-live', 'A'), actorFor(ALICE), {
      hostOrganizations, delegations: authorities,
      adoptSession: (sessionId, organizationId, ownerKey, options) => scoped.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
    })
    expect(admitted).toBe('A')
    // The verified person owns it, in the organization; a colleague in A may edit it; B's members see nothing.
    expect((await scoped.homeOf({ kind: 'session', id: 's-live' }))?.ownerKey).toBe('alice')
    const carolInA: Principal = { ...BOB_IN_A, userId: 'carol', organizationRole: 'owner' }
    expect(await scoped.roleFor(carolInA, { kind: 'session', id: 's-live' })).toBe('editor')
    const danInB: Principal = { ...BOB_IN_A, userId: 'dan', organizationId: 'B' }
    expect(await scoped.roleFor(danInB, { kind: 'session', id: 's-live' })).toBe('none')
    // Owning an organization is not administering a customer's machine.
    expect(principalModule.isHostAdmin(carolInA)).toBe(false)
    // A resource of another organization is never taken over by a later admission.
    await scoped.adoptForOrganization({ kind: 'session', id: 's-live' }, 'B', 'mallory', { shareWithOrganization: true })
    expect((await scoped.homeOf({ kind: 'session', id: 's-live' }))?.ownerKey).toBe('alice')
    expect(await scoped.roleFor({ ...danInB, organizationRole: 'owner' }, { kind: 'session', id: 's-live' })).toBe('none')
  })

  // plans/004-shared-host-collaboration.md D14: a project session starts shared with
  // the organization; a chat is organization work too, but private until shared.
  test('a member\'s new chat is theirs alone until they share it; their new project session is the organization\'s', async () => {
    const scoped = new shareManager.ShareManager({ db: database.getDatabase() })
    const deps = {
      hostOrganizations, delegations: new FakeDelegations(),
      adoptSession: (sessionId: string, organizationId: string, ownerKey: string, options: { shareWithOrganization: boolean }) =>
        scoped.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
    }
    const carolInA: Principal = { ...BOB_IN_A, userId: 'carol' }
    const chat = { kind: 'session', id: 's-bob-chat' } as const
    const project = { kind: 'session', id: 's-bob-project' } as const

    expect(await turnOrganization.admitTurnOrganization(ctx(chat.id, 'A', { workingDirectory: '/data/projects/bob/solus-chats/s-bob-chat' }), actorFor(BOB_IN_A), deps)).toBe('A')
    expect(await turnOrganization.admitTurnOrganization(ctx(project.id, 'A', { workingDirectory: '/srv/repo' }), actorFor(BOB_IN_A), deps)).toBe('A')

    expect((await scoped.homeOf(chat))?.ownerKey).toBe('bob')
    expect(await scoped.roleFor(carolInA, chat)).toBe('none')
    expect(await scoped.roleFor(carolInA, project)).toBe('editor')

    await scoped.setEntries({ resource: chat, entries: [{ subject: { kind: 'organization', id: 'A' }, role: 'editor' }] }, BOB_IN_A)
    expect(await scoped.roleFor(carolInA, chat)).toBe('editor')
  })
})

describe('record scope on an attached machine', () => {
  test('a pairing connection keeps only its Local records; the owner\'s account and the host itself read the whole disk', async () => {
    expect(principalModule.recordScopeOf(PAIRED)).toBe('local')
    expect(principalModule.recordScopeOf(ALICE)).toBe(principalModule.ANY_ORGANIZATION)
    expect(principalModule.recordScopeOf(principalModule.INTERNAL_PRINCIPAL)).toBe(principalModule.ANY_ORGANIZATION)
    const scoped = new shareManager.ShareManager({ db: database.getDatabase() })
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 's-before' })).toBe('owner')
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 's-new' })).toBe('none')
    expect(await scoped.roleFor(ALICE, { kind: 'session', id: 's-new' })).toBe('owner')
    // On an unattached machine a pairing connection reads every organization again. It is the
    // host's administrator there, so it edits Alice's session; she alone owns it (access-model.md §2.5).
    attachment.useOrganizationAttachment(() => null)
    expect(principalModule.recordScopeOf(PAIRED)).toBe(principalModule.ANY_ORGANIZATION)
    expect(await scoped.roleFor(PAIRED, { kind: 'session', id: 's-new' })).toBe('editor')
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
      const task: WorkspaceTask = { id: `task-${tasks.size + 1}`, home, organizationId, ownerKey: 'alice', role: 'owner', version: '1', createdAt: now, updatedAt: now, title: input.title, body: input.body ?? '', projectKey: input.projectKey ?? null, projectId: null, status: input.status ?? 'todo', assignee: null, priority: input.priority ?? null, labels: input.labels ?? [], dueDate: null, originSessionId: input.originSessionId ?? null, shortId: tasks.size + 1 }
      tasks.set(task.id, task)
      return task
    },
    getTask: async (_context, taskId) => { calls.push(`getTask:${taskId}`); const task = tasks.get(taskId); if (!task) throw notFound(); return task },
    updateTask: async (_context, taskId, input) => { calls.push(`updateTask:${taskId}`); const task = { ...tasks.get(taskId)!, ...input, version: '2' } as WorkspaceTask; tasks.set(taskId, task); return task },
    listTasks: async () => { calls.push('listTasks'); return { items: [...tasks.values()].map(({ body: _body, ...summary }) => summary), nextCursor: null } },
    createWork: async (_context, input: WorkspaceCreateWork) => {
      calls.push(`createWork:${input.originSessionId}`)
      const work: WorkspaceWork = { id: `work-${createdWorks.size + 1}`, home, organizationId, ownerKey: 'alice', role: 'owner', version: '1', createdAt: now, updatedAt: now, title: input.title, type: input.type, preview: '', sessionIds: input.originSessionId ? [input.originSessionId] : [], projectId: null, pinned: false, editable: true, cwd: '~', agentProvider: 'claude-code', content: input.content }
      createdWorks.set(work.id, work)
      return work
    },
    getWork: async (_context, workId) => { calls.push(`getWork:${workId}`); const work = createdWorks.get(workId); if (!work) throw notFound(); return work },
  }
  return { operations: operations as WorkspaceOperations, calls, tasks, works: createdWorks }
}

describe('an agent\'s record tools follow its session\'s home', () => {
  const agentIn = (sessionId: string): AgentToolContext => ({
    provider: 'claude-code', cwd: dataDir, sessionId: () => sessionId,
    abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
  })

  test('an organization session reads and writes its Solus API, and the reads agree with the writes; nothing lands on this machine', async () => {
    const api = fakeOrganizationApi('A')
    const runs: string[] = []
    const uninstall = toolContext.installWorkspaceToolOperations(service.createWorkspaceOperations(shares), 'vm', (sessionId) => { runs.push(sessionId); return api.operations })
    try {
      const created = await taskTools.createTaskAgentTool.execute({ title: 'Ship the VM plan' }, agentIn('s-new'))
      expect(created.ok).toBe(true)
      const taskId = /Task (\S+) —/.exec(created.text)?.[1]
      expect(taskId).toBe('task-1')
      const read = await taskTools.readTaskAgentTool.execute({ task_id: taskId! }, agentIn('s-new'))
      expect(read.text).toContain('Ship the VM plan')
      expect((await taskTools.updateTaskStatusAgentTool.execute({ task_id: taskId!, status: 'in_review' }, agentIn('s-new'))).text).toContain('in_review')
      const work = await workTools.createWorkAgentTool.execute({ title: 'VM notes', doc_type: 'doc', content: '# Notes' }, agentIn('s-new'))
      expect(work.text).toContain("saved in the organization's Solus API")
      const workId = /id: ([^)]+)\)/.exec(work.text)?.[1]
      expect((await workTools.readWorkAgentTool.execute({ work_id: workId! }, agentIn('s-new'))).text).toContain('# Notes')
      // Every record the agent writes names its session id, not its provider thread.
      expect(api.calls).toEqual([`createTask:s-new:${dataDir}`, `getTask:${taskId}`, `getTask:${taskId}`, `updateTask:${taskId}`, 'createWork:s-new', `getWork:${workId}`])
      expect(runs.every((sessionId) => sessionId === 's-new')).toBe(true)
      // Not one of them is in this machine's own store.
      expect((await taskStore.listTasks(principalModule.ANY_ORGANIZATION)).tasks).toEqual([])
      expect(await works.listWorks(principalModule.ANY_ORGANIZATION)).toEqual([])

      // A personal session on the same machine keeps writing here.
      const personal = await taskTools.createTaskAgentTool.execute({ title: 'Personal note' }, agentIn('s-before'))
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
      const refused = await taskTools.createTaskAgentTool.execute({ title: 'Lost?' }, agentIn('s-new'))
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain('holds no authority')
      expect((await taskStore.listTasks(principalModule.ANY_ORGANIZATION)).tasks.map((task) => task.title)).toEqual(['Personal note'])
    } finally {
      uninstall()
    }
  })

  test('a session the API admitted writes there from its first tool call, before its record is written on this machine', async () => {
    // WHY: a fast agent calls a tool before the indexer writes the new session's record
    // (the Lab's organization-work run). That write must still go to the Solus API, never
    // into this machine's store.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-first', 'A'), actorFor(ALICE), { hostOrganizations, delegations: new FakeDelegations() })).toBe('A')
    expect(await recordOf('s-first')).toBeNull()
    const api = fakeOrganizationApi('A')
    const uninstall = toolContext.installWorkspaceToolOperations(service.createWorkspaceOperations(shares), 'vm', () => api.operations)
    try {
      const created = await taskTools.createTaskAgentTool.execute({ title: 'First write' }, agentIn('s-first'))
      expect(created.ok).toBe(true)
      expect(api.calls).toEqual([`createTask:s-first:${dataDir}`])
      expect((await taskStore.listTasks(principalModule.ANY_ORGANIZATION)).tasks.map((task) => task.title)).not.toContain('First write')
    } finally {
      uninstall()
      turnOrganization.applyPendingAssignment('s-first')
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
    expect(admitted).toMatchObject({ sessionId: 'solus-bob', organizationId: 'A', ownerKey: 'bob', hostId: 'VM' })
    expect(await operations.admit(delegatedContext(), { sessionId: 'solus-bob' })).toEqual(admitted)
    await expect(operations.admit(delegatedContext('mallory'), { sessionId: 'solus-bob' })).rejects.toMatchObject({ status: 409 })
    const { delegation: _delegation, ...withoutDelegation } = delegatedContext()
    await expect(operations.admit(withoutDelegation, { sessionId: 'solus-bob' })).rejects.toMatchObject({ status: 403 })
  })

  test('the admission writes the session record, so an agent\'s first write that names the session finds it; asking again changes nothing', async () => {
    // WHY: the host waited up to ten seconds for its first report to arrive before an
    // agent's first write (simplify-auth-and-sync §4.5). The record is written where the session is admitted.
    const operations = new sessionApi.SessionApiOperations(shares)
    const record = { provider: 'codex' as const, projectPath: '-repo', cwd: '/repo', privateToOwner: false }
    await operations.admit(delegatedContext(), { sessionId: 'solus-admitted', record })
    expect(await records.getSessionRecord('A', 'solus-admitted')).toMatchObject({ ownerKey: 'bob', runnerHostId: 'VM', publication: 'published', provider: 'codex', status: 'running' })
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, { kind: 'session', id: 'solus-admitted' })).toBe('editor')
    await records.setSessionRecordStatus('A', 'solus-admitted', 'idle')
    await operations.admit(delegatedContext(), { sessionId: 'solus-admitted', record })
    expect((await records.getSessionRecord('A', 'solus-admitted'))?.status).toBe('idle')
    // A chat stays its owner's alone.
    await operations.admit(delegatedContext(), { sessionId: 'solus-admitted-chat', record: { ...record, privateToOwner: true } })
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, { kind: 'session', id: 'solus-admitted-chat' })).toBe('none')
  })

  test('the first report takes the admission\'s owner, not the linker\'s or the report\'s; later reports and replays cannot change it', async () => {
    const report = (seq: number, sessionId: string, extra: { admissionId?: string; ownerKey?: string; title?: string } = {}) => ({ seq, kind: 'session' as const, payload: { sessionId, provider: 'claude-code' as const, projectPath: '-repo', lastActivityAt: seq, ...extra } })
    await intake.applyRunnerDelivery(runner('alice'), { hostId: 'VM', items: [report(1, 'thread-bob', { admissionId: 'solus-bob', ownerKey: 'mallory' })] }, { shares })
    expect(await records.getSessionRecord('A', 'thread-bob')).toMatchObject({ ownerKey: 'bob', runnerHostId: 'VM' })
    expect((await shares.homeOf({ kind: 'session', id: 'thread-bob' }))?.ownerKey).toBe('bob')
    // Existing organization access: the organization's members may open it (editor), as anything made in its space.
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, { kind: 'session', id: 'thread-bob' })).toBe('editor')
    await intake.applyRunnerDelivery(runner('alice'), { hostId: 'VM', items: [report(2, 'thread-bob', { ownerKey: 'mallory', title: 'Renamed' })] }, { shares })
    expect(await records.getSessionRecord('A', 'thread-bob')).toMatchObject({ ownerKey: 'bob', title: 'Renamed' })
    expect((await shares.homeOf({ kind: 'session', id: 'thread-bob' }))?.ownerKey).toBe('bob')
    // A record with no admission — a published Local session — belongs to the account that linked the runner.
    await intake.applyRunnerDelivery(runner('alice'), { hostId: 'VM', items: [report(3, 'thread-published', { ownerKey: 'mallory' })] }, { shares })
    expect(await records.getSessionRecord('A', 'thread-published')).toMatchObject({ ownerKey: 'alice' })
  })

  test('a chat the runner reports is its owner\'s alone on the API until they share it (plan 004 D14)', async () => {
    const chat = { kind: 'session', id: 'thread-bob-chat' } as const
    await intake.applyRunnerDelivery(runner('alice'), { hostId: 'VM', items: [{ seq: 10, kind: 'session', payload: { sessionId: chat.id, provider: 'claude-code', projectPath: '-chat', lastActivityAt: 10, privateToOwner: true } }] }, { shares })
    expect((await shares.homeOf(chat))?.ownerKey).toBe('alice')
    expect(await shares.roleFor({ ...BOB_IN_A, userId: 'carol' } as Principal, chat)).toBe('none')
    expect(await records.getSessionRecord('A', chat.id)).not.toHaveProperty('privateToOwner')
  })

  test('a record a runner report creates reads published to the organization\'s clients', async () => {
    // WHY: a runner reports only published sessions; a client that reads `local` treats the session as not on the API.
    await intake.applyRunnerDelivery(runner('alice'), { hostId: 'VM', items: [{ seq: 20, kind: 'session', payload: { sessionId: 'thread-reported', provider: 'codex', projectPath: '-repo', lastActivityAt: 20 } }] }, { shares })
    const reader = { principal: { ...BOB_IN_A, userId: 'carol' } as Principal, home: { kind: 'organization' as const, serviceId: 'api', organizationId: 'A' }, scopes: ['sessions:read' as const] }
    expect(await new sessionApi.SessionApiOperations(shares).get(reader, 'thread-reported')).toMatchObject({ id: 'thread-reported', organizationId: 'A', publication: 'published' })
  })
})
