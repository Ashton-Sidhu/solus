import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudMachineAnswers } from '@solus/contracts/cloud-machine-card'
import type { AgentId, NormalizedEvent } from '@solus/contracts/types'
import type { DelegationScope, DirectoryHost, DirectoryResponse } from '@solus/contracts/uplink'
import type { OrganizationSettingsResponse } from '@solus/contracts/policy-api'
import type { Actor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { AgentTool, AgentToolContext, AgentToolResult } from '@solus/server/execution/agents/tools/agent-tool'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: plans/035-cloud-machine-tools.md. An agent manages the cloud machines and the
// organization of the person of its turn, with the token this host holds for them. The
// tools are only for a person this host holds a delegation for (§7). A host never
// changes, stops, restarts, or deletes itself, and refuses before it asks Solus Cloud
// (decisions 2 and 6). The machine card shows only when a choice is missing, and its
// answer comes from a client, so the tool checks it against the ask (§6). A policy
// write names the revision it read, so it never writes over another owner's save (§10).

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
type Question = Extract<NormalizedEvent, { type: 'question_request' }>

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let cloud: typeof import('@solus/server/execution/agents/tools/cloud-machine-tools')
let organizationTools: typeof import('@solus/server/execution/agents/tools/organization-tools')
let agentTool: typeof import('@solus/server/execution/agents/tools/agent-tool')
let solusToolbox: typeof import('@solus/server/execution/agents/tools/solus-toolbox')['solusToolbox']
let credentialScopedAgentTools: typeof import('@solus/server/execution/sessions/run-lifecycle')['credentialScopedAgentTools']
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let closeDb: typeof import('@solus/server/db')['closeDb']
let HOST_ACTOR: Actor
const previousDataDir = process.env.SOLUS_DATA_DIR

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const MEMBER: Principal = {
  kind: 'org-member', userId: 'user_bea', organizationId: 'org_acme', organizationRole: 'member', teamIds: [], hostKind: 'personal',
  displayName: 'Bea', deviceId: 'device_bea', expiresAt: Date.now() + 3_600_000, deviceLabel: 'Laptop',
}
const SELF = { hostId: 'host_self', installationId: 'inst_self' }
const ACCOUNT_ORIGIN = 'https://account.solus.example'
const TICKET = 'tkt_9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const CODE = `${TICKET}@account.solus.example`

/** One process the SSH runner started: what `ps` on this machine shows, and what it got on stdin. */
interface Spawned { command: string; args: string[]; stdin: string | undefined }
let spawned: Spawned[] = []
/** What `ssh -G` resolves the target to; null for a machine that is not this one. */
let runProcessHostname: string | null = null
/** Answers the `ssh` that runs the join; `ssh -G` answers a machine that is not this one. */
let joinAnswer: () => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: '', stderr: '' })
async function runProcess(command: string, args: readonly string[], options: { stdin?: string }) {
  spawned.push({ command, args: [...args], stdin: options.stdin })
  if (args[0] === '-G') return { code: 0, stdout: `hostname ${runProcessHostname ?? '10.20.30.40'}\n`, stderr: '' }
  return joinAnswer()
}

const machine = (hostId: string, label: string, extra: Partial<DirectoryHost> = {}): DirectoryHost => ({
  hostId, installationId: `inst_${hostId}`, label, routes: [], kind: 'cloud', organizationIds: ['org_acme'],
  hasManagedCompute: true, managedState: 'ready', ...extra,
})
const CATALOG = { sizes: [{ id: 'small', label: 'Small', detail: '2 CPU' }, { id: 'large', label: 'Large', detail: '8 CPU' }], defaultSize: 'small', supportsPackages: true, supportsSetupScript: true }

/** One request the tools sent to the fake account plane. */
interface Sent { userId: string; scope: DelegationScope | null; method: string; path: string; body: unknown }

