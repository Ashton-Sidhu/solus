import { recordedRuns } from '../src/oracle'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine, type WorkspaceService } from '../src/workspace'

/**
 * The P2 exit test (docs/plans/cloud-service-model.md §6, §11, §18): a runner is
 * killed in the middle of a turn; the transcript it mirrored so far is readable
 * on the workspace service and the session is listed with the runner off; the
 * runner restarts on the same data directory and its owner prompts it locally;
 * the new turn's rows reach the cloud and the record settles. Runs on SQLite,
 * and on Postgres when `POSTGRES_ADMIN_URL` names a server.
 */

const RUNNER_HOST_ID = 'labrunnersessions'
const FIRST_PROMPT = '__MOCK_CLOUD__ __MOCK_SLOW__ first turn on the runner'
const SECOND_PROMPT = 'second turn once the runner is back'

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

async function runnerHoldsGrant(runner: LabHost, timeoutMs: number): Promise<boolean> {
  const logFile = join(runner.dataDir, 'dev.log')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('"msg":"runner_grant_minted"')) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** The renderer's prompt context for the session in the Lab's working directory; the provider thread id resumes it. */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: sessionId, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'auto', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', rateLimitBehavior: 'queue' }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId), { prompt: text, clientPromptId: `${sessionId}-${Date.now()}` })
}

interface Proof {
  ctx: ScenarioContext
  tag: string
  service: WorkspaceService
  clients: LabClient[]
}

function cloudClient(proof: Proof, personaId: string, shareSecret?: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: proof.service.url, issuer: proof.ctx.issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud', shareSecret })
  proof.clients.push(client)
  return client
}

/** The owner on the runner's own listener: a trusted loopback caller, no grant. */
async function ownerClient(proof: Proof, runner: LabHost): Promise<LabClient> {
  const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.localUrl, issuer: proof.ctx.issuer, hostId: runner.hostId, hostKind: 'personal', credentialFree: true })
  proof.clients.push(owner)
  proof.ctx.check(`${proof.tag} the owner reaches the runner`, (await owner.connect()).ok)
  return owner
}

function bootRunner(ctx: ScenarioContext, dataDir?: string): Promise<LabHost> {
  return bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID, dataDir })
}

async function transcriptOn(client: LabClient, sessionId: string): Promise<WireSessionLoadMessage[]> {
  const page = await client.rpc('loadSessionPage', { sessionId, provider: 'claude-code', limit: 200 })
  return page.messages
}

const rowsOf = (rows: WireSessionLoadMessage[]) => JSON.stringify(rows.map((row) => `${row.role}:${row.content}`))
const isAnswer = (row: WireSessionLoadMessage) => row.role === 'assistant' && row.content.toLowerCase().includes('mock response')

/** The runner streams a slow turn; the service holds its rows before the turn is over. */
async function streamStep(proof: Proof): Promise<{ runner: LabHost; alice: LabClient; sessionId: string }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a runner of the organization starts a slow turn; its rows reach the service as it streams`)
  const runner = await bootRunner(ctx)
  ctx.check(`${tag} the runner minted a grant`, await runnerHoldsGrant(runner, 20_000))
  const owner = await ownerClient(proof, runner)
  const started = await expectOk(ctx, `${tag} the owner starts the slow turn`, owner.rpc('createHeadlessSession', { prompt: FIRST_PROMPT, provider: 'claude-code', modelId: 'mock-model', reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd, skipTaskCreation: true }))
  const sessionId = started?.agentSessionId ?? ''
  const alice = cloudClient(proof, 'alice')
  ctx.check(`${tag} alice reaches the service`, (await alice.connect()).ok)
  const streamed = await until(() => transcriptOn(alice, sessionId), (rows) => rows.some((row) => row.role === 'assistant'), 15_000)
  ctx.check(`${tag} the service holds the user row and at least one assistant row before the turn is over`, streamed.some((row) => row.role === 'user' && row.content.includes('first turn')) && streamed.some((row) => row.role === 'assistant'), rowsOf(streamed))
  return { runner, alice, sessionId }
}

/** The runner dies mid-turn; what it mirrored stays readable and the session stays listed. */
async function killStep(proof: Proof, runner: LabHost, alice: LabClient, sessionId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner is killed mid-turn`)
  await runner.stop({ kill: true })
  const afterKill = await transcriptOn(alice, sessionId)
  ctx.check(`${tag} the transcript mirrored so far is readable with the runner dead`, afterKill.length >= 2 && afterKill.length < 10, `${afterKill.length} rows`)
  const records = await expectOk(ctx, `${tag} alice lists session records`, alice.rpc('sessionRecordList', {}))
  ctx.check(`${tag} the session is listed while the runner is off, naming the runner`, records?.some((record) => record.sessionId === sessionId && record.runnerHostId === RUNNER_HOST_ID) === true)
  const infos = await expectOk(ctx, `${tag} the service describes the session from its record`, alice.rpc('getSessionInfos', [sessionId]))
  ctx.check(`${tag} the description is not null`, !!infos?.[0], JSON.stringify(infos))
}

