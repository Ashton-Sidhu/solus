import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { recordedRuns, type RecordedRun } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine, type WorkspaceService } from '../src/workspace'

/**
 * The P3 exit test (docs/plans/cloud-service-model.md §5, §11): bob connects his
 * Claude login once on the workspace service; his turn on runner A runs on that
 * credential and the provider refreshes it during the turn; runner A writes the
 * refreshed set back; his turn on runner B leases the refreshed version; cara's
 * turn on runner A runs on her own credential and never sees bob's; bob
 * disconnects on the service and his next turn is refused with the local copy
 * purged. Runs on SQLite, and on Postgres when `POSTGRES_ADMIN_URL` is set.
 */

const RUNNER_A = 'labrunnervaultaaa'
const RUNNER_B = 'labrunnervaultbbb'
const ALICE_USER_ID = PERSONAS.alice.userId
const BOB_USER_ID = PERSONAS.bob.userId
const CARA_USER_ID = PERSONAS.cara.userId

/** What `claude auth login` leaves in `.credentials.json`, as bob would paste it. */
function bobCredentialSet(): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'bob-access-1', refreshToken: 'bob-refresh-1', expiresAt: Date.now() + 60 * 60_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } })
}

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

function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'auto', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, latestCheckpointId: null }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', rateLimitBehavior: 'queue' }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId), { prompt: text, clientPromptId: `${sessionId}-${Date.now()}` })
}

function runOn(ctx: ScenarioContext, runner: LabHost, marker: string): Promise<RecordedRun | undefined> {
  return until(async () => recordedRuns({ ...ctx, host: runner }).findLast((row) => row.prompt.includes(marker)), (row) => row !== undefined, 15_000)
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

/** A member on a runner, through the runner's proxied listener with a grant that names alice as the owner. */
function memberOn(proof: Proof, runner: LabHost, personaId: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: runner.tunnelUrl, issuer: proof.ctx.issuer, hostId: runner.hostId, hostKind: 'personal', hostOwnerUserId: ALICE_USER_ID })
  proof.clients.push(client)
  return client
}

function credentialFileOf(runner: LabHost, userId: string): string {
  return join(`${runner.dataDir}-seats`, 'claude', userId, '.credentials.json')
}

/** bob's login enters the vault once, on the service. */
async function connectStep(proof: Proof): Promise<LabClient> {
  const { ctx, tag } = proof
  ctx.step(`${tag} bob connects his Claude login once, on the workspace service`)
  const bobCloud = cloudClient(proof, 'bob')
  ctx.check(`${tag} bob reaches the service`, (await bobCloud.connect()).ok)
  const connected = await expectOk(ctx, `${tag} bob pastes his credential set`, bobCloud.rpc('seatConnectToken', { provider: 'claude-code', token: bobCredentialSet() }))
  ctx.check(`${tag} the vault holds a login-method credential that can show usage`, connected?.state === 'connected' && connected.method === 'login' && connected.usageCapable === true, JSON.stringify(connected))
  const listed = await expectOk(ctx, `${tag} bob lists his seats on the service`, bobCloud.rpc('seatList'))
  ctx.check(`${tag} Claude connected, Codex none`, listed?.find((seat) => seat.provider === 'claude-code')?.state === 'connected' && listed.find((seat) => seat.provider === 'codex')?.state === 'none')
  return bobCloud
}

async function bootRunnersStep(proof: Proof, runners: LabHost[]): Promise<{ runnerA: LabHost; runnerB: LabHost }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} two runners of the organization come up`)
  const runnerA = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_A, runnerOf: ORGANIZATION_ID })
  runners.push(runnerA)
  const runnerB = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_B, runnerOf: ORGANIZATION_ID })
  runners.push(runnerB)
  ctx.check(`${tag} runner A holds a grant`, await runnerHoldsGrant(runnerA, 20_000))
  ctx.check(`${tag} runner B holds a grant`, await runnerHoldsGrant(runnerB, 20_000))
  return { runnerA, runnerB }
}

/** bob's turn on A leases and the provider refreshes; A writes back. */
async function leaseStep(proof: Proof, runnerA: LabHost): Promise<LabClient> {
  const { ctx, tag } = proof
  ctx.step(`${tag} bob's turn on runner A leases his credential; the provider refreshes it; A writes it back`)
  const bobOnA = memberOn(proof, runnerA, 'bob')
  ctx.check(`${tag} bob reaches runner A`, (await bobOnA.connect()).ok)
  const seatsOnA = await expectOk(ctx, `${tag} runner A answers bob's seat from the cloud`, bobOnA.rpc('seatList'))
  ctx.check(`${tag} connected on the runner without any local connect`, seatsOnA?.find((seat) => seat.provider === 'claude-code')?.state === 'connected', JSON.stringify(seatsOnA))
  const first = await expectOk(ctx, `${tag} bob prompts on A with a refresh mid-turn`, prompt(bobOnA, ctx, 'bob-on-a', '__MOCK_REFRESH__ bob first turn'))
  ctx.check(`${tag} accepted`, first?.disposition === 'started', first?.disposition)
  const runA = await runOn(ctx, runnerA, 'bob first turn')
  const inOwnHome = runA?.seat?.userId === BOB_USER_ID && runA.seat.home === join(`${runnerA.dataDir}-seats`, 'claude', BOB_USER_ID)
  ctx.check(`${tag} the run on A carried bob's leased credential in bob's own seat directory`, inOwnHome && (runA?.credential?.includes('bob-access-1') ?? false), JSON.stringify({ seat: runA?.seat, credential: runA?.credential }))
  return bobOnA
}

