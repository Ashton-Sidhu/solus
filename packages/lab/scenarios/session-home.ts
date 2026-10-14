import { randomUUID } from 'node:crypto'
import type { IpcContext, SessionCtx, SessionRecord, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi } from '../src/solus-api'

/**
 * A session's home keeps its place in each person's list (docs/plans/session-archive.md):
 * the shared settle, each person's own archive and snooze, and its pull requests, as
 * `/v1` resources. An organization session's home is its Solus API; a personal
 * session's home is its machine. A runner tells the home about each prompt and each
 * pull request its agent links.
 */

const RUNNER_HOST_ID = 'labrunnersessionhome'
const MANUAL_PR = 'https://github.com/lab/solus/pull/9'
const AGENT_PR = 'https://github.com/lab/solus/pull/7'
const SHORT_WAIT_MS = 1_500

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

/** The renderer's prompt context for a session in the Lab's working directory; an
 *  organization session names its organization (plans/009-organization-vms.md §1). */
function promptContext(ctx: ScenarioContext, sessionId: string, organizationId: string | null): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: organizationId ?? undefined }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string, organizationId: string | null) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId, organizationId), { prompt: text, clientPromptId: `${sessionId}-${randomUUID()}` })
}

/** One session as a person's list shows it, or undefined when it is not in the list. */
async function listed(client: LabClient, sessionId: string): Promise<SessionRecord | undefined> {
  const { records } = await client.records.sessionRecordList()
  return records.find((record) => record.sessionId === sessionId)
}

/** One session as the full list shows it, archived or not. */
async function anyListing(client: LabClient, sessionId: string): Promise<SessionRecord | undefined> {
  const { records } = await client.records.sessionRecordList({ scope: 'all' })
  return records.find((record) => record.sessionId === sessionId)
}

const urlsOf = (links: Array<{ url: string }> | undefined) => JSON.stringify((links ?? []).map((link) => link.url))

/** The pull request resource: PUT links, GET reads, DELETE removes, seen by `reader`. */
async function pullRequestResource(ctx: ScenarioContext, tag: string, writer: LabClient, reader: LabClient, sessionId: string): Promise<void> {
  ctx.step(`${tag} the pull request resource: PUT, GET, DELETE`)
  await expectOk(ctx, `${tag} PUT links the pull request`, writer.records.sessionPullRequestPut(sessionId, MANUAL_PR))
  await expectOk(ctx, `${tag} PUT again is idempotent`, writer.records.sessionPullRequestPut(sessionId, MANUAL_PR))
  const read = await expectOk(ctx, `${tag} GET reads the links`, reader.records.sessionPullRequests(sessionId))
  ctx.check(`${tag} the link is there once, as a manual link`, read?.filter((link) => link.url === MANUAL_PR).length === 1 && read.find((link) => link.url === MANUAL_PR)?.source === 'manual', JSON.stringify(read))
  const inList = await anyListing(reader, sessionId)
  ctx.check(`${tag} the list carries the session's pull requests`, inList?.pullRequests?.some((link) => link.url === MANUAL_PR) === true, urlsOf(inList?.pullRequests))
  await expectOk(ctx, `${tag} DELETE removes the link`, writer.records.sessionPullRequestDelete(sessionId, { repository: 'github.com/lab/solus', number: 9 }))
  const after = await expectOk(ctx, `${tag} GET reads the links again`, reader.records.sessionPullRequests(sessionId))
  ctx.check(`${tag} the removed link is gone`, after?.every((link) => link.url !== MANUAL_PR) === true, urlsOf(after))
}

/** The personal home: a machine keeps its own sessions' list state. */
async function personalHome(ctx: ScenarioContext): Promise<void> {
  // The Lab's shared host is attached for organization work, where every new root
  // needs an organization: a personal session needs a machine of its own.
  const machine = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer })
  const owner = PERSONAS.alice
  const alice = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: machine.tunnelUrl, issuer: ctx.issuer, hostId: machine.hostId, hostKind: 'personal', hostOwnerUserId: owner.kind === 'org-member' ? owner.userId : undefined })
  try {
    await provePersonalHome(ctx, alice)
  } finally {
    alice.close()
    await machine.stop()
  }
}

