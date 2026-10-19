import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { accountAgentProfileResponseSchema, agentProfileKeyOf, type AgentProfileFileEntry } from '@solus/contracts/agent-profile'
import { integrationToolName } from '@solus/contracts/integration-types'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import type { LabClient } from '../../src/client'
import { cloudModeScenario, type CloudHost, type CloudScenarioContext } from '../../src/cloud-mode'
import { accountApi, accountMcpServer, localRpc, ownedRegisteredHost, pullAndRead, type AccountMcp } from '../../src/cloud-fixtures'
import { hostClient, type SignedIn } from '../../src/cloud-sign-in'
import { recordedRuns } from '../../src/oracle'

/**
 * One agent profile on two hosts (docs/plans/access-model.md §0, §2.1, §2.6; plans/020
 * §2, §5). alice keeps an MCP server in her agent profile and its key in her account
 * vault; the server refuses an anonymous list, as PlanetScale does. Each of her two
 * hosts pulls the profile: the server is hers on both (owner), its connection reads
 * `connected` from the cloud, and the profile's file lands under each host's own HOME.
 *
 * The original bug: a host listed MCP tools at boot as "the host" (no person), the
 * server refused that list, and runs read only that cache, so alice's agent got no
 * tools. Here host B restarts (nothing cached), alice prompts it remotely through its
 * ticket door, and the run the mock agent receives carries the server's tools, listed
 * with her key. bob, a member of her organization, reaches host B after she shares it:
 * his run gets none of her tools, and he cannot list or read her server.
 */

const PROFILE_PATH = '/v1/account/agent-profile'

/** The renderer's prompt context for a new conversation; `organizationId` is the window's organization, if any. */
function promptContext(sessionId: string, cwd: string, organizationId: string | undefined): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: cwd, projectPath: cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as organization-work relies on too.
  return { session, settings, statusBar } as IpcContext
}

/** A skill file in alice's agent profile, removed at the end. */
async function profileFile(ctx: CloudScenarioContext, alice: SignedIn): Promise<{ skill: string; content: string }> {
  const skill = `lab-skill-${randomBytes(3).toString('hex')}`
  const content = `# ${skill}\n\nA skill from alice's account, applied on each of her hosts.\n`
  const entry: AgentProfileFileEntry = { kind: 'file', provider: 'claude-code', path: `skills/${skill}/SKILL.md`, contentBase64: Buffer.from(content).toString('base64'), hash: createHash('sha256').update(content).digest('hex') }
  const key = agentProfileKeyOf(entry)
  const readProfile = async () => accountAgentProfileResponseSchema.parse(await (await accountApi(ctx.stack, alice, PROFILE_PATH)).json())
  const profile = await readProfile()
  const added = await accountApi(ctx.stack, alice, PROFILE_PATH, { method: 'PATCH', body: { generation: profile.generation, expectedRevision: profile.revision, set: { [key]: entry }, reset: [] } })
  if (!added.ok) throw new Error(`Adding the file to the profile answered ${added.status}: ${await added.text()}`)
  ctx.defer('the file leaves alice\'s profile', async () => {
    const current = await readProfile()
    const removed = await accountApi(ctx.stack, alice, PROFILE_PATH, { method: 'PATCH', body: { generation: current.generation, expectedRevision: current.revision, set: {}, reset: [key] } })
    if (!removed.ok) throw new Error(`Removing the file from the profile answered ${removed.status}`)
  })
  return { skill, content }
}