let sent: Sent[] = []
let holders: Array<{ userId: string; scope: DelegationScope }> = []
let directory: DirectoryResponse
/** What the directory read answers; a test can change it from read to read. */
let directoryRead: () => DirectoryResponse = () => directory
/** Answers a request that is not the directory read; a test sets it. */
let answer: (request: Sent) => Response = () => new Response(null, { status: 404 })

const orgs = (...names: string[]) => names.map((name) => ({ organizationId: `org_${name}`, label: name[0]!.toUpperCase() + name.slice(1), routes: [], isActive: true, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true } }))

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-cloud-tools-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  runtimeModule = await import('@solus/server/execution/session-runtime')
  cloud = await import('@solus/server/execution/agents/tools/cloud-machine-tools')
  organizationTools = await import('@solus/server/execution/agents/tools/organization-tools')
  agentTool = await import('@solus/server/execution/agents/tools/agent-tool')
  ;({ solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox'))
  ;({ credentialScopedAgentTools } = await import('@solus/server/execution/sessions/run-lifecycle'))
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  cloud.setCloudMachineTools({
    reads: {
      fetch: async (userId, scope, path, init = {}) => {
        const request: Sent = { userId, scope, method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined }
        sent.push(request)
        if (request.method === 'GET' && path === '/v1/hosts') return Response.json(directoryRead())
        return answer(request)
      },
    },
    holders: () => holders,
    thisHost: () => SELF,
    listing: { timeoutMs: 1_000, pollMs: 1 },
    // The SSH runner of add_host, with a fake process runner: the test sees each argv and stdin.
    ssh: new (await import('@solus/server/platform/ssh')).SshClient({ run: (command, args, options = {}) => runProcess(command, args, options), spawn: () => { throw new Error('no forward in these tests') } }),
    accountOrigin: () => ACCOUNT_ORIGIN,
  })
})

afterAll(() => {
  cloud.setCloudMachineTools(null)
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  sent = []
  holders = [{ userId: 'user_ann', scope: 'personal' }]
  directory = { hosts: [machine('host_self', 'Self'), machine('host_build', 'Build box'), machine('host_own', 'Own VM', { hasManagedCompute: undefined, managedState: undefined })], workspaces: orgs('acme'), managedHostCatalog: CATALOG }
  directoryRead = () => directory
  answer = () => new Response(null, { status: 404 })
  spawned = []
  joinAnswer = () => ({ code: 0, stdout: '', stderr: '' })
})

/** A provider that answers no question itself: only the tool takes the answer of its card. */
class QuietBackend extends EventEmitter {
  readonly id: AgentId = 'codex'
  readonly permissions = {
    getPendingInfo: () => undefined,
    respondToPermission: () => false,
    respondToQuestion: () => false,
    clearPendingForSession: () => {},
    setCurrentSessionId: () => {},
  }
  getSessionHandle(): undefined { return undefined }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  getPendingHandles(): never[] { return [] }
}

interface Live {
  runtime: Runtime
  events: NormalizedEvent[]
  shown(count?: number): Promise<Question>
  context: AgentToolContext
  answer(card: Question, answers: Record<string, string>): Promise<boolean>
}

/** A session with a running turn; the tool's events go through the provider event path, as a real turn's do. */
function liveSession(sessionId: string): Live {
  const backend = new QuietBackend()
  // SAFETY: the test backend has each member that the event path of a question reads.
  const runtime = new runtimeModule.SessionRuntime(new Map([['codex', backend as unknown as AgentBackend]]))
  const thread = `thread-${sessionId}`
  runtime.agentSessionToSession.set(thread, sessionId)
  runtime.activeSessions.set(sessionId, {
    sessionId, agentSessionId: thread, backendId: 'codex', status: 'running', pendingInputEvents: [],
    lastActivityAt: Date.now(), promptCount: 1, activeTurnId: 'turn-1',
  })
  const events: NormalizedEvent[] = []
  const waiting: (() => void)[] = []
  runtime.on('event', (id: string, event: NormalizedEvent) => {
    if (id !== sessionId) return
    events.push(event)
    for (const wake of waiting.splice(0)) wake()
  })
  const cards = () => events.filter((event): event is Question => event.type === 'question_request')
  const shown = async (count = 1): Promise<Question> => {
    while (cards().length < count) await new Promise<void>((wake) => { waiting.push(wake) })
    return cards()[count - 1]!
  }
  const context: AgentToolContext = {
    provider: 'codex', cwd: root, sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined,
    emit: (event) => { backend.emit('normalized', thread, event) },
  }
  return { runtime, events, shown, context, answer: (card, answers) => runtime.inputRequests.respondToQuestion(sessionId, card.questionId, answers, HOST_ACTOR) }
}