/** bob's turn on B sees what A wrote back. */
async function refreshedStep(proof: Proof, runnerB: LabHost): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} bob's turn on runner B leases the refreshed version`)
  const bobOnB = memberOn(proof, runnerB, 'bob')
  ctx.check(`${tag} bob reaches runner B`, (await bobOnB.connect()).ok)
  const runB = await until(async () => {
    const started = await prompt(bobOnB, ctx, `bob-on-b-${Date.now()}`, 'bob second turn')
    if (started.disposition !== 'started') return undefined
    return runOn(ctx, runnerB, 'bob second turn')
  }, (row) => (row?.credential?.includes('refreshed-1') ?? false), 20_000)
  ctx.check(`${tag} the run on B saw the refreshed credential A wrote back`, runB?.credential?.includes('refreshed-1') ?? false, runB?.credential ?? 'no run')
}

/** cara on A: refused without a credential, then on her own, never bob's. */
async function otherUserStep(proof: Proof, runnerA: LabHost): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} cara on runner A: no credential, then her own, and never bob's`)
  const caraOnA = memberOn(proof, runnerA, 'cara')
  ctx.check(`${tag} cara reaches runner A`, (await caraOnA.connect()).ok)
  await expectRefused(ctx, `${tag} cara without a credential is refused`, prompt(caraOnA, ctx, 'cara-no-seat', 'cara without a seat'), 'SEAT_REQUIRED')
  const caraCloud = cloudClient(proof, 'cara')
  ctx.check(`${tag} cara reaches the service`, (await caraCloud.connect()).ok)
  await expectOk(ctx, `${tag} cara pastes a setup token on the service`, caraCloud.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-cara' }))
  const caraStarted = await expectOk(ctx, `${tag} cara prompts on A`, prompt(caraOnA, ctx, 'cara-seat', 'cara with her seat'))
  ctx.check(`${tag} accepted`, caraStarted?.disposition === 'started')
  const caraRun = await runOn(ctx, runnerA, 'cara with her seat')
  const ownToken = caraRun?.seat?.userId === CARA_USER_ID && caraRun.credential === 'token:lab-token-cara' && !caraRun.seat.home.includes(BOB_USER_ID)
  ctx.check(`${tag} cara's run carried her token in her own directory, not bob's material`, ownToken, JSON.stringify({ seat: caraRun?.seat, credential: caraRun?.credential }))
  ctx.check(`${tag} bob's credential file sits only in bob's directory on A`, existsSync(credentialFileOf(runnerA, BOB_USER_ID)) && !existsSync(credentialFileOf(runnerA, CARA_USER_ID)))
}

/** bob disconnects on the service; A refuses him and purges its copy. */
async function disconnectStep(proof: Proof, runnerA: LabHost, bobCloud: LabClient, bobOnA: LabClient): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} bob disconnects on the service; runner A refuses his next turn and purges its copy`)
  const disconnected = await expectOk(ctx, `${tag} bob disconnects`, bobCloud.rpc('seatDisconnect', { provider: 'claude-code' }))
  ctx.check(`${tag} the vault row is gone`, disconnected?.state === 'none')
  await expectRefused(ctx, `${tag} bob's next prompt on A is refused`, prompt(bobOnA, ctx, `bob-after-${Date.now()}`, 'bob after disconnect'), 'SEAT_REQUIRED')
  ctx.check(`${tag} runner A purged bob's credential file`, !existsSync(credentialFileOf(runnerA, BOB_USER_ID)))
}

async function proveVault(ctx: ScenarioContext, engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
  const service = await bootWorkspaceService({ issuer: ctx.issuer, engine, databaseUrl, vaultKey: randomBytes(32).toString('base64') })
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  const runners: LabHost[] = []
  try {
    const bobCloud = await connectStep(proof)
    const { runnerA, runnerB } = await bootRunnersStep(proof, runners)
    const bobOnA = await leaseStep(proof, runnerA)
    await refreshedStep(proof, runnerB)
    await otherUserStep(proof, runnerA)
    await disconnectStep(proof, runnerA, bobCloud, bobOnA)
  } finally {
    for (const client of proof.clients) client.close()
    for (const runner of runners) await runner.stop()
    ctx.issuer.setWorkspaceRoute(null)
    await service.stop()
  }
}

export default scenario('cloud vault: one login on the service, leased by every runner for its owner only', async (ctx) => {
  await proveVault(ctx, 'sqlite')
  const adminUrl = process.env.POSTGRES_ADMIN_URL
  if (!adminUrl) {
    ctx.step('POSTGRES_ADMIN_URL is not set: the Postgres run is skipped')
    return
  }
  const database = await createLabDatabase(adminUrl)
  try {
    await proveVault(ctx, 'postgres', database.url)
  } finally {
    await database.drop()
  }
}, { only: 'personal' })