/** One host after alice's pull: the server is hers, connected from the cloud, and the file is in the host's own home. */
async function checkPulledOn(ctx: CloudScenarioContext, label: string, host: CloudHost, owner: LabClient, mcp: AccountMcp, file: { skill: string; content: string }): Promise<void> {
  const alice = ctx.stack.personas.alice
  const view = await pullAndRead(ctx, owner, mcp)
  const integration = (await owner.rpc('integrationList')).find((row) => row.id === view.integrationId)
  ctx.check(`${label}: alice's integration list shows the server`, integration !== undefined, JSON.stringify(view))
  ctx.check(`${label}: it is hers (ownerKey her account, role owner)`, integration?.ownerKey === alice.userId && integration.role === 'owner', JSON.stringify(integration && { ownerKey: integration.ownerKey, role: integration.role }))
  ctx.check(`${label}: its connection reads connected, from the cloud`, view.connection?.status === 'connected' && view.connection.source === 'cloud', JSON.stringify(view.connection))
  const applied = join(host.dataDir, 'home', '.claude', 'skills', file.skill, 'SKILL.md')
  ctx.check(`${label}: the profile file is in the host login's Claude home`, existsSync(applied) && readFileSync(applied, 'utf8') === file.content, applied)
  ctx.check(`${label}: that home is inside the host's data directory`, existsSync(applied) && realpathSync(applied).startsWith(`${realpathSync(host.dataDir)}${sep}`), existsSync(applied) ? realpathSync(applied) : 'missing')
}

/** Submits a prompt on a new session; 'ok' or the refusal. */
async function promptNewSession(client: LabClient, host: CloudHost, text: string, organizationId: string | undefined): Promise<string> {
  const sessionId = randomUUID()
  const cwd = join(host.dataDir, 'project')
  mkdirSync(cwd, { recursive: true })
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(sessionId, cwd, organizationId), { prompt: text, clientPromptId: `${sessionId}-1` }).then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
}