async function provePersonalHome(ctx: ScenarioContext, alice: LabClient): Promise<void> {
  const tag = '[machine]'
  ctx.step(`${tag} alice starts a personal session on her machine`)
  ctx.check(`${tag} alice reaches her machine`, (await alice.connect()).ok)
  const sessionId = randomUUID()
  await expectOk(ctx, `${tag} alice prompts a personal session`, prompt(alice, ctx, sessionId, 'a personal turn', null))
  const first = await until(() => listed(alice, sessionId), (record) => !!record, 15_000)
  ctx.check(`${tag} the list answers the session with listed, state, view, and pull requests`, first?.listed === true && first.state?.settledAt == null && first.view?.archivedAt == null && Array.isArray(first.pullRequests), JSON.stringify({ listed: first?.listed, state: first?.state, view: first?.view, pullRequests: first?.pullRequests }))

  await archivePersonal(ctx, alice, sessionId)
}

/** An archive takes the session out of her list, and a prompt brings it back. */
async function archivePersonal(ctx: ScenarioContext, alice: LabClient, sessionId: string): Promise<void> {
  const tag = '[machine]'
  ctx.step(`${tag} alice archives it: it leaves her list, and the full list still has it`)
  const place = await expectOk(ctx, `${tag} PATCH /sessions archives`, alice.records.sessionUpdate(sessionId, { archived: true }))
  ctx.check(`${tag} the answer is the archived view`, place?.view.archivedAt != null, JSON.stringify(place))
  await expectOk(ctx, `${tag} alice hears her view change`, alice.waitForEvent('session.viewChanged', (event) => event.payload.sessionId === sessionId && event.payload.view.archivedAt != null))
  ctx.check(`${tag} the session left her list`, !(await listed(alice, sessionId)))
  const full = await anyListing(alice, sessionId)
  ctx.check(`${tag} the full list still has it, marked not listed`, full?.listed === false && full.view?.archivedAt != null, JSON.stringify({ listed: full?.listed, view: full?.view }))

  ctx.step(`${tag} a new prompt returns it to her list`)
  await expectOk(ctx, `${tag} alice prompts the archived session`, prompt(alice, ctx, sessionId, 'back to work', null))
  const back = await until(() => listed(alice, sessionId), (record) => !!record, 15_000)
  ctx.check(`${tag} the prompt returned the session to her list`, back?.view?.archivedAt == null && back?.listed === true, JSON.stringify(back?.view))
  await shelvePersonal(ctx, alice, sessionId)
}

/** Settle, snooze, and the pull request resource on the machine. */
async function shelvePersonal(ctx: ScenarioContext, alice: LabClient, sessionId: string): Promise<void> {
  const tag = '[machine]'
  ctx.step(`${tag} settle, snooze, and the pull request resource`)
  const settled = await expectOk(ctx, `${tag} PATCH /sessions settles`, alice.records.sessionUpdate(sessionId, { settled: true }))
  ctx.check(`${tag} the answer is the settled state`, settled?.state.settledAt != null, JSON.stringify(settled))
  await expectOk(ctx, `${tag} alice hears the state change`, alice.waitForEvent('session.stateChanged', (event) => event.payload.sessionId === sessionId && event.payload.state.settledAt != null))
  const wake = Date.now() + 3_600_000
  const snoozed = await expectOk(ctx, `${tag} PATCH /sessions snoozes`, alice.records.sessionUpdate(sessionId, { snoozedUntil: wake, snoozeNote: 'later' }))
  ctx.check(`${tag} the answer is the snoozed view, with the settle kept`, snoozed?.view.snoozedUntil === wake && snoozed.view.snoozeNote === 'later' && snoozed.state.settledAt != null, JSON.stringify(snoozed))
  const shelved = await listed(alice, sessionId)
  ctx.check(`${tag} a snoozed, settled session stays in the list with its state`, shelved?.state?.settledAt != null && shelved.view?.snoozedUntil === wake, JSON.stringify({ state: shelved?.state, view: shelved?.view }))
  await pullRequestResource(ctx, tag, alice, alice, sessionId)
}

