import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { recordedRuns, type RecordedRun } from '../src/oracle'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectNotServed, expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi, createLabDatabase, type SolusApiEngine, type LabSolusApi } from '../src/solus-api'

/** Host auth exit: the Solus API refuses seats; two cloud machines keep independent logins and disconnects. */

const RUNNER_A = 'labrunnerauthaaaa'
const RUNNER_B = 'labrunnerauthbbbb'

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
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
  service: LabSolusApi
  clients: LabClient[]
}

function cloudClient(proof: Proof, personaId: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'api'), hostUrl: proof.service.url, issuer: proof.ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'api' })
  proof.clients.push(client)
  return client
}

/** A member on a cloud machine, through its proxied listener with a member grant for it. Nobody owns the machine. */
function memberOn(proof: Proof, runner: LabHost, personaId: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'cloud'), hostUrl: runner.tunnelUrl, issuer: proof.ctx.issuer, hostId: runner.hostId, hostKind: 'cloud' })
  proof.clients.push(client)
  return client
}

async function bootRunnersStep(proof: Proof, runners: LabHost[]): Promise<{ runnerA: LabHost; runnerB: LabHost }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} two cloud machines of the organization come up`)
  const runnerA = await bootLabHost({ flavor: 'cloud', issuer: ctx.issuer, hostId: RUNNER_A, operatedFor: ORGANIZATION_ID })
  runners.push(runnerA)
  const runnerB = await bootLabHost({ flavor: 'cloud', issuer: ctx.issuer, hostId: RUNNER_B, operatedFor: ORGANIZATION_ID })
  runners.push(runnerB)
  return { runnerA, runnerB }
}

async function proveHostAuth(ctx: ScenarioContext, engine: SolusApiEngine, databaseUrl?: string): Promise<void> {
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine, databaseUrl })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  const runners: LabHost[] = []
  try {
    const cloud = cloudClient(proof, 'bob')
    ctx.check(`${engine}: member connects to service`, (await cloud.connect()).ok)
    await expectNotServed(ctx, 'service cannot store Claude credentials', cloud.rpc('seatConnectToken', { provider: 'claude-code', token: 'mock-only' }))
    await expectNotServed(ctx, 'service cannot start Codex login', cloud.rpc('seatConnectStart', { provider: 'codex' }))
    const { runnerA, runnerB } = await bootRunnersStep(proof, runners)
    const a = memberOn(proof, runnerA, 'bob')
    const b = memberOn(proof, runnerB, 'bob')
    ctx.check('member connects to A', (await a.connect()).ok)
    ctx.check('member connects to B', (await b.connect()).ok)
    const admitted = await a.rpc('connectionsGetServerInfo')
    ctx.check('A admits him as a member of a cloud machine', admitted.hostKind === 'cloud' && admitted.principal === 'org-member', JSON.stringify({ hostKind: admitted.hostKind, principal: admitted.principal }))
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
    ctx.issuer.setWorkspaceRoute(previousRoute)
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