export default cloudModeScenario('profile across hosts: one profile on two hosts, and a remote run gets its person\'s MCP tools', async (ctx) => {
  const lab = ctx.stack.organizations.lab
  const persona = ctx.stack.personas.alice

  ctx.step('alice registers two hosts and dials each with her host token')
  const a = await ownedRegisteredHost(ctx)
  const b = await ownedRegisteredHost(ctx)
  ctx.check('the two hosts are different registrations', a.hostId !== b.hostId, `${a.hostId} ${b.hostId}`)

  ctx.step('alice puts an MCP server in her profile and its key in her vault, and a skill file in her profile')
  const mcp = await accountMcpServer(ctx, a.alice)
  const file = await profileFile(ctx, a.alice)
  const echoTool = integrationToolName(mcp.slug, 'echo')

  ctx.step('host A and host B each pull her profile')
  await checkPulledOn(ctx, 'host A', a.host, a.owner, mcp, file)
  await checkPulledOn(ctx, 'host B', b.host, b.owner, mcp, file)
  ctx.check('the developer\'s own home did not get the file', !existsSync(join(homedir(), '.claude', 'skills', file.skill)), join(homedir(), '.claude', 'skills', file.skill))

  ctx.step('host B restarts, so it holds no tool list; alice dials it again through its ticket door')
  b.owner.close()
  const hostB = await ctx.restartHost(b.host)
  const remote = hostClient(hostB, b.alice, b.hostId, { asOwner: true })
  ctx.defer('alice closes her socket to host B after its restart', async () => remote.close())
  const dialed = await remote.connect()
  ctx.check('alice passes host B\'s ticket door after the restart', dialed.ok, JSON.stringify(dialed))
  if (!dialed.ok) return
  // A held delegation is saved and survives the restart (`establish` exchanges nothing again);
  // the run's tool list below, read with her key, proves it still works.
  const refused = hostB.log().filter((entry) => entry.userId === persona.userId && (entry.msg === 'delegation_not_established' || entry.msg === 'delegation_refused'))
  ctx.check('host B kept her personal delegation across the restart', refused.length === 0, JSON.stringify(refused))

  ctx.step('alice prompts a new session on host B; the run reaches the agent with her MCP server\'s tools')
  const seenBefore = mcp.fake.mcpAuthorizations.length
  const aliceMarker = `alice remote run ${randomBytes(3).toString('hex')}`
  const sent = await promptNewSession(remote, hostB, aliceMarker, undefined)
  ctx.check('host B admits alice\'s prompt', sent === 'ok', sent)
  const aliceRun = (await ctx.until(() => recordedRuns({ host: hostB }), (runs) => runs.some((run) => run.prompt.includes(aliceMarker)), 20_000)).find((run) => run.prompt.includes(aliceMarker))
  ctx.check('the run reached the mock agent backend', aliceRun !== undefined)
  ctx.check('the run was handed the MCP server\'s tool', aliceRun?.tools?.includes(echoTool) === true, JSON.stringify(aliceRun?.tools?.filter((name) => name.includes('__'))))
  const sinceRestart = mcp.fake.mcpAuthorizations.slice(seenBefore)
  ctx.check('the server was called with alice\'s key', sinceRestart.includes(`Bearer ${mcp.key}`), JSON.stringify(sinceRestart.map((header) => header?.slice(0, 16) ?? 'anonymous')))
  ctx.check('and never anonymously or with another key', sinceRestart.every((header) => header === `Bearer ${mcp.key}`), JSON.stringify(sinceRestart.map((header) => header?.slice(0, 16) ?? 'anonymous')))
  const aliceIntegration = (await remote.rpc('integrationList')).find((row) => row.slug === mcp.slug)

  ctx.step('alice shares host B with her organization; bob, a member, reaches it')
  const bob = await ctx.signIn('bob')
  const shared = await accountApi(ctx.stack, b.alice, `/v1/hosts/${b.hostId}/organizations`, { body: { organizationId: lab } })
  ctx.check('the cloud records the share (204)', shared.status === 204, `${shared.status} ${await shared.text().catch(() => '')}`)
  ctx.defer('alice takes host B back from her organization', async () => {
    const removed = await accountApi(ctx.stack, b.alice, `/v1/hosts/${b.hostId}/organizations/${lab}`, { method: 'DELETE' })
    if (removed.status !== 204 && removed.status !== 404) throw new Error(`Removing the share answered ${removed.status}`)
  })
  remote.close()
  // A running host reads its standing every five minutes, and at boot.
  const attached = await ctx.restartHost(hostB)
  const standing = await ctx.until(() => localRpc(attached, persona, 'hostOrganizations'), (read) => read.attachedAt !== null, 15_000)
  ctx.check('host B is attached for organization work', standing.attachedAt !== null, String(standing.attachedAt))
  const member = hostClient(attached, bob, b.hostId, { asOwner: false, organizationId: lab, organizationRole: 'member' })
  ctx.defer('bob closes his socket', async () => member.close())
  const bobDial = await member.connect()
  ctx.check('bob passes host B\'s ticket door as a member', bobDial.ok, JSON.stringify(bobDial))
  if (!bobDial.ok) return

  ctx.step('bob cannot list or read alice\'s server')
  const bobIntegrations = await member.rpc('integrationList')
  ctx.check('bob\'s integration list has no server of alice\'s', bobIntegrations.every((row) => row.slug !== mcp.slug && row.ownerKey !== persona.userId), JSON.stringify(bobIntegrations.map((row) => [row.slug, row.ownerKey])))
  if (aliceIntegration) {
    const read = await member.rpc('integrationTools', { id: aliceIntegration.id }).then((tools) => `listed ${tools.length}`, (error: unknown) => error instanceof Error ? error.message : String(error))
    ctx.check('bob cannot list the tools of alice\'s server by its id', !read.startsWith('listed'), read)
  } else {
    ctx.check('alice\'s integration id was read on host B', false, 'missing')
  }

  ctx.step('bob runs on his own seat; his run gets none of alice\'s tools')
  const seat = await member.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-bob' }).then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('bob connects a Claude seat by token', seat === 'ok', seat)
  const bobMarker = `bob member run ${randomBytes(3).toString('hex')}`
  const bobSent = await promptNewSession(member, attached, bobMarker, lab)
  ctx.check('host B admits bob\'s prompt in the organization', bobSent === 'ok', bobSent)
  const bobRun = (await ctx.until(() => recordedRuns({ host: attached }), (runs) => runs.some((run) => run.prompt.includes(bobMarker)), 20_000)).find((run) => run.prompt.includes(bobMarker))
  ctx.check('bob\'s run reached the mock agent backend', bobRun !== undefined)
  ctx.check('bob\'s run was handed none of alice\'s MCP tools', bobRun !== undefined && bobRun.tools !== undefined && !bobRun.tools.some((name) => name.startsWith(`${mcp.slug}__`)), JSON.stringify(bobRun?.tools?.filter((name) => name.includes('__'))))
})
