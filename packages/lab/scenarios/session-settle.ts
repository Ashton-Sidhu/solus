import { randomUUID } from 'node:crypto'
import type { IpcContext, SessionCtx, SessionRecord, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectOk, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi } from '../src/solus-api'

/**
 * Settle works wherever a person keeps sessions (docs/plans/session-archive.md).
 * Signed out: on the local machine (the loopback owner) and on a linked VM (a
 * paired device's session token). Signed in: on a connected VM (an account
 * grant through its tunnel) and on a cloud machine (a managed host that
 * members reach with grants), whose organization sessions also settle at the
 * organization's Solus API. Each settle is read back by a second client.
 */

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

function promptContext(ctx: ScenarioContext, sessionId: string, organizationId: string | null): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: organizationId ?? undefined }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

async function recordOn(client: LabClient, sessionId: string): Promise<SessionRecord | undefined> {
  const { records } = await client.records.sessionRecordList({ scope: 'all' })
  return records.find((record) => record.sessionId === sessionId)
}

/** The actor starts a session and waits for its record on `home`. */
async function startSession(ctx: ScenarioContext, tag: string, actor: LabClient, home: LabClient, organizationId: string | null): Promise<string> {
  const sessionId = randomUUID()
  await actor.rpc('watchSession', { sessionId })
  await expectOk(ctx, `${tag} a session starts`, actor.rpc('prompt', promptContext(ctx, sessionId, organizationId), { prompt: 'a turn to settle', clientPromptId: `${sessionId}-1` }))
  const record = await until(() => recordOn(home, sessionId), (found) => !!found, 15_000)
  ctx.check(`${tag} its home keeps the record`, !!record)
  return sessionId
}

/** The actor settles and unsettles; the reader hears each change and reads it back. */
async function proveSettle(ctx: ScenarioContext, tag: string, actor: LabClient, reader: LabClient, sessionId: string): Promise<void> {
  const settled = await expectOk(ctx, `${tag} settle`, actor.records.sessionUpdate(sessionId, { settled: true }))
  ctx.check(`${tag} the answer is settled by a person`, settled?.state.settledBy === 'person' && settled.state.settledAt != null, JSON.stringify(settled?.state))
  await expectOk(ctx, `${tag} the second client hears the settle`, reader.waitForEvent('session.stateChanged', (event) => event.payload.sessionId === sessionId && event.payload.state.settledAt != null))
  const read = await recordOn(reader, sessionId)
  ctx.check(`${tag} the second client reads it settled`, read?.state?.settledAt != null, JSON.stringify(read?.state))
  await expectOk(ctx, `${tag} unsettle`, actor.records.sessionUpdate(sessionId, { settled: false }))
  await expectOk(ctx, `${tag} the second client hears it active again`, reader.waitForEvent('session.stateChanged', (event) => event.payload.sessionId === sessionId && event.payload.state.settledAt == null))
  const after = await recordOn(reader, sessionId)
  ctx.check(`${tag} the second client reads it active`, after?.state?.settledAt == null, JSON.stringify(after?.state))
}

/** Signed out, on this machine: a loopback caller is the owner, with no credential at all. */
async function localMachine(ctx: ScenarioContext, clients: LabClient[]): Promise<LabHost> {
  const tag = '[signed out · local machine]'
  ctx.step(`${tag} the owner settles a session on a machine registered to no account`)
  const machine = await bootLabHost({ flavor: 'personal', unregistered: true })
  const local = () => {
    const client = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: machine.localUrl, hostId: machine.hostId, hostKind: 'personal', credentialFree: true, localOwnerToken: () => machine.localOwnerToken() })
    clients.push(client)
    return client
  }
  const window = local()
  const otherWindow = local()
  ctx.check(`${tag} a window reaches the machine with no credential`, (await window.connect()).ok)
  ctx.check(`${tag} a second window reaches it`, (await otherWindow.connect()).ok)
  const sessionId = await startSession(ctx, tag, window, window, null)
  await proveSettle(ctx, tag, window, otherWindow, sessionId)
  return machine
}

/** Signed out, a VM linked by pairing: each device holds its own paired session token. */
async function linkedVm(ctx: ScenarioContext, clients: LabClient[]): Promise<LabHost> {
  const tag = '[signed out · linked VM]'
  ctx.step(`${tag} a paired device settles a session; another paired device sees it`)
  const vm = await bootLabHost({ flavor: 'personal', unregistered: true })
  const paired = async () => {
    // The token `/pair` answers a device that brings the VM's code: the VM's own `auth session create`.
    const token = await vm.localOwnerToken()
    const client = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: vm.localUrl, hostId: vm.hostId, hostKind: 'personal', accessToken: async () => token })
    clients.push(client)
    return client
  }
  const laptop = await paired()
  const phone = await paired()
  const ticket = await laptop.fetchTicket()
  ctx.check(`${tag} the paired token buys a socket ticket`, 'ticket' in ticket, JSON.stringify(ticket))
  ctx.check(`${tag} the laptop dials with its ticket`, (await laptop.connect()).ok)
  ctx.check(`${tag} the phone dials with its ticket`, (await phone.connect()).ok)
  const sessionId = await startSession(ctx, tag, laptop, laptop, null)
  await proveSettle(ctx, tag, laptop, phone, sessionId)
  return vm
}