interface OrganizationProof {
  ctx: ScenarioContext
  clients: LabClient[]
}

function serviceClient(proof: OrganizationProof, url: string, personaId: string): LabClient {
  const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: url, issuer: proof.ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud' })
  proof.clients.push(client)
  return client
}

/** Per-person views and the shared settle, seen from the other member's side. */
async function peopleStep(proof: OrganizationProof, alice: LabClient, bob: LabClient, sessionId: string): Promise<number> {
  const { ctx } = proof
  const tag = '[solus api]'
  ctx.step(`${tag} alice archives the session: it leaves her list, and bob's view does not change`)
  await expectOk(ctx, `${tag} alice archives it`, alice.records.sessionUpdate(sessionId, { archived: true }))
  await expectOk(ctx, `${tag} alice hears her view change`, alice.waitForEvent('session.viewChanged', (event) => event.payload.sessionId === sessionId && event.payload.view.archivedAt != null))
  ctx.check(`${tag} the session left alice's list`, !(await listed(alice, sessionId)))
  const bobSees = await anyListing(bob, sessionId)
  ctx.check(`${tag} bob still reads it, with his own empty view`, !!bobSees && bobSees.view?.archivedAt == null, JSON.stringify(bobSees?.view))

  ctx.step(`${tag} bob snoozes it: it joins his list, and alice's view does not change`)
  const wake = Date.now() + 3_600_000
  await expectOk(ctx, `${tag} bob snoozes it`, bob.records.sessionUpdate(sessionId, { snoozedUntil: wake, snoozeNote: 'after lunch' }))
  ctx.check(`${tag} the session he acted on is in bob's list now`, (await listed(bob, sessionId))?.view?.snoozedUntil === wake)
  const aliceView = (await anyListing(alice, sessionId))?.view
  ctx.check(`${tag} alice's view has no snooze`, aliceView?.snoozedUntil == null && aliceView?.archivedAt != null, JSON.stringify(aliceView))

  ctx.step(`${tag} alice settles it: bob sees one shared settle`)
  await expectOk(ctx, `${tag} alice settles it`, alice.records.sessionUpdate(sessionId, { settled: true }))
  await expectOk(ctx, `${tag} bob hears the state change`, bob.waitForEvent('session.stateChanged', (event) => event.payload.sessionId === sessionId && event.payload.state.settledAt != null))
  const bobState = (await anyListing(bob, sessionId))?.state
  ctx.check(`${tag} bob reads the settle`, bobState?.settledAt != null, JSON.stringify(bobState))
  // The settle came after both view changes on the same sockets: each person heard only their own view.
  ctx.check(`${tag} bob never heard alice's view change`, bob.received('session.viewChanged').every((event) => event.payload.view.archivedAt == null), JSON.stringify(bob.received('session.viewChanged')))
  await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS))
  ctx.check(`${tag} alice never heard bob's snooze`, alice.received('session.viewChanged').every((event) => event.payload.view.snoozedUntil == null), JSON.stringify(alice.received('session.viewChanged')))
  await expectOk(ctx, `${tag} alice unsettles it`, alice.records.sessionUpdate(sessionId, { settled: false }))
  return wake
}

