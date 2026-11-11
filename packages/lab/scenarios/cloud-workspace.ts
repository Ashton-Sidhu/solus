import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectNotServed, expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi, createLabDatabase, type SolusApiEngine, type LabSolusApi } from '../src/solus-api'

/**
 * The cloud workspace (docs/plans/cloud-service-model.md §15–§16): one service for
 * every organization, reached with workspace grants; a runner linked to the
 * organization whose agent writes land there, not on the runner; a session record
 * the runner reports; nothing of it visible to another organization; and no
 * execution method served. Runs on SQLite, and on Postgres too when
 * `POSTGRES_ADMIN_URL` names a server.
 */

const RUNNER_HOST_ID = 'labrunnerabcdefg'
/** A task of GitHub, by its task key. The service holds its attachments and never reads the task. */
const TASK_KEY = 'github:I_kwDOLabTask1'
const RUNNER_WORK_TITLE = 'Runner work from the mock agent'
const healthSchema = z.object({ requireAuth: z.boolean() })

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    last = await read()
  }
  return last
}

/** The runner's own log says when it traded a person's token for a delegation (plans/010-standard-oauth.md). */
function runnerActsForSomeone(runner: LabHost): boolean {
  const logFile = join(runner.dataDir, 'dev.log')
  // The organization's delegation; the owner's personal one is not organization work.
  return existsSync(logFile) && readFileSync(logFile, 'utf8').split('\n').some((line) => line.includes('"msg":"delegation_held"') && line.includes(`"scope":"organization:${ORGANIZATION_ID}"`))
}

/**
 * The renderer's prompt context for a new session in the Lab's working directory, with
 * the organization selected: on a machine attached for organization work a new root
 * needs one (plans/009-organization-vms.md §1).
 */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario also relies on.
  return { session, settings, statusBar } as IpcContext
}

interface Proof {
  ctx: ScenarioContext
  tag: string
  service: LabSolusApi
  clients: LabClient[]
}

function workspaceClient(proof: Proof, personaId: string): LabClient {
  const client = new LabClient({
    persona: personaForHost(personaId, 'managed'),
    hostUrl: proof.service.url,
    issuer: proof.ctx.issuer,
    hostId: SOLUS_API_AUDIENCE,
    hostKind: 'cloud',
  })
  proof.clients.push(client)
  return client
}

async function membersStep(proof: Proof): Promise<{ alice: LabClient; bob: LabClient; taskId: string }> {
  const { ctx, tag, service } = proof
  ctx.step(`${tag} alice and bob reach the workspace with workspace grants; a person is a member there and nothing else`)
  const alice = workspaceClient(proof, 'alice')
  const bob = workspaceClient(proof, 'bob')
  ctx.check(`${tag} alice connects`, (await alice.connect()).ok)
  ctx.check(`${tag} bob connects`, (await bob.connect()).ok)
  const info = await expectOk(ctx, `${tag} alice reads the server info`, alice.rpc('connectionsGetServerInfo'))
  ctx.check(`${tag} the service says it is the cloud, serving collaboration only, for her organization`, info?.hostKind === 'cloud' && info.organizationId === ORGANIZATION_ID && info.roles.length === 1 && info.roles[0] === 'collaboration' && info.principal === 'org-member', JSON.stringify(info))
  const health = healthSchema.safeParse(await (await fetch(`${service.url}/health`)).json())
  ctx.check(`${tag} the health probe demands a credential of everyone`, health.success && health.data.requireAuth)
  ctx.check(`${tag} pairing does not exist`, (await fetch(`${service.url}/pair/open`, { method: 'POST' })).status === 404)

  // GitHub and Jira own every task (docs/plans/provider-owned-tasks.md §6): the
  // service keeps what Solus attaches to a task key, and no task.
  ctx.step(`${tag} alice attaches a link to a task key on the service; bob sees it live`)
  const heard = bob.waitForEvent('tasks.invalidated')
  await expectOk(ctx, `${tag} alice links an automation to the task`, alice.rpc('tasksLink', TASK_KEY, { kind: 'automation', targetKey: 'lab-automation', title: 'Nightly check' }))
  await expectOk(ctx, `${tag} bob hears the tasks change`, heard)
  const bobAttachments = await expectOk(ctx, `${tag} bob reads the attachments of the task`, bob.rpc('tasksAttachments', TASK_KEY))
  ctx.check(`${tag} bob sees alice's link`, bobAttachments?.links.some((link) => link.targetKey === 'lab-automation') === true, JSON.stringify(bobAttachments?.links))
  const bobTasks = await expectOk(ctx, `${tag} bob lists tasks`, bob.rpc('tasksSidebarSnapshot'))
  ctx.check(`${tag} the service holds no copy of a task`, bobTasks?.tasks.length === 0, JSON.stringify(bobTasks?.tasks.map((row) => row.id)))
  await expectNotServed(ctx, `${tag} a task read is refused: the service reads no provider`, bob.rpc('tasksGet', TASK_KEY))
  return { alice, bob, taskId: TASK_KEY }
}