/** Signed in, a VM connected to the account: its owner comes through the tunnel with an account grant. */
async function connectedVm(ctx: ScenarioContext, clients: LabClient[]): Promise<LabHost> {
  const tag = '[signed in · connected VM]'
  ctx.step(`${tag} the owner settles a session from one device; her other device sees it`)
  const vm = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer })
  const owner = PERSONAS.alice
  const device = () => {
    const client = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: vm.tunnelUrl, issuer: ctx.issuer, hostId: vm.hostId, hostKind: 'personal', hostOwnerUserId: owner.kind === 'org-member' ? owner.userId : undefined })
    clients.push(client)
    return client
  }
  const desktop = device()
  const phone = device()
  ctx.check(`${tag} the desktop dials with an account grant`, (await desktop.connect()).ok)
  ctx.check(`${tag} the phone dials with an account grant`, (await phone.connect()).ok)
  const sessionId = await startSession(ctx, tag, desktop, desktop, null)
  await proveSettle(ctx, tag, desktop, phone, sessionId)
  return vm
}

/**
 * Signed in, a cloud machine of the organization: a member's session is
 * organization work. Settled on the machine, another member sees it there;
 * settled at the organization's Solus API, its home, they see it there too.
 */
async function cloudMachine(ctx: ScenarioContext, clients: LabClient[], stops: Array<() => Promise<void>>): Promise<void> {
  const tag = '[signed in · cloud machine]'
  ctx.step(`${tag} a member settles an organization session on a managed host; another member sees it`)
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine: 'sqlite' })
  const previousRoute = ctx.issuer.workspaceRoute
  ctx.issuer.setWorkspaceRoute(service.url)
  stops.push(async () => { ctx.issuer.setWorkspaceRoute(previousRoute); await service.stop() })
  const machine = await bootLabHost({ flavor: 'managed', issuer: ctx.issuer })
  stops.push(() => machine.stop())
  const member = (personaId: string, url: string, hostId: string, hostKind: 'managed' | 'cloud') => {
    const client = new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: url, issuer: ctx.issuer, hostId, hostKind })
    clients.push(client)
    return client
  }
  const alice = member('alice', machine.tunnelUrl, machine.hostId, 'managed')
  const bob = member('bob', machine.tunnelUrl, machine.hostId, 'managed')
  ctx.check(`${tag} alice dials the cloud machine with a member grant`, (await alice.connect()).ok)
  ctx.check(`${tag} bob dials it too`, (await bob.connect()).ok)
  // A managed host has no owner login: a member runs turns on their own seat (docs/plans/provider-seats.md).
  await expectOk(ctx, `${tag} alice connects her Claude seat`, alice.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' }))
  const sessionId = await startSession(ctx, tag, alice, bob, ORGANIZATION_ID)
  await proveSettle(ctx, `${tag} on the machine:`, alice, bob, sessionId)

  ctx.step(`${tag} the same session settles at the organization's Solus API`)
  const aliceApi = member('alice', service.url, SOLUS_API_AUDIENCE, 'cloud')
  const bobApi = member('bob', service.url, SOLUS_API_AUDIENCE, 'cloud')
  ctx.check(`${tag} alice reaches the Solus API`, (await aliceApi.connect()).ok)
  ctx.check(`${tag} bob reaches the Solus API`, (await bobApi.connect()).ok)
  const reported = await until(() => recordOn(bobApi, sessionId), (found) => !!found, 15_000)
  ctx.check(`${tag} the cloud machine reported the session to the Solus API`, !!reported)
  if (reported) await proveSettle(ctx, `${tag} at the Solus API:`, aliceApi, bobApi, sessionId)
}

export default scenario('session settle: signed out on the local machine and a linked VM; signed in on a connected VM and a cloud machine', async (ctx) => {
  const clients: LabClient[] = []
  const hosts: LabHost[] = []
  const stops: Array<() => Promise<void>> = []
  try {
    hosts.push(await localMachine(ctx, clients))
    hosts.push(await linkedVm(ctx, clients))
    hosts.push(await connectedVm(ctx, clients))
    await cloudMachine(ctx, clients, stops)
  } finally {
    for (const client of clients) client.close()
    for (const host of hosts) await host.stop()
    for (const stop of stops.reverse()) await stop()
  }
}, { only: 'personal' })