/** The runner comes back on its data directory; its owner prompts it locally, and the new turn reaches the cloud. */
async function restartStep(proof: Proof, dataDir: string, alice: LabClient, sessionId: string): Promise<LabHost> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner restarts on its data directory and the owner prompts it locally`)
  const runner = await bootRunner(ctx, dataDir)
  ctx.check(`${tag} the restarted runner minted a grant`, await runnerHoldsGrant(runner, 20_000))
  const owner = await ownerClient(proof, runner)
  await expectOk(ctx, `${tag} the owner prompts the session on the runner`, prompt(owner, ctx, sessionId, SECOND_PROMPT))
  const grown = await until(() => transcriptOn(alice, sessionId), (rows) => rows.some((row) => row.content.includes(SECOND_PROMPT)) && rows.some(isAnswer), 20_000)
  ctx.check(`${tag} the new turn's rows reached the service`, grown.some((row) => row.role === 'user' && row.content.includes(SECOND_PROMPT)) && grown.some(isAnswer), rowsOf(grown))
  const settled = await until(() => alice.rpc('sessionRecordList', {}), (rows) => rows.find((row) => row.sessionId === sessionId)?.status === 'idle', 20_000)
  const record = settled.find((row) => row.sessionId === sessionId)
  ctx.check(`${tag} the record settled to idle`, record?.status === 'idle', JSON.stringify(record))
  return runner
}

/** A member reads the same rows the owner does. */
async function memberStep(proof: Proof, alice: LabClient, sessionId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a member of the organization reads the transcript too`)
  const bob = cloudClient(proof, 'bob')
  ctx.check(`${tag} bob reaches the service`, (await bob.connect()).ok)
  const bobSees = await expectOk(ctx, `${tag} bob reads the transcript`, transcriptOn(bob, sessionId))
  const aliceSees = await transcriptOn(alice, sessionId)
  ctx.check(`${tag} bob sees the same rows`, (bobSees?.length ?? 0) === aliceSees.length && aliceSees.length > 0, `${bobSees?.length ?? 0} vs ${aliceSees.length}`)
}

async function proveSessions(ctx: ScenarioContext, engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
  const service = await bootWorkspaceService({ issuer: ctx.issuer, engine, databaseUrl })
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  let runner: LabHost | null = null
  try {
    const started = await streamStep(proof)
    runner = started.runner
    await killStep(proof, runner, started.alice, started.sessionId)
    const resource = { kind: 'session' as const, id: started.sessionId }
    const link = await started.alice.rpc('shareSetLink', { resource, role: 'editor' })
    const guest = cloudClient(proof, 'maya', link!.secret)
    ctx.check(`${engine}: guest opens session with runner stopped`, (await guest.connect()).ok)
    ctx.check(`${engine}: guest reads mirrored history`, (await transcriptOn(guest, started.sessionId)).length > 0)
    await until(() => guest.rpc('sharedSessionAvailable', started.sessionId), (online) => !online, 10_000)
    try {
      await guest.rpc('sharedSessionPrompt', { sessionId: started.sessionId, text: 'must not run offline' })
      ctx.check('offline guest prompt is not accepted', false)
    } catch (error) {
      ctx.check('offline guest prompt is not accepted', error instanceof Error && error.message.includes('offline'))
    }
    runner = await restartStep(proof, runner.dataDir, started.alice, started.sessionId)
    const sharer = new LabClient({ persona: personaForHost('alice', 'managed'), hostUrl: runner.tunnelUrl, issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'managed' })
    proof.clients.push(sharer)
    ctx.check(`${engine}: sharer reaches execution host`, (await sharer.connect()).ok)
    await sharer.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-sharer' })
    ctx.check(`${engine}: guest sees runner return`, await until(() => guest.rpc('sharedSessionAvailable', started.sessionId), (online) => online, 15_000))
    const sent = await guest.rpc('sharedSessionPrompt', { sessionId: started.sessionId, text: 'P4 guest prompt' })
    ctx.check(`${engine}: runner acknowledges guest prompt`, sent.accepted)
    const run = await until(async () => recordedRuns({ ...ctx, host: runner! }).find((item) => item.prompt.includes('P4 guest prompt')), (item) => !!item, 15_000)
    ctx.check(`${engine}: guest runs on sharer seat`, run?.seat?.userId === 'user-alice')
    ctx.check(`${engine}: guest uses the host-local sharer token`, run?.seat?.envToken === 'lab-token-sharer')
    const transcript = await until(() => transcriptOn(guest, started.sessionId), (rows) => rows.some((row) => row.content.includes('P4 guest prompt')), 15_000)
    ctx.check(`${engine}: guest prompt reaches cloud transcript`, transcript.some((row) => row.content.includes('P4 guest prompt')))
    await started.alice.rpc('shareSetLink', { resource, role: 'viewer' })
    await expectRefused(ctx, 'downgraded guest cannot prompt', guest.rpc('sharedSessionPrompt', { sessionId: started.sessionId, text: 'must not run as viewer' }))

    await memberStep(proof, started.alice, started.sessionId)
  } finally {
    for (const client of proof.clients) client.close()
    await runner?.stop()
    ctx.issuer.setWorkspaceRoute(null)
    await service.stop()
  }
}

export default scenario('cloud sessions: the transcript in the cloud, a turn that resumes on the runner', async (ctx) => {
  await proveSessions(ctx, 'sqlite')
  const adminUrl = process.env.POSTGRES_ADMIN_URL
  if (!adminUrl) {
    ctx.step('POSTGRES_ADMIN_URL is not set: the Postgres run is skipped')
    return
  }
  const database = await createLabDatabase(adminUrl)
  try {
    await proveSessions(ctx, 'postgres', database.url)
  } finally {
    await database.drop()
  }
}, { only: 'personal' })