/** A context with no session that can show a card: a test that expects no card. */
const quiet: AgentToolContext = {
  provider: 'codex', cwd: '/', sessionId: () => undefined, abortSignal: new AbortController().signal, parentToolUseId: () => undefined,
  emit: (event) => { throw new Error(`no event expected, got ${event.type}`) },
}

function run<T extends AgentTool>(tool: T, input: Parameters<T['execute']>[0], context: AgentToolContext = quiet, principal: Principal = OWNER): Promise<AgentToolResult> {
  return withWorkspaceToolAuthority(principal, () => tool.execute(input, context))
}
const json = (result: AgentToolResult) => JSON.parse(result.text)
const writes = () => sent.filter((request) => request.method !== 'GET')

const CLOUD_TOOL_NAMES = [
  'list_cloud_machines', 'create_cloud_machine', 'update_cloud_machine', 'start_cloud_machine', 'stop_cloud_machine', 'restart_cloud_machine',
  'delete_cloud_machine', 'join_cloud_machine', 'list_organization_members', 'read_organization_policy', 'update_organization_policy',
]

describe('the cloud tools are only for a signed-in person', () => {
  const catalogFor = (principal: Principal) => agentTool.enabledAgentTools(credentialScopedAgentTools(Object.values(solusToolbox.cloud), { principal, user: null })).map((tool) => tool.name)

  test('the catalog has them only when this host holds a delegation for the person of the turn', () => {
    holders = []
    expect(catalogFor(OWNER)).toEqual([])
    holders = [{ userId: 'user_ann', scope: 'personal' }]
    expect(catalogFor(OWNER).sort()).toEqual([...CLOUD_TOOL_NAMES].sort())
    // A member gets them only with a delegation in their own organization.
    expect(catalogFor(MEMBER)).toEqual([])
    holders = [{ userId: 'user_bea', scope: { organizationId: 'org_other' } }]
    expect(catalogFor(MEMBER)).toEqual([])
    holders = [{ userId: 'user_bea', scope: { organizationId: 'org_acme' } }]
    expect(catalogFor(MEMBER).sort()).toEqual([...CLOUD_TOOL_NAMES].sort())
    // A guest, and a tool list with no person, never get them.
    expect(agentTool.enabledAgentTools(Object.values(solusToolbox.cloud))).toEqual([])
  })

  // WHY: the maintainer wants the owner's automations to manage cloud machines (for
  // example, stop them at night) while the owner is signed in (plans/035 §7). An
  // automation runs as the person who made it; work that names no person is the
  // host's own and never acts for anyone in Solus Cloud.
  test("the owner's automation gets them while the owner is signed in; the host's own work does not", async () => {
    const { unattendedActorFor } = await import('@solus/server/admission/actor')
    const { hostUserKey } = await import('@solus/server/host/host-user')
    const { parseUserKey } = await import('@solus/contracts/user')
    const automation = unattendedActorFor({ id: parseUserKey(hostUserKey()), displayName: 'Ann' }, 'local', 'Automation')
    if (!automation) throw new Error("the host user's automation must run unattended")
    const automationCatalog = () => agentTool.enabledAgentTools(credentialScopedAgentTools(Object.values(solusToolbox.cloud), automation)).map((tool) => tool.name)
    holders = [{ userId: 'user_ann', scope: 'personal' }]
    expect(automationCatalog().sort()).toEqual([...CLOUD_TOOL_NAMES].sort())
    holders = []
    expect(automationCatalog()).toEqual([])
    holders = [{ userId: 'user_ann', scope: 'personal' }]
    expect(agentTool.enabledAgentTools(credentialScopedAgentTools(Object.values(solusToolbox.cloud), HOST_ACTOR))).toEqual([])
  })

  test('a call after a sign-out is refused before any request', async () => {
    const [list] = credentialScopedAgentTools([solusToolbox.cloud.listMachines], { principal: OWNER, user: null })
    expect((await agentTool.executeAgentTool(list!, {}, quiet)).ok).toBe(true)
    sent = []
    holders = []
    const refused = await agentTool.executeAgentTool(list!, {}, quiet)
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('Sign in to Solus')
    expect(sent).toEqual([])
  })

  test('delete and a policy update ask for approval; the others do not', () => {
    const asking = Object.values(solusToolbox.cloud).filter((tool) => tool.requiresApproval).map((tool) => tool.name)
    expect(asking.sort()).toEqual(['delete_cloud_machine', 'update_organization_policy'])
  })
})