async function runnerStep(proof: Proof, bob: LabClient): Promise<{ runner: LabHost; sessionId: string }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a runner linked to the organization runs a turn whose work lands on the service`)
  const runner = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID })
  // The owner comes through the proxied listener with her access token: the runner acts for her with it.
  const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.tunnelUrl, issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'personal', organizationId: ORGANIZATION_ID })
  proof.clients.push(owner)
  ctx.check(`${tag} the owner reaches the runner`, (await owner.connect()).ok)
  // Agent tools follow the record home: only a session admitted to the organization
  // writes to the Solus API (plans/009-organization-vms.md §9). The owner's window names
  // the organization, so the runner admits her new root there before the provider starts.
  const sessionId = randomUUID()
  await expectOk(ctx, `${tag} the owner opens a new session on the runner`, owner.rpc('watchSession', { sessionId }))
  await expectOk(ctx, `${tag} the owner starts a mock-agent turn in the organization on the runner`, owner.rpc('prompt', promptContext(ctx, sessionId), { prompt: 'cloud __MOCK_AGENT_TOOLS__', clientPromptId: `${sessionId}-1` }))
  // The ticket door makes the delegation without waiting (ADR 0001 stage 4).
  ctx.check(`${tag} the runner acts for the owner in the organization`, await until(async () => runnerActsForSomeone(runner), (acts) => acts, 10_000))
  const runnerWorks = await until(() => bob.records.listWorks(), (list) => list.some((row) => row.title === RUNNER_WORK_TITLE), 15_000)
  ctx.check(`${tag} bob sees the work the agent created on the service`, runnerWorks.some((row) => row.title === RUNNER_WORK_TITLE), JSON.stringify(runnerWorks.map((row) => row.title)))
  const localWorks = await expectOk(ctx, `${tag} the owner lists the runner's own works`, owner.records.listWorks())
  ctx.check(`${tag} the runner's own tables hold no such work`, localWorks?.every((row) => row.title !== RUNNER_WORK_TITLE) === true)
  // The session id names a session everywhere (docs/plans/session-identity.md).
  return { runner, sessionId }
}

async function recordStep(proof: Proof, bob: LabClient, runner: LabHost, sessionId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner reports the session; the service lists it, and keeps everything after the runner stops`)
  const recorded = await until(() => bob.records.sessionRecordList({ scope: 'all' }).then((list) => list.records), (list) => list.some((record) => record.sessionId === sessionId), 15_000)
  const record = recorded.find((row) => row.sessionId === sessionId)
  ctx.check(`${tag} the service lists the runner's session, naming the runner`, record?.runnerHostId === RUNNER_HOST_ID, JSON.stringify(record))
  await runner.stop()
  const worksAfter = await expectOk(ctx, `${tag} bob lists works after the runner stopped`, bob.records.listWorks())
  ctx.check(`${tag} the work is still there`, worksAfter?.some((row) => row.title === RUNNER_WORK_TITLE) === true)
  const sessionsAfter = await expectOk(ctx, `${tag} bob lists session records after the runner stopped`, bob.records.sessionRecordList({ scope: 'all' }).then((list) => list.records))
  ctx.check(`${tag} the session is still there`, sessionsAfter?.some((row) => row.sessionId === sessionId) === true)
}

async function otherOrganizationStep(proof: Proof, taskId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} carol, of another organization, sees none of it`)
  const carol = workspaceClient(proof, 'carol')
  ctx.check(`${tag} carol connects`, (await carol.connect()).ok)
  // The task key is the provider's, so carol can name it; the attachments are alice's organization's.
  const carolAttachments = await expectOk(ctx, `${tag} carol reads the attachments of the same task key`, carol.rpc('tasksAttachments', taskId))
  ctx.check(`${tag} carol sees no link of alice's organization`, carolAttachments?.links.length === 0 && carolAttachments.activity.length === 0, JSON.stringify(carolAttachments))
  const carolWorks = await expectOk(ctx, `${tag} carol lists works`, carol.records.listWorks())
  ctx.check(`${tag} carol's work list is empty`, carolWorks?.length === 0)
  const carolSessions = await expectOk(ctx, `${tag} carol lists session records`, carol.records.sessionRecordList({ scope: 'all' }).then((list) => list.records))
  ctx.check(`${tag} carol's session list is empty`, carolSessions?.length === 0)
  const carolPresence = await expectOk(ctx, `${tag} carol reads presence`, carol.rpc('presenceSnapshot'))
  ctx.check(`${tag} carol's room holds only her organization`, carolPresence?.host.participants.every((row) => row.user.displayName === 'Carol') === true, JSON.stringify(carolPresence?.host.participants.map((row) => row.user.displayName)))
}

async function executionStep(proof: Proof, alice: LabClient): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} execution methods do not exist on the service`)
  await expectNotServed(ctx, `${tag} git is refused: the service has no such method`, alice.rpc('gitRefreshState', ctx.cwd))
  await expectNotServed(ctx, `${tag} a headless session is refused: the service has no such method`, alice.rpc('createHeadlessSession', { prompt: 'x', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd }))
}

async function proveWorkspace(ctx: ScenarioContext, engine: SolusApiEngine, databaseUrl?: string): Promise<void> {
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine, databaseUrl })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  let runner: LabHost | null = null
  try {
    const { alice, bob, taskId } = await membersStep(proof)
    const started = await runnerStep(proof, bob)
    runner = started.runner
    await recordStep(proof, bob, runner, started.sessionId)
    runner = null
    await otherOrganizationStep(proof, taskId)
    await executionStep(proof, alice)
  } finally {
    for (const client of proof.clients) client.close()
    await runner?.stop()
    ctx.issuer.setWorkspaceRoute(previousRoute)
    await service.stop()
  }
}

export default scenario('cloud workspace: one service for the organization, a runner that writes to it', async (ctx) => {
  await proveWorkspace(ctx, 'sqlite')
  const adminUrl = process.env.POSTGRES_ADMIN_URL
  if (!adminUrl) {
    ctx.step('POSTGRES_ADMIN_URL is not set: the Postgres run is skipped')
    return
  }
  const database = await createLabDatabase(adminUrl)
  try {
    await proveWorkspace(ctx, 'postgres', database.url)
  } finally {
    await database.drop()
  }
}, { only: 'personal' })
