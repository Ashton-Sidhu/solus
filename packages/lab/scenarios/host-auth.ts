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

/** Host auth exit: cloud refuses seats; two hosts keep independent logins and disconnects. */

const RUNNER_A = 'labrunnerauthaaaa'
const RUNNER_B = 'labrunnerauthbbbb'
const ALICE_USER_ID = PERSONAS.alice.userId

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
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'auto', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null }
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

async function proveHostAuth(ctx: ScenarioContext, engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
  const service = await bootWorkspaceService({ issuer: ctx.issuer, engine, databaseUrl })
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  const runners: LabHost[] = []
  try {
    const cloud = cloudClient(proof, 'bob')
    ctx.check(`${engine}: member connects to service`, (await cloud.connect()).ok)
    await expectRefused(ctx, 'service cannot store Claude credentials', cloud.rpc('seatConnectToken', { provider: 'claude-code', token: 'mock-only' }), 'PLANE_DISABLED')
    await expectRefused(ctx, 'service cannot start Codex login', cloud.rpc('seatConnectStart', { provider: 'codex' }), 'PLANE_DISABLED')
    const { runnerA, runnerB } = await bootRunnersStep(proof, runners)
    const a = memberOn(proof, runnerA, 'bob')
    const b = memberOn(proof, runnerB, 'bob')
    ctx.check('member connects to A', (await a.connect()).ok)
    ctx.check('member connects to B', (await b.connect()).ok)
    await expectRefused(ctx, 'no host login means no turn', prompt(a, ctx, 'no-seat', 'no seat'), 'SEAT_REQUIRED')
    await expectOk(ctx, 'connect Claude on A', a.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-a' }))
    ctx.check('B still has no Claude login', (await b.rpc('seatList')).find((seat) => seat.provider === 'claude-code')?.state === 'none')
    await expectRefused(ctx, 'B cannot use A login', prompt(b, ctx, 'b-no-seat', 'no B seat'), 'SEAT_REQUIRED')
    await expectOk(ctx, 'connect Claude on B', b.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-b' }))
    await expectOk(ctx, 'turn on A', prompt(a, ctx, 'a-seat', 'A local login'))
    await expectOk(ctx, 'turn on B', prompt(b, ctx, 'b-seat', 'B local login'))
    ctx.check('A uses A token', (await runOn(ctx, runnerA, 'A local login'))?.seat?.envToken === 'lab-token-a')
    ctx.check('B uses B token', (await runOn(ctx, runnerB, 'B local login'))?.seat?.envToken === 'lab-token-b')
    await a.rpc('seatDisconnect', { provider: 'claude-code' })
    await expectRefused(ctx, 'disconnected A refuses another turn', prompt(a, ctx, 'a-disconnected', 'after disconnect'), 'SEAT_REQUIRED')
    ctx.check('disconnect on A leaves B connected', (await b.rpc('seatList')).find((seat) => seat.provider === 'claude-code')?.state === 'connected')
    const cara = memberOn(proof, runnerB, 'cara')
    ctx.check('other member connects', (await cara.connect()).ok)
    await expectRefused(ctx, 'other member cannot use Bob login', prompt(cara, ctx, 'cara-no-seat', 'other member'), 'SEAT_REQUIRED')
    const codexAuth = JSON.stringify({ tokens: { access_token: 'mock-access', refresh_token: 'mock-refresh', id_token: 'mock-id' } })
    await expectOk(ctx, 'connect Codex on A', a.rpc('seatConnectToken', { provider: 'codex', token: codexAuth }))
    ctx.check('Codex login stays on A', (await a.rpc('seatList')).find((seat) => seat.provider === 'codex')?.state === 'connected' && (await b.rpc('seatList')).find((seat) => seat.provider === 'codex')?.state === 'none')
    const retired = await fetch(`${service.url}/runner/credentials/lease`, { method: 'POST', body: '{}' })
    ctx.check('old credential lease route is gone', retired.status === 404)
  } finally {
    for (const client of proof.clients) client.close()
    for (const runner of runners) await runner.stop()
    ctx.issuer.setWorkspaceRoute(null)
    await service.stop()
  }
}

export default scenario('host provider auth: credentials stay on each execution host', async (ctx) => {
  await proveHostAuth(ctx, 'sqlite')
  const adminUrl = process.env.POSTGRES_ADMIN_URL
  if (!adminUrl) {
    ctx.step('POSTGRES_ADMIN_URL is not set: the Postgres run is skipped')
    return
  }
  const database = await createLabDatabase(adminUrl)
  try {
    await proveHostAuth(ctx, 'postgres', database.url)
  } finally {
    await database.drop()
  }
}, { only: 'personal' })