describe('machine tools', () => {
  test('list sends the directory read as the person and marks this host', async () => {
    const result = await run(cloud.listCloudMachinesAgentTool, {})
    expect(sent).toEqual([{ userId: 'user_ann', scope: 'personal', method: 'GET', path: '/v1/hosts', body: undefined }])
    const listed = json(result)
    expect(listed.machines.map((each: { id: string }) => each.id)).toEqual(['host_self', 'host_build', 'host_own'])
    expect(listed.machines.find((each: { id: string }) => each.id === 'host_self').isThisHost).toBe(true)
    expect(listed.organizations).toEqual([{ id: 'org_acme', name: 'Acme' }])
    expect(listed.sizes[0]).toMatchObject({ id: 'small', isDefault: true })
  })

  test('a member acts with the delegation of their organization', async () => {
    holders = [{ userId: 'user_bea', scope: { organizationId: 'org_acme' } }]
    await run(cloud.listCloudMachinesAgentTool, {}, quiet, MEMBER)
    expect(sent[0]).toMatchObject({ userId: 'user_bea', scope: { organizationId: 'org_acme' } })
  })

  test('start, stop, restart, and delete send their routes and parse the answer', async () => {
    answer = (request) => request.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ lifecycle: 'starting' })
    for (const [tool, method, action] of [
      [cloud.startCloudMachineAgentTool, 'POST', 'start'],
      [cloud.stopCloudMachineAgentTool, 'POST', 'stop'],
      [cloud.restartCloudMachineAgentTool, 'POST', 'restart'],
      [cloud.deleteCloudMachineAgentTool, 'DELETE', 'machine'],
    ] as const) {
      sent = []
      const result = await run(tool, { host: 'Build box' })
      expect(result.ok).toBe(true)
      expect(writes()).toEqual([{ userId: 'user_ann', scope: 'personal', method, path: `/v1/hosts/host_build/${action}`, body: undefined }])
    }
    expect(json(await run(cloud.startCloudMachineAgentTool, { host: 'host_build' })).machine.state).toBe('starting')
  })

  test('this host is refused before any request, by id, and before any write, by name', async () => {
    for (const tool of [cloud.updateCloudMachineAgentTool, cloud.stopCloudMachineAgentTool, cloud.restartCloudMachineAgentTool, cloud.deleteCloudMachineAgentTool]) {
      for (const host of [SELF.hostId, SELF.installationId]) {
        sent = []
        const result = await run(tool as AgentTool, { host, packages: ['git'], reason: 'r' })
        expect(result.ok).toBe(false)
        expect(result.text).toContain('never changes, stops, restarts, or deletes itself')
        expect(sent).toEqual([])
      }
      sent = []
      expect((await run(tool as AgentTool, { host: 'Self', packages: ['git'], reason: 'r' })).ok).toBe(false)
      expect(writes()).toEqual([])
    }
  })

  test('a refusal of Solus Cloud is one sentence a person can act on', async () => {
    answer = () => Response.json({ error: 'outside_delegation' }, { status: 403 })
    expect((await run(cloud.stopCloudMachineAgentTool, { host: 'host_build' })).text).toContain('acts for you only in another organization')
    answer = () => Response.json({ error: 'not_a_member', message: 'only an organization owner may do this' }, { status: 403 })
    expect((await run(cloud.deleteCloudMachineAgentTool, { host: 'host_build' })).text).toBe('Only an organization owner can do this.')
    answer = () => Response.json({ error: 'refused_by_host_policy' }, { status: 403 })
    expect((await run(cloud.createCloudMachineAgentTool, { reason: 'r' })).text).toContain('read_organization_policy')
  })

  test('a machine that Solus Cloud does not run has no start, stop, restart, or edit, and no request is sent for it', async () => {
    for (const tool of [cloud.startCloudMachineAgentTool, cloud.stopCloudMachineAgentTool, cloud.restartCloudMachineAgentTool, cloud.updateCloudMachineAgentTool]) {
      sent = []
      const result = await run(tool as AgentTool, { host: 'Own VM', reason: 'r' })
      expect(result).toEqual({ ok: false, text: 'Solus Cloud does not run this machine; only delete applies to it.' })
      expect(sent.map((request) => request.path)).toEqual(['/v1/hosts'])
    }
  })
})