/** The runner tells the home: a prompt returns the session to its person's list, and an agent's link arrives. */
async function runnerStep(proof: OrganizationProof, owner: LabClient, alice: LabClient, bob: LabClient, sessionId: string, bobWake: number): Promise<void> {
  const { ctx } = proof
  const tag = '[solus api]'
  ctx.step(`${tag} alice prompts on the runner; its agent links a pull request`)
  const call = JSON.stringify({ name: 'link', input: { kind: 'pr', target_id: AGENT_PR } })
  await expectOk(ctx, `${tag} the owner prompts the archived session on the runner`, prompt(owner, ctx, sessionId, `__MOCK_TOOL__ ${call}`, ORGANIZATION_ID))
  const back = await until(() => listed(alice, sessionId), (record) => !!record, 15_000)
  ctx.check(`${tag} the turn reached the home and returned the session to alice's list`, back?.listed === true && back.view?.archivedAt == null, JSON.stringify(back?.view))
  const bobView = (await listed(bob, sessionId))?.view
  ctx.check(`${tag} alice's prompt left bob's snooze as it was`, bobView?.snoozedUntil === bobWake, JSON.stringify(bobView))
  const links = await until(() => bob.records.sessionPullRequests(sessionId), (rows) => rows.some((row) => row.url === AGENT_PR), 15_000)
  ctx.check(`${tag} the agent's link reached the Solus API through the outbox, as an agent link`, links.find((row) => row.url === AGENT_PR)?.source === 'agent', JSON.stringify(links))

  ctx.step(`${tag} only a host acting for a person may report a turn`)
  await expectRefused(ctx, `${tag} alice cannot post a turn with her own token`, alice.api.request('admitSessionTurn', { id: sessionId, body: {} }))
}

/** The organization home: the Solus API keeps the list state while runners rotate. */
async function organizationHome(ctx: ScenarioContext): Promise<void> {
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine: 'sqlite' })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  const proof: OrganizationProof = { ctx, clients: [] }
  let runner: LabHost | null = null
  try {
    const tag = '[solus api]'
    ctx.step(`${tag} alice starts an organization session on a runner`)
    runner = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID })
    const owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.tunnelUrl, issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'personal', organizationId: ORGANIZATION_ID })
    proof.clients.push(owner)
    ctx.check(`${tag} the owner reaches the runner`, (await owner.connect()).ok)
    const sessionId = randomUUID()
    await expectOk(ctx, `${tag} the owner starts the session`, prompt(owner, ctx, sessionId, 'an organization turn', ORGANIZATION_ID))
    const alice = serviceClient(proof, service.url, 'alice')
    const bob = serviceClient(proof, service.url, 'bob')
    ctx.check(`${tag} alice reaches the Solus API`, (await alice.connect()).ok)
    ctx.check(`${tag} bob reaches the Solus API`, (await bob.connect()).ok)
    const first = await until(() => listed(alice, sessionId), (record) => !!record, 15_000)
    ctx.check(`${tag} the API lists the session for its owner with listed, state, view, and pull requests`, first?.listed === true && first.state !== undefined && first.view !== undefined && Array.isArray(first.pullRequests), JSON.stringify({ listed: first?.listed, state: first?.state, view: first?.view, pullRequests: first?.pullRequests }))

    // Bob can read every session of the organization; his list holds his own.
    const bobReads = await anyListing(bob, sessionId)
    ctx.check(`${tag} bob reads alice's session, and it is not in his list`, bobReads?.listed === false && !(await listed(bob, sessionId)), JSON.stringify({ listed: bobReads?.listed, ownerUserId: bobReads?.ownerUserId }))

    const bobWake = await peopleStep(proof, alice, bob, sessionId)
    await pullRequestResource(ctx, tag, bob, alice, sessionId)
    await runnerStep(proof, owner, alice, bob, sessionId, bobWake)
  } finally {
    for (const client of proof.clients) client.close()
    await runner?.stop()
    ctx.issuer.setWorkspaceRoute(previousRoute)
    await service.stop()
  }
}

export default scenario('session home: list state and pull requests on the machine and on the Solus API', async (ctx) => {
  await personalHome(ctx)
  await organizationHome(ctx)
}, { only: 'personal' })
