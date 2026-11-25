import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { LabClient, LabRpcError } from '../../src/client'
import { cloudModeScenario, type CloudScenarioContext } from '../../src/cloud-mode'
import { removeHost } from '../../src/cloud-fixtures'
import { hostClient, localOwnerClient, registerHost, type SignedIn } from '../../src/cloud-sign-in'

/**
 * Organization work against the real cloud (plans/034-one-cloud-machine-kind.md §2, §3;
 * plans/009-organization-vms.md §4, §5; docs/plans/cloud-service-model.md §16): an
 * operator starts a new server with an organization link code that alice, a member,
 * made, and with the machine's own address. The registration names her organization,
 * so the server is a cloud machine: nobody owns it, and it trusts nobody by position.
 * alice dials it as a member; the ticket door trades her host token for an
 * organization delegation. Her new session is admitted on the Solus API before the
 * mock agent starts, and the agent's real `create_work` tool writes through that
 * delegation to the Solus API, not to the machine's own tables. A window that selected
 * another organization starts nothing there. bob, a member, reads the work and the
 * session record on the Solus API with his own API token; carol, of another
 * organization, reads none of it and cannot name the organization.
 */

const WORK_TITLE = 'Runner work from the mock agent'

/** The renderer's prompt context for a new conversation whose window selected an organization. */
function promptContext(sessionId: string, cwd: string, organizationId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: cwd, projectPath: cwd, gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the Lab's seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

/** 'ok', or why the host refused the call: its code, when it gave one, before its message. */
async function outcomeOf<T>(call: Promise<T>): Promise<string> {
  try {
    await call
    return 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return error instanceof LabRpcError && error.code ? `${error.code}: ${message}` : message
  }
}

/** A person on the Solus API with their own API token, working in one organization. */
function apiClient(ctx: CloudScenarioContext, signedIn: SignedIn, organizationId: string): LabClient {
  const persona = signedIn.persona
  const client = new LabClient({
    persona: { id: persona.name.toLowerCase(), kind: 'org-member', userId: persona.userId, displayName: persona.name, organizationId, organizationRole: persona.organizationId === organizationId ? persona.organizationRole : 'member', teamIds: [] },
    hostUrl: ctx.stack.solusApi.url,
    hostId: SOLUS_API_AUDIENCE,
    hostKind: 'api',
    accessToken: () => signedIn.oauth.accessToken({ kind: 'api' }),
  })
  ctx.defer(`${persona.name}'s Solus API socket closes`, async () => client.close())
  return client
}

export default cloudModeScenario('organization work: a cloud machine runs an organization session whose records land on the Solus API', async (ctx) => {
  const lab = ctx.stack.organizations.lab
  const persona = ctx.stack.personas.alice
  const alice = await ctx.signIn('alice')
  const bob = await ctx.signIn('bob')
  const carol = await ctx.signIn('carol')

  ctx.step('an operator starts a server with alice\'s organization link code; it becomes a cloud machine of her organization')
  const host = await ctx.bootHost()
  // The Lab runs no proxy in front of the machine: its clients dial the proxied listener itself.
  const address = `https://lab-machine-${randomBytes(4).toString('hex')}.lab.invalid`
  const status = await registerHost(ctx.stack, host, alice, { organizationId: lab, address })
  const registration = status.registration.registered ? status.registration.registration : null
  ctx.check('the registration names her organization, and the cloud does not operate the compute', registration?.organizationId === lab && registration.hasManagedCompute !== true, JSON.stringify(registration && { organizationId: registration.organizationId, hasManagedCompute: registration.hasManagedCompute }))
  ctx.check('the registration names the Solus API the cloud runs', registration?.apiUrl === ctx.stack.solusApi.url, `${registration?.apiUrl} vs ${ctx.stack.solusApi.url}`)
  ctx.check('the machine is reached at its own address at once', status.link.linked, JSON.stringify(status.link))
  if (!registration) return
  const hostId = registration.hostId
  ctx.defer('alice removes the machine from her organization', async () => {
    const removed = await removeHost(ctx.stack, alice, hostId)
    if (removed !== 204 && removed !== 404) throw new Error(`Remove host answered ${removed}`)
  })
  // The local connection that registered the server was the last one it trusted by position.
  const local = localOwnerClient(host, persona)
  const localDial = await local.connect()
  local.close()
  ctx.check('a credential-free dial on its ordinary listener is refused now', !localDial.ok, JSON.stringify(localDial))

  ctx.step('bob reads the organization on the Solus API before the run')
  const bobApi = apiClient(ctx, bob, lab)
  const bobDial = await bobApi.connect()
  ctx.check('bob reaches the Solus API with his API token', bobDial.ok, JSON.stringify(bobDial))
  if (!bobDial.ok) return
  const countTitled = async (client: LabClient) => ({
    works: (await client.records.listWorks()).filter((row) => row.title === WORK_TITLE).length,
  })
  const before = await countTitled(bobApi)

  ctx.step('alice dials the machine as a member; the door makes her organization delegation')
  const member = hostClient(host, alice, hostId, { asOwner: false, organizationId: lab })
  ctx.defer('alice closes her socket', async () => member.close())
  const dialed = await member.connect()
  ctx.check('alice passes the ticket door', dialed.ok, JSON.stringify(dialed))
  if (!dialed.ok) return
  const info = await member.rpc('connectionsGetServerInfo')
  ctx.check('the machine admits her as a member, not as an owner', info.principal === 'org-member' && info.hostKind === 'cloud', JSON.stringify({ principal: info.principal, hostKind: info.hostKind }))
  // A cloud machine trusts no caller by position, so its standing is read over a member's socket.
  const standing = await ctx.until(() => member.rpc('hostOrganizations'), (read) => read.organizations.some((entry) => entry.organizationId === lab), 15_000)
  ctx.check('the machine is a cloud machine', standing.kind === 'cloud', standing.kind)
  ctx.check('it works for her organization', standing.organizations.some((entry) => entry.organizationId === lab), JSON.stringify(standing.organizations.map((entry) => entry.organizationId)))
  ctx.check('nobody owns it', standing.owner === null, JSON.stringify(standing.owner))
  const held = await ctx.until(() => host.log().find((entry) => entry.msg === 'delegation_held' && entry.userId === persona.userId && entry.scope === `organization:${lab}`), (entry) => entry !== undefined, 15_000)
  ctx.check('the machine holds her delegation for the organization', held !== undefined, JSON.stringify(host.log().filter((entry) => entry.msg?.startsWith('delegation_'))))
  ctx.check('it made no personal delegation: a cloud machine has no owner', !host.log().some((entry) => entry.msg === 'delegation_held' && entry.scope === 'personal'))

  ctx.step('alice starts a new session; the mock agent creates a work')
  // A cloud machine has no host login: a member runs turns on their own seat.
  const seat = await outcomeOf(member.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' }))
  ctx.check('alice connects a Claude seat by token', seat === 'ok', seat)
  const cwd = join(host.dataDir, 'project')
  mkdirSync(cwd, { recursive: true })
  // Every session of a cloud machine is its organization's work: a window that selected another organization starts nothing.
  const strayId = randomUUID()
  await member.rpc('watchSession', { sessionId: strayId })
  const stray = await outcomeOf(member.rpc('prompt', promptContext(strayId, cwd, ctx.stack.organizations.elsewhere), { prompt: 'work for another organization', clientPromptId: `${strayId}-1` }))
  ctx.check('a window that selected another organization is refused (ORGANIZATION_REQUIRED)', stray.startsWith('ORGANIZATION_REQUIRED:'), stray)
  const sessionId = randomUUID()
  await member.rpc('watchSession', { sessionId })
  const sent = await outcomeOf(member.rpc('prompt', promptContext(sessionId, cwd, lab), { prompt: 'organization work __MOCK_AGENT_TOOLS__', clientPromptId: `${sessionId}-1` }))
  ctx.check('the machine admits the turn for the organization', sent === 'ok', sent)

  ctx.step('bob reads what the agent made, on the Solus API')
  const after = await ctx.until(() => countTitled(bobApi), (counts) => counts.works > before.works, 30_000)
  ctx.check('bob sees the work the agent created', after.works === before.works + 1, `${before.works} → ${after.works}`)
  // The runner's report carries the record; the Solus API keeps its own copy (its `publication` is the API's, not the runner's).
  const records = await ctx.until(() => bobApi.records.sessionRecordList({ scope: 'all' }).then((list) => list.records), (list) => list.some((row) => row.sessionId === sessionId), 15_000)
  const record = records.find((row) => row.sessionId === sessionId)
  ctx.check('bob sees the session record, in the organization', record?.organizationId === lab, JSON.stringify(record?.organizationId))
  ctx.check('the record names alice as its owner and the cloud machine as its runner', record?.ownerKey === persona.userId && record.runnerHostId === hostId, JSON.stringify(record && { ownerKey: record.ownerKey, runnerHostId: record.runnerHostId }))
  ctx.check('the refused session left no record on the Solus API', !records.some((row) => row.sessionId === strayId))

  ctx.step('the machine\'s own tables hold none of it')
  const localWorks = await member.records.listWorks()
  ctx.check('the machine lists no such work of its own', localWorks.every((row) => row.title !== WORK_TITLE), JSON.stringify(localWorks.map((row) => row.title)))

  ctx.step('carol, of another organization, sees none of it')
  const carolApi = apiClient(ctx, carol, carol.persona.organizationId)
  const carolDial = await carolApi.connect()
  ctx.check('carol reaches the Solus API in her own organization', carolDial.ok, JSON.stringify(carolDial))
  if (carolDial.ok) {
    const carolCounts = await countTitled(carolApi)
    ctx.check('carol\'s organization has no such work', carolCounts.works === 0, JSON.stringify(carolCounts))
    const carolRecords = (await carolApi.records.sessionRecordList({ scope: 'all' })).records
    ctx.check('carol lists no record of the session', !carolRecords.some((row) => row.sessionId === sessionId), String(carolRecords.length))
  }
  const intruder = apiClient(ctx, carol, lab)
  const refused = await intruder.connect()
  ctx.check('carol cannot name alice\'s organization at the Solus API\'s door', !refused.ok, JSON.stringify(refused))
})