describe('create_cloud_machine', () => {
  test('a clear organization makes the machine with no card and waits until the directory lists it', async () => {
    const base = directory
    const listed = machine('host_new', 'Docker box', { managedState: 'provisioning' })
    let reads = 0
    // The directory lists the machine from its third read: the tool waits for it.
    directoryRead = () => ++reads >= 3 ? { ...base, hosts: [...base.hosts, listed] } : base
    answer = () => Response.json({ hostId: 'host_new' }, { status: 201 })
    const result = await run(cloud.createCloudMachineAgentTool, { name: 'Docker box', packages: ['docker.io'], reason: 'Docker' })
    expect(writes()).toEqual([{ userId: 'user_ann', scope: 'personal', method: 'POST', path: '/v1/hosts', body: { organizationId: 'org_acme', label: 'Docker box', spec: { packages: ['docker.io'] } } }])
    expect(json(result)).toEqual({ created: true, machine: expect.objectContaining({ id: 'host_new', name: 'Docker box', state: 'provisioning' }), note: 'Use it with start_sessions.' })
    expect(reads).toBe(3)
  })

  test('a bad package or size is refused before any write', async () => {
    expect((await run(cloud.createCloudMachineAgentTool, { packages: ['rm -rf'], reason: 'r' })).ok).toBe(false)
    expect((await run(cloud.createCloudMachineAgentTool, { size: 'huge', reason: 'r' })).text).toContain('not a size')
    expect(writes()).toEqual([])
  })

  test('with several organizations and none named, the card asks; its answer is checked against the ask', async () => {
    directory = { ...directory, workspaces: orgs('acme', 'globex') }
    answer = () => Response.json({ hostId: 'host_new' }, { status: 201 })
    const live = liveSession('create-card')
    try {
      const forged = run(cloud.createCloudMachineAgentTool, { size: 'large', reason: 'A box for the tests.' }, live.context)
      const card = await live.shown()
      expect(card.kind).toBe('cloud-machine')
      expect(card.cloudMachine).toEqual({
        mode: 'create', reason: 'A box for the tests.', catalog: CATALOG, draft: { size: 'large' },
        organizations: [{ id: 'org_acme', name: 'Acme' }, { id: 'org_globex', name: 'Globex' }],
      })
      // An organization that the card did not offer is not a choice.
      expect(await live.answer(card, cloudMachineAnswers({ status: 'chosen', choice: { organizationId: 'org_evil' } }))).toBe(true)
      expect((await forged).ok).toBe(false)
      expect(writes()).toEqual([])
      expect(live.events).toContainEqual({ type: 'permission_resolved', questionId: card.questionId })

      const chosen = run(cloud.createCloudMachineAgentTool, { size: 'large', reason: 'A box for the tests.' }, live.context)
      const second = await live.shown(2)
      expect(await live.answer(second, cloudMachineAnswers({ status: 'chosen', choice: { organizationId: 'org_globex', size: 'large' } }))).toBe(true)
      await chosen
      expect(writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/v1/hosts', body: { organizationId: 'org_globex', spec: { size: 'large' } } })])

      const declined = run(cloud.createCloudMachineAgentTool, { reason: 'Again.' }, live.context)
      const third = await live.shown(3)
      expect(await live.answer(third, cloudMachineAnswers({ status: 'declined' }))).toBe(true)
      expect(json(await declined)).toMatchObject({ declined: true, note: 'The person declined. Do not ask again unless they ask you to.' })
      expect(writes()).toHaveLength(1)
    } finally { live.runtime.shutdown() }
  })

  test('a named organization shows no card', async () => {
    directory = { ...directory, workspaces: orgs('acme', 'globex') }
    answer = () => Response.json({ hostId: 'host_new' }, { status: 201 })
    await run(cloud.createCloudMachineAgentTool, { organization: 'Globex', reason: 'r' })
    expect(writes()[0]?.body).toEqual({ organizationId: 'org_globex' })
  })
})

describe('update_cloud_machine', () => {
  test('a given change is sent with no card', async () => {
    answer = () => Response.json({ changed: true })
    const result = await run(cloud.updateCloudMachineAgentTool, { host: 'Build box', packages: ['docker.io', 'git'], reason: 'r' })
    expect(writes()).toEqual([{ userId: 'user_ann', scope: 'personal', method: 'PATCH', path: '/v1/hosts/host_build/spec', body: { packages: ['docker.io', 'git'] } }])
    expect(json(result).note).toContain('restarts')
  })

  test('with nothing to change, the card shows the current spec and its answer is sent', async () => {
    answer = (request) => request.method === 'GET'
      ? Response.json({ size: 'large', packages: ['git'], setupScript: 'echo hi' })
      : Response.json({ changed: true })
    const live = liveSession('update-card')
    try {
      const pending = run(cloud.updateCloudMachineAgentTool, { host: 'host_build', reason: 'Edit the box.' }, live.context)
      const card = await live.shown()
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /v1/hosts', 'GET /v1/hosts/host_build/spec'])
      expect(card.cloudMachine).toEqual({
        mode: 'edit', reason: 'Edit the box.',
        host: { hostId: 'host_build', name: 'Build box', state: 'ready', size: 'Large' },
        current: { packages: ['git'], setupScript: 'echo hi' },
      })
      // A package Solus Cloud refuses is not a choice.
      expect(await live.answer(card, { status: 'chosen', packages: 'git; rm' })).toBe(true)
      expect((await pending).ok).toBe(false)
      expect(writes()).toEqual([])

      const again = run(cloud.updateCloudMachineAgentTool, { host: 'host_build', reason: 'Edit the box.' }, live.context)
      const second = await live.shown(2)
      expect(await live.answer(second, cloudMachineAnswers({ status: 'chosen', choice: { packages: ['git', 'docker.io'], setupScript: '' } }))).toBe(true)
      expect((await again).ok).toBe(true)
      expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { packages: ['git', 'docker.io'], setupScript: '' } })])
    } finally { live.runtime.shutdown() }
  })
})

