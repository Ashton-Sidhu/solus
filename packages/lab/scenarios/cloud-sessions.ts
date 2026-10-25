import { recordedRuns, seatOfRun } from '../src/oracle'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectNotServed, expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi, createLabDatabase, type SolusApiEngine, type LabSolusApi } from '../src/solus-api'

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

/**
 * How many times the runner traded a person's token for a delegation in the organization,
 * from its own log (plans/010-standard-oauth.md). The owner's personal delegation, which
 * the same door makes (ADR 0001 stage 4), is not organization work.
 */
function delegationsHeld(runner: LabHost): number {
  const logFile = join(runner.dataDir, 'dev.log')
  if (!existsSync(logFile)) return 0
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('"msg":"delegation_held"') && line.includes(`"scope":"organization:${ORGANIZATION_ID}"`)).length
}

/**
 * The renderer's prompt context for the session in the Lab's working directory. The
 * session id names the session; the host finds its provider thread from its record
 * (docs/plans/session-identity.md). The window has the organization selected: on a
 * machine attached for organization work a new root needs one (plans/009-organization-vms.md §1).
 */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
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
  service: LabSolusApi
  clients: LabClient[]
}

function cloudClient(proof: Proof, personaId: string, shareSecret?: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: proof.service.url, issuer: proof.ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', shareSecret })
  proof.clients.push(client)
  return client
}

/** The owner through the runner's proxied listener with her access token: the token the runner trades for a delegation. */
async function ownerClient(proof: Proof, runner: LabHost): Promise<LabClient> {
  const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.tunnelUrl, issuer: proof.ctx.issuer, hostId: runner.hostId, hostKind: 'personal', organizationId: ORGANIZATION_ID })
  proof.clients.push(owner)
  proof.ctx.check(`${proof.tag} the owner reaches the runner`, (await owner.connect()).ok)
  return owner
}

function bootRunner(ctx: ScenarioContext, dataDir?: string): Promise<LabHost> {
  return bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID, dataDir })
}

async function transcriptOn(client: LabClient, sessionId: string): Promise<WireSessionLoadMessage[]> {
  const page = await client.rpc('loadSessionPage', { sessionId, provider: 'claude-code', turnLimit: 100 })
  return page.messages
}

const rowsOf = (rows: WireSessionLoadMessage[]) => JSON.stringify(rows.map((row) => `${row.role}:${row.content}`))
const isAnswer = (row: WireSessionLoadMessage) => row.role === 'assistant' && row.content.toLowerCase().includes('mock response')

/** The runner streams a slow turn; the service holds its rows before the turn is over. */
async function streamStep(proof: Proof): Promise<{ runner: LabHost; owner: LabClient; alice: LabClient; sessionId: string }> {
  const { ctx, tag } = proof
  ctx.step(`${tag} a runner of the organization starts a slow turn; its rows reach the service as it streams`)
  const runner = await bootRunner(ctx)
  const owner = await ownerClient(proof, runner)
  // Only a session admitted to the organization mirrors to its Solus API (plans/009-organization-vms.md
  // §9): the owner starts it from a window with the organization selected.
  const sessionId = randomUUID()
  await expectOk(ctx, `${tag} the owner starts the slow turn`, prompt(owner, ctx, sessionId, FIRST_PROMPT))
  // The ticket door makes the delegation without waiting (ADR 0001 stage 4).
  const held = await until(async () => delegationsHeld(runner), (count) => count > 0, 10_000)
  ctx.check(`${tag} the runner traded alice's token for one delegation`, held === 1, String(held))
  const alice = cloudClient(proof, 'alice')
  ctx.check(`${tag} alice reaches the service`, (await alice.connect()).ok)
  const streamed = await until(() => transcriptOn(alice, sessionId), (rows) => rows.some((row) => row.role === 'assistant'), 15_000)
  ctx.check(`${tag} the service holds the user row and at least one assistant row before the turn is over`, streamed.some((row) => row.role === 'user' && row.content.includes('first turn')) && streamed.some((row) => row.role === 'assistant'), rowsOf(streamed))
  return { runner, owner, alice, sessionId }
}

/** The runner dies mid-turn; what it mirrored stays readable and the session stays listed. */
async function killStep(proof: Proof, runner: LabHost, alice: LabClient, sessionId: string): Promise<void> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner is killed mid-turn`)
  await runner.stop({ kill: true })
  const afterKill = await transcriptOn(alice, sessionId)
  ctx.check(`${tag} the transcript mirrored so far is readable with the runner dead`, afterKill.length >= 2 && afterKill.length < 10, `${afterKill.length} rows`)
  const records = await expectOk(ctx, `${tag} alice lists session records`, alice.records.sessionRecordList({}).then((list) => list.records))
  ctx.check(`${tag} the session is listed while the runner is off, naming the runner`, records?.some((record) => record.sessionId === sessionId && record.runnerHostId === RUNNER_HOST_ID) === true)
  const infos = await expectOk(ctx, `${tag} the service describes the session from its record`, alice.rpc('getSessionInfos', [sessionId]))
  ctx.check(`${tag} the description is not null`, !!infos?.[0], JSON.stringify(infos))
}

/** The runner comes back on its data directory; its owner prompts it again, and the new turn reaches the cloud. */
async function restartStep(proof: Proof, dataDir: string, alice: LabClient, sessionId: string): Promise<LabHost> {
  const { ctx, tag } = proof
  ctx.step(`${tag} the runner restarts on its data directory and the owner prompts it again`)
  const runner = await bootRunner(ctx, dataDir)
  const owner = await ownerClient(proof, runner)
  await expectOk(ctx, `${tag} the owner prompts the session on the runner`, prompt(owner, ctx, sessionId, SECOND_PROMPT))
  // The record of whom it acts for survived the restart: no second exchange.
  ctx.check(`${tag} the restarted runner still acts for alice without a new exchange`, delegationsHeld(runner) === 0, String(delegationsHeld(runner)))
  const grown = await until(() => transcriptOn(alice, sessionId), (rows) => rows.some((row) => row.content.includes(SECOND_PROMPT)) && rows.some(isAnswer), 20_000)
  ctx.check(`${tag} the new turn's rows reached the service`, grown.some((row) => row.role === 'user' && row.content.includes(SECOND_PROMPT)) && grown.some(isAnswer), rowsOf(grown))
  const settled = await until(() => alice.records.sessionRecordList({}).then((list) => list.records), (rows) => rows.find((row) => row.sessionId === sessionId)?.status === 'idle', 20_000)
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

