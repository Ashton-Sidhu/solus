import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine, type WorkspaceService } from '../src/workspace'

/**
 * The cloud workspace (docs/plans/cloud-service-model.md §15–§16): one service for
 * every organization, reached with workspace grants; a runner linked to the
 * organization whose agent writes land there, not on the runner; a session record
 * the runner reports; nothing of it visible to another organization; and no
 * execution method served. Runs on SQLite, and on Postgres too when
 * `POSTGRES_ADMIN_URL` names a server.
 */

const RUNNER_HOST_ID = 'labrunnerabcdefg'
const RUNNER_TASK_TITLE = 'Runner task from the mock agent'
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

/** The runner's own log says when it holds a grant for the organization. */
async function runnerLinkedToOrganization(runner: LabHost, timeoutMs: number): Promise<boolean> {
  const logFile = join(runner.dataDir, 'dev.log')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('"msg":"runner_grant_minted"')) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

interface Proof {
  ctx: ScenarioContext
  tag: string
  service: WorkspaceService
  clients: LabClient[]
}

function workspaceClient(proof: Proof, personaId: string): LabClient {
  const client = new LabClient({
    persona: personaForHost(personaId, 'managed'),
    hostUrl: proof.service.url,
    issuer: proof.ctx.issuer,
    hostId: WORKSPACE_AUDIENCE,
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

  ctx.step(`${tag} alice creates a task on the service; bob sees it live`)
  const task = await expectOk(ctx, `${tag} alice creates a task`, alice.rpc('tasksCreate', { title: 'Plan the launch', projectKey: ctx.cwd }))
  await expectOk(ctx, `${tag} bob hears the tasks change`, bob.waitForEvent('tasks.invalidated'))
  const bobTasks = await expectOk(ctx, `${tag} bob lists tasks`, bob.rpc('tasksList', {}))
  ctx.check(`${tag} bob sees alice's task`, !!task && !!bobTasks?.tasks.some((row) => row.id === task.id))
  await expectOk(ctx, `${tag} bob opens it`, bob.rpc('tasksGet', task?.id ?? ''))
  return { alice, bob, taskId: task?.id ?? '' }
}

async function runnerStep(proof: Proof, bob: LabClient): Promise<{ runner: LabHost; sessionId: string }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a runner linked to the organization runs a turn whose task and work land on the service`)
  const runner = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID })
  ctx.check(`${tag} the runner minted a grant for the organization`, await runnerLinkedToOrganization(runner, 20_000))
  const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.localUrl, issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'personal', credentialFree: true })
  proof.clients.push(owner)
  ctx.check(`${tag} the owner reaches the runner locally`, (await owner.connect()).ok)
  const started = await expectOk(ctx, `${tag} the owner starts a mock-agent turn on the runner`, owner.rpc('createHeadlessSession', { prompt: 'cloud __MOCK_AGENT_TOOLS__', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd, skipTaskCreation: true }))
  const runnerTask = await until(() => bob.rpc('tasksList', {}), (result) => result.tasks.some((row) => row.title === RUNNER_TASK_TITLE), 15_000)
  ctx.check(`${tag} bob sees the task the agent created on the service`, runnerTask.tasks.some((row) => row.title === RUNNER_TASK_TITLE), JSON.stringify(runnerTask.tasks.map((row) => row.title)))
  const runnerWorks = await until(() => bob.rpc('listWorks'), (list) => list.some((row) => row.title === RUNNER_WORK_TITLE), 15_000)
  ctx.check(`${tag} bob sees the work the agent created on the service`, runnerWorks.some((row) => row.title === RUNNER_WORK_TITLE), JSON.stringify(runnerWorks.map((row) => row.title)))
  const localTasks = await expectOk(ctx, `${tag} the owner lists the runner's own tasks`, owner.rpc('tasksList', {}))
  ctx.check(`${tag} the runner's own tables hold no such task`, localTasks?.tasks.every((row) => row.title !== RUNNER_TASK_TITLE) === true)
  const localWorks = await expectOk(ctx, `${tag} the owner lists the runner's own works`, owner.rpc('listWorks'))
  ctx.check(`${tag} nor such a work`, localWorks?.every((row) => row.title !== RUNNER_WORK_TITLE) === true)
  return { runner, sessionId: started?.agentSessionId ?? '' }
}

async function recordStep(proof: Proof, bob: LabClient, runner: LabHost, sessionId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner reports the session; the service lists it, and keeps everything after the runner stops`)
  const recorded = await until(() => bob.rpc('sessionRecordList', {}), (list) => list.some((record) => record.sessionId === sessionId), 15_000)
  const record = recorded.find((row) => row.sessionId === sessionId)
  ctx.check(`${tag} the service lists the runner's session, naming the runner`, record?.runnerHostId === RUNNER_HOST_ID, JSON.stringify(record))
  await runner.stop()
  const tasksAfter = await expectOk(ctx, `${tag} bob lists tasks after the runner stopped`, bob.rpc('tasksList', {}))
  ctx.check(`${tag} the task is still there`, tasksAfter?.tasks.some((row) => row.title === RUNNER_TASK_TITLE) === true)
  const worksAfter = await expectOk(ctx, `${tag} bob lists works after the runner stopped`, bob.rpc('listWorks'))
  ctx.check(`${tag} the work is still there`, worksAfter?.some((row) => row.title === RUNNER_WORK_TITLE) === true)
  const sessionsAfter = await expectOk(ctx, `${tag} bob lists session records after the runner stopped`, bob.rpc('sessionRecordList', {}))
  ctx.check(`${tag} the session is still there`, sessionsAfter?.some((row) => row.sessionId === sessionId) === true)
}

async function otherOrganizationStep(proof: Proof, taskId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} carol, of another organization, sees none of it`)
  const carol = workspaceClient(proof, 'carol')
  ctx.check(`${tag} carol connects`, (await carol.connect()).ok)
  const carolTasks = await expectOk(ctx, `${tag} carol lists tasks`, carol.rpc('tasksList', {}))
  ctx.check(`${tag} carol's task list is empty`, carolTasks?.tasks.length === 0, JSON.stringify(carolTasks?.tasks.map((row) => row.title)))
  const carolWorks = await expectOk(ctx, `${tag} carol lists works`, carol.rpc('listWorks'))
  ctx.check(`${tag} carol's work list is empty`, carolWorks?.length === 0)
  const carolSessions = await expectOk(ctx, `${tag} carol lists session records`, carol.rpc('sessionRecordList', {}))
  ctx.check(`${tag} carol's session list is empty`, carolSessions?.length === 0)
  await expectRefused(ctx, `${tag} carol cannot open alice's task`, carol.rpc('tasksGet', taskId))
  const carolPresence = await expectOk(ctx, `${tag} carol reads presence`, carol.rpc('presenceSnapshot'))
  ctx.check(`${tag} carol's room holds only her organization`, carolPresence?.host.participants.every((row) => row.displayName === 'Carol') === true, JSON.stringify(carolPresence?.host.participants.map((row) => row.displayName)))
}

async function executionStep(proof: Proof, alice: LabClient): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} execution methods do not exist on the service`)
  await expectRefused(ctx, `${tag} git is refused with PLANE_DISABLED`, alice.rpc('gitRefreshState', ctx.cwd), 'PLANE_DISABLED')
  await expectRefused(ctx, `${tag} a headless session is refused with PLANE_DISABLED`, alice.rpc('createHeadlessSession', { prompt: 'x', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd }), 'PLANE_DISABLED')
}

async function proveWorkspace(ctx: ScenarioContext, engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
  const service = await bootWorkspaceService({ issuer: ctx.issuer, engine, databaseUrl })
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
    ctx.issuer.setWorkspaceRoute(null)
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
