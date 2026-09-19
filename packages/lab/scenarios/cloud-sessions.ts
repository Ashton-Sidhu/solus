import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { recordedRuns } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectOk, scenario, type ScenarioContext } from '../src/scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine, type WorkspaceService } from '../src/workspace'

/**
 * The P2 exit test (docs/plans/cloud-service-model.md §4, §6, §11): a runner is
 * killed in the middle of a turn; the transcript it mirrored so far is readable
 * on the workspace service and the session is listed with the runner off; a
 * prompt sent to the session waits on the cloud queue; the runner restarts on
 * the same data directory, claims the prompt, and runs it; the new turn's rows
 * reach the cloud. Runs on SQLite, and on Postgres when `POSTGRES_ADMIN_URL`
 * names a server.
 */

const RUNNER_HOST_ID = 'labrunnersessions'
const ALICE_USER_ID = PERSONAS.alice.userId
const FIRST_PROMPT = '__MOCK_CLOUD__ __MOCK_SLOW__ first turn on the runner'
const SECOND_PROMPT = 'second turn queued while the runner was away'

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

interface Proof {
  ctx: ScenarioContext
  tag: string
  service: WorkspaceService
  clients: LabClient[]
}

function cloudClient(proof: Proof, personaId: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: proof.service.url, issuer: proof.ctx.issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud' })
  proof.clients.push(client)
  return client
}

function bootRunner(ctx: ScenarioContext, dataDir?: string): Promise<LabHost> {
  return bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID, runnerOwnerUserId: ALICE_USER_ID, dataDir })
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
  const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.localUrl, issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'personal', credentialFree: true })
  proof.clients.push(owner)
  ctx.check(`${tag} the owner reaches the runner`, (await owner.connect()).ok)
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

/** A prompt sent with no runner waits on the cloud queue. */
async function enqueueStep(proof: Proof, alice: LabClient, sessionId: string): Promise<string> {
  const { ctx, tag } = proof
  ctx.step(`${tag} alice sends a prompt to the session; it waits on the cloud queue`)
  const queued = await expectOk(ctx, `${tag} alice enqueues`, alice.rpc('sessionPromptEnqueue', { sessionId, text: SECOND_PROMPT }))
  ctx.check(`${tag} the prompt is waiting`, queued?.state === 'waiting' && queued.author.userId === ALICE_USER_ID, JSON.stringify(queued))
  const listed = await expectOk(ctx, `${tag} the queue lists it`, alice.rpc('sessionPromptQueueList', sessionId))
  ctx.check(`${tag} one waiting prompt`, listed?.length === 1 && listed[0]?.state === 'waiting')
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const stillWaiting = await alice.rpc('sessionPromptQueueList', sessionId)
  ctx.check(`${tag} it still waits with no runner`, stillWaiting[0]?.state === 'waiting', stillWaiting[0]?.state)
  return queued?.queueId ?? ''
}

/** The runner comes back on its data directory, claims the prompt, and runs it. */
async function restartStep(proof: Proof, dataDir: string, alice: LabClient, sessionId: string): Promise<LabHost> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner restarts on its data directory, claims the prompt, and runs it on the owner's login`)
  const runner = await bootRunner(ctx, dataDir)
  ctx.check(`${tag} the restarted runner minted a grant`, await runnerHoldsGrant(runner, 20_000))
  const drained = await until(() => alice.rpc('sessionPromptQueueList', sessionId), (rows) => rows[0]?.state === 'dispatched' || rows[0]?.state === 'failed', 45_000)
  ctx.check(`${tag} the prompt was dispatched by the runner`, drained[0]?.state === 'dispatched' && drained[0].claimedByHostId === RUNNER_HOST_ID, JSON.stringify(drained[0]))
  const runs = await until(async () => recordedRuns({ ...ctx, host: runner }), (rows) => rows.some((row) => row.prompt.includes(SECOND_PROMPT)), 15_000)
  const drainedRun = runs.find((row) => row.prompt.includes(SECOND_PROMPT))
  ctx.check(`${tag} the turn ran on the host login, since its author owns the runner`, drainedRun?.seat?.isHostLogin === true, JSON.stringify(drainedRun?.seat))
  const grown = await until(() => transcriptOn(alice, sessionId), (rows) => rows.some(isAnswer), 20_000)
  ctx.check(`${tag} the new turn's rows reached the service`, grown.some((row) => row.role === 'user' && row.content.includes(SECOND_PROMPT)) && grown.some(isAnswer), rowsOf(grown))
  const settled = await until(() => alice.rpc('sessionRecordList', {}), (rows) => rows.find((row) => row.sessionId === sessionId)?.status === 'idle', 20_000)
  const record = settled.find((row) => row.sessionId === sessionId)
  ctx.check(`${tag} the record settled to idle`, record?.status === 'idle', JSON.stringify(record))
  return runner
}

/** A waiting prompt can be withdrawn; a dispatched one cannot; a member reads the same rows. */
async function withdrawStep(proof: Proof, runner: LabHost, alice: LabClient, sessionId: string, dispatchedQueueId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a queued prompt can be withdrawn while it waits; a dispatched one cannot`)
  const withdrawn = await expectOk(ctx, `${tag} cancelling a dispatched prompt answers false`, alice.rpc('sessionPromptQueueCancel', { queueId: dispatchedQueueId }))
  ctx.check(`${tag} not cancelled`, withdrawn?.cancelled === false)
  await runner.stop()
  const waiting = await expectOk(ctx, `${tag} alice enqueues another with the runner gone`, alice.rpc('sessionPromptEnqueue', { sessionId, text: 'never sent' }))
  const cancelled = await expectOk(ctx, `${tag} and withdraws it`, alice.rpc('sessionPromptQueueCancel', { queueId: waiting?.queueId ?? '' }))
  ctx.check(`${tag} cancelled`, cancelled?.cancelled === true)
  const bob = cloudClient(proof, 'bob')
  ctx.check(`${tag} bob reaches the service`, (await bob.connect()).ok)
  const bobSees = await expectOk(ctx, `${tag} bob, an organization member, reads the transcript too`, transcriptOn(bob, sessionId))
  const aliceSees = await transcriptOn(alice, sessionId)
  ctx.check(`${tag} bob sees the same rows`, (bobSees?.length ?? 0) === aliceSees.length)
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
    const queueId = await enqueueStep(proof, started.alice, started.sessionId)
    runner = await restartStep(proof, runner.dataDir, started.alice, started.sessionId)
    await withdrawStep(proof, runner, started.alice, started.sessionId, queueId)
    runner = null
  } finally {
    for (const client of proof.clients) client.close()
    await runner?.stop()
    ctx.issuer.setWorkspaceRoute(null)
    await service.stop()
  }
}

export default scenario('cloud sessions: the transcript in the cloud, a prompt that waits, a turn that resumes', async (ctx) => {
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