async function proveSessions(ctx: ScenarioContext, engine: SolusApiEngine, databaseUrl?: string): Promise<void> {
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine, databaseUrl })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: Proof = { ctx, tag: `[${engine}]`, service, clients: [] }
  let runner: LabHost | null = null
  try {
    const started = await streamStep(proof)
    runner = started.runner
    const resource = { kind: 'session' as const, id: started.sessionId }
    // The host that runs a session owns its share rows and makes its link; the rows go up
    // to the Solus API with the transcript (docs/plans/host-sharing.md §4.2 step 1, §9.10).
    const link = await expectOk(ctx, `${engine}: the owner makes an editor link on the runner`, started.owner.rpc('shareSetLink', { resource, role: 'editor' }))
    const secret = link?.secret ?? ''
    // The mirror admits the guest from its copy of the rows once they arrive (§4.2 step 6).
    let guest = cloudClient(proof, 'maya', secret)
    const mirrored = await until(async () => (await guest.connect()).ok || ((guest = cloudClient(proof, 'maya', secret)), false), (ok) => ok, 15_000)
    ctx.check(`${engine}: the link's rows reach the Solus API with the transcript`, mirrored)
    await killStep(proof, runner, started.alice, started.sessionId)
    ctx.check(`${engine}: guest stays on the mirror with runner stopped`, guest.connected)
    ctx.check(`${engine}: guest reads mirrored history`, (await transcriptOn(guest, started.sessionId)).length > 0)
    // The mirror is read only: the shared-prompt relay is gone (§7), and the Solus API serves no execution.
    await expectNotServed(ctx, `${engine}: offline guest prompt is not accepted`, guest.rpc('promptHeadlessSession', { sessionId: started.sessionId, prompt: 'must not run offline', delivery: 'queue', promptId: 'lab-offline' }))
    runner = await restartStep(proof, runner.dataDir, started.alice, started.sessionId)
    // The runner sends the same rows up again; only a regenerated or removed link ends the
    // mirror's guests (docs/plans/host-sharing.md §4.2 step 6).
    ctx.check(`${engine}: guest stays on the mirror while the link is unchanged`, guest.connected)
    // A live guest dials the host that runs the session with the secret alone (§4.1 step 4, §4.2 step 5).
    const liveGuest = new LabClient({ persona: personaForHost('maya', 'personal'), hostUrl: runner.tunnelUrl, hostId: runner.hostId, hostKind: 'personal', shareSecret: secret })
    proof.clients.push(liveGuest)
    ctx.check(`${engine}: guest dials the runner once it is back`, (await liveGuest.connect()).ok)
    const sent = await expectOk(ctx, `${engine}: runner accepts guest prompt`, liveGuest.rpc('promptHeadlessSession', { sessionId: started.sessionId, prompt: 'P4 guest prompt', delivery: 'queue', promptId: 'lab-guest-prompt' }))
    ctx.check(`${engine}: runner acknowledges guest prompt`, !!sent, JSON.stringify(sent))
    const run = await until(async () => recordedRuns({ ...ctx, host: runner! }).find((item) => item.prompt.includes('P4 guest prompt')), (item) => !!item, 15_000)
    // A guest runs on the seat of whoever shared the link: the owner made it on her machine,
    // so that is the host login (plans/012-user-actor-and-activity.md; admission/actor.ts seatFor).
    ctx.check(`${engine}: guest runs on sharer seat`, !!run && seatOfRun(run) === 'host-login', run ? String(seatOfRun(run)) : 'no run')
    ctx.check(`${engine}: guest uses the host-local sharer login`, !!run?.seat?.home.startsWith(runner.dataDir) && !run.seat.home.includes('-seats/'), run?.seat?.home)
    // A guest page whose mirror socket ended dials again with the same secret.
    const reader = guest.connected ? guest : cloudClient(proof, 'maya', secret)
    if (!reader.connected) ctx.check(`${engine}: guest dials the mirror again`, (await reader.connect()).ok)
    const transcript = await until(() => transcriptOn(reader, started.sessionId), (rows) => rows.some((row) => row.content.includes('P4 guest prompt')), 15_000)
    ctx.check(`${engine}: guest prompt reaches cloud transcript`, transcript.some((row) => row.content.includes('P4 guest prompt')))
    const owner = await ownerClient(proof, runner)
    await owner.rpc('shareSetLink', { resource, role: 'viewer' })
    await expectRefused(ctx, 'downgraded guest cannot prompt', liveGuest.rpc('promptHeadlessSession', { sessionId: started.sessionId, prompt: 'must not run as viewer', delivery: 'queue', promptId: 'lab-viewer-prompt' }))

    await memberStep(proof, started.alice, started.sessionId)
  } finally {
    for (const client of proof.clients) client.close()
    await runner?.stop()
    ctx.issuer.setWorkspaceRoute(previousRoute)
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