describe('organization tools', () => {
  const settings = (revision: number, rules: Partial<OrganizationSettingsResponse['hostRules']> = {}): OrganizationSettingsResponse => ({
    organizationId: 'org_acme', name: 'Acme', slug: 'acme', role: 'owner', members: [],
    hostRules: { allowCloudHosts: true, allowPersonalHosts: true, defaultPackages: ['git'], defaultSetupScript: null, ...rules },
    hostRulesRevision: revision,
  })

  test('members and policy are read from their routes', async () => {
    answer = (request) => request.path.endsWith('/directory')
      ? Response.json({ organizationId: 'org_acme', name: 'Acme', members: [{ userId: 'user_bea', name: 'Bea', email: 'bea@acme.test', role: 'member' }], teams: [] })
      : Response.json(settings(4))
    expect(json(await run(organizationTools.listOrganizationMembersAgentTool, {})).members).toEqual([{ userId: 'user_bea', name: 'Bea', email: 'bea@acme.test', role: 'member' }])
    expect(json(await run(organizationTools.readOrganizationPolicyAgentTool, {}))).toMatchObject({ yourRole: 'owner', revision: 4, hostRules: { defaultPackages: ['git'] } })
    expect(sent.map((request) => request.path)).toEqual(['/v1/hosts', '/v1/orgs/org_acme/directory', '/v1/hosts', '/v1/orgs/org_acme/settings'])
  })

  test('with several organizations and none named, the tool asks for one', async () => {
    directory = { ...directory, workspaces: orgs('acme', 'globex') }
    const result = await run(organizationTools.readOrganizationPolicyAgentTool, {})
    expect(result.text).toContain('Name the organization')
  })

  test('a policy update sends the revision it read and keeps the rules it was not given', async () => {
    answer = (request) => request.method === 'GET' ? Response.json(settings(7)) : Response.json(settings(8, { allowPersonalHosts: false }))
    const result = await run(organizationTools.updateOrganizationPolicyAgentTool, { allow_personal_hosts: false })
    expect(writes()).toEqual([{
      userId: 'user_ann', scope: 'personal', method: 'PATCH', path: '/v1/orgs/org_acme/settings',
      body: { hostRules: { allowCloudHosts: true, allowPersonalHosts: false, defaultPackages: ['git'], defaultSetupScript: null }, expectedRevision: 7 },
    }])
    expect(json(result)).toMatchObject({ changed: true, revision: 8 })
  })

  test('a conflict returns the current rules and writes nothing more', async () => {
    answer = (request) => request.method === 'GET'
      ? Response.json(settings(7))
      : Response.json({ error: 'policy_conflict', revision: 9, document: settings(9, { allowCloudHosts: false }) }, { status: 409 })
    const result = await run(organizationTools.updateOrganizationPolicyAgentTool, { default_packages: ['docker.io'] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('"revision":9')
    expect(result.text).toContain('"allowCloudHosts":false')
    expect(writes()).toHaveLength(1)
  })

  test('a member is refused before the write', async () => {
    answer = () => Response.json({ ...settings(7), role: 'member' })
    expect((await run(organizationTools.updateOrganizationPolicyAgentTool, { name: 'Acme Inc' })).text).toContain('Only an organization owner')
    expect(writes()).toEqual([])
  })
})

describe('join_cloud_machine', () => {
  const JOIN = { address: 'https://build.example.com', ssh_target: 'ubuntu@10.20.30.40', reason: 'Join the build box.' }
  const joined = machine('host_joined', 'Build VM', { hasManagedCompute: undefined, managedState: undefined })
  /** The `ssh` that ran the join: not the `ssh -G` check. */
  const joinProcess = () => spawned.filter((each) => each.args[0] !== '-G')

  beforeEach(() => {
    answer = (request) => request.path === '/v1/enrollment-tickets'
      ? Response.json({ ticket: TICKET, expiresAt: Date.now() + 600_000, organizationId: 'org_acme' })
      : new Response(null, { status: 404 })
    // The directory lists the machine once the command ran.
    directoryRead = () => joinProcess().length ? { ...directory, hosts: [...directory.hosts, joined] } : directory
  })

  test('the code goes only on the standard input of ssh: never in argv, the result, or a log', async () => {
    // A CLI that prints its code must not put it in the result either.
    joinAnswer = () => ({ code: 0, stdout: `Linking with ${CODE}\nSolus: cloud host of Acme`, stderr: `ticket ${TICKET}` })
    const result = await run(cloud.joinCloudMachineAgentTool, JOIN)
    expect(result.ok).toBe(true)
    expect(writes()).toEqual([{ userId: 'user_ann', scope: 'personal', method: 'POST', path: '/v1/enrollment-tickets', body: { organizationId: 'org_acme' } }])
    const [ssh] = joinProcess()
    expect(joinProcess()).toHaveLength(1)
    expect(ssh!.command).toBe('ssh')
    expect(ssh!.stdin).toBe(CODE)
    expect(ssh!.args.at(-1)).toBe(`${cloud.JOIN_COMMAND} '--address' 'https://build.example.com'`)
    expect(ssh!.args.at(-2)).toBe('ubuntu@10.20.30.40')
    for (const each of spawned) expect(each.args.join(' ')).not.toContain(TICKET)
    expect(result.text).not.toContain(TICKET)
    expect(json(result)).toMatchObject({ joined: true, machine: { id: 'host_joined', name: 'Build VM' }, output: 'Linking with [link code]\nSolus: cloud host of Acme\nticket [link code]' })
    const devLog = process.env.SOLUS_DEV_LOG
    if (devLog && (await Bun.file(devLog).exists())) expect(await Bun.file(devLog).text()).not.toContain(TICKET)
  })

  test('a failed command returns its output without the code', async () => {
    joinAnswer = () => ({ code: 1, stdout: '', stderr: `This server is registered already (${CODE})` })
    const result = await run(cloud.joinCloudMachineAgentTool, JOIN)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('This server is registered already ([link code])')
    expect(result.text).not.toContain(TICKET)
  })

  test('an address that is not https, a member, or this machine is refused before a code is made', async () => {
    expect((await run(cloud.joinCloudMachineAgentTool, { ...JOIN, address: 'http://build.example.com' })).text).toContain('https://')
    holders = [{ userId: 'user_bea', scope: { organizationId: 'org_acme' } }]
    expect((await run(cloud.joinCloudMachineAgentTool, JOIN, quiet, MEMBER)).text).toContain('Only the owner of this host')
    holders = [{ userId: 'user_ann', scope: 'personal' }]
    runProcessHostname = '127.0.0.1'
    try {
      expect((await run(cloud.joinCloudMachineAgentTool, JOIN)).text).toContain('this computer')
    } finally { runProcessHostname = null }
    expect(writes()).toEqual([])
    expect(joinProcess()).toEqual([])
  })

  test('with several organizations and none named, the card asks; an organization outside it is refused', async () => {
    directory = { ...directory, workspaces: orgs('acme', 'globex') }
    const live = liveSession('join-card')
    try {
      const forged = run(cloud.joinCloudMachineAgentTool, JOIN, live.context)
      const card = await live.shown()
      expect(card.cloudMachine).toEqual({ mode: 'join', reason: 'Join the build box.', address: 'https://build.example.com', organizations: [{ id: 'org_acme', name: 'Acme' }, { id: 'org_globex', name: 'Globex' }] })
      expect(await live.answer(card, cloudMachineAnswers({ status: 'chosen', choice: { organizationId: 'org_evil' } }))).toBe(true)
      expect((await forged).ok).toBe(false)
      expect(writes()).toEqual([])
      expect(joinProcess()).toEqual([])

      const chosen = run(cloud.joinCloudMachineAgentTool, JOIN, live.context)
      const second = await live.shown(2)
      expect(await live.answer(second, cloudMachineAnswers({ status: 'chosen', choice: { organizationId: 'org_globex' } }))).toBe(true)
      await chosen
      expect(writes()).toEqual([expect.objectContaining({ path: '/v1/enrollment-tickets', body: { organizationId: 'org_globex' } })])
    } finally { live.runtime.shutdown() }
  })
})
