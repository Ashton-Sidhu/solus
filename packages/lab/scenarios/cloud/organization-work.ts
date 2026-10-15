import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { LabClient } from '../../src/client'
import { cloudModeScenario, type CloudScenarioContext } from '../../src/cloud-mode'
import { accountApi, localRpc, ownedRegisteredHost, uplinkStatus } from '../../src/cloud-fixtures'
import { hostClient, type SignedIn } from '../../src/cloud-sign-in'

/**
 * Organization work against the real cloud (plans/009-organization-vms.md §1, §4, §5;
 * docs/plans/cloud-service-model.md §16): alice shares her registered host with her
 * organization, so the host reads itself attached at its next standing read. She dials
 * it naming the organization; the ticket door trades her host token for an
 * organization delegation. Her new session is admitted on the Solus API before the
 * mock agent starts, and the agent's real `create_task` and `create_work` tools write
 * through that delegation to the Solus API, not to the host's own tables. bob, a
 * member, reads the task, the work, and the session record on the Solus API with his
 * own API token; carol, of another organization, reads none of it and cannot name
 * the organization.
 */

const TASK_TITLE = 'Runner task from the mock agent'
const WORK_TITLE = 'Runner work from the mock agent'

/** The renderer's prompt context for a new conversation whose window selected an organization. */
function promptContext(sessionId: string, cwd: string, organizationId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: cwd, projectPath: cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the Lab's seats scenario relies on too.
  return { session, settings, statusBar } as IpcContext
}

/** A person on the Solus API with their own API token, working in one organization. */
function apiClient(ctx: CloudScenarioContext, signedIn: SignedIn, organizationId: string): LabClient {
  const persona = signedIn.persona
  const client = new LabClient({
    persona: { id: persona.name.toLowerCase(), kind: 'org-member', userId: persona.userId, displayName: persona.name, organizationId, organizationRole: persona.organizationId === organizationId ? persona.organizationRole : 'member', teamIds: [] },
    hostUrl: ctx.stack.solusApi.url,
    hostId: SOLUS_API_AUDIENCE,
    hostKind: 'cloud',
    accessToken: () => signedIn.oauth.accessToken({ kind: 'api' }),
  })
  ctx.defer(`${persona.name}'s Solus API socket closes`, async () => client.close())
  return client
}

export default cloudModeScenario('organization work: an attached host runs an organization session whose records land on the Solus API', async (ctx) => {
  const lab = ctx.stack.organizations.lab
  const persona = ctx.stack.personas.alice
  const { alice, host, hostId } = await ownedRegisteredHost(ctx)
  const bob = await ctx.signIn('bob')
  const carol = await ctx.signIn('carol')

  ctx.step('the registration names the cloud\'s Solus API')
  const status = await uplinkStatus(host, persona)
  const apiUrl = status.registration.registered ? status.registration.registration.apiUrl : undefined
  ctx.check('the host\'s registration names the Solus API the cloud runs', apiUrl === ctx.stack.solusApi.url, `${apiUrl} vs ${ctx.stack.solusApi.url}`)

  ctx.step('bob reads the organization on the Solus API before the run')
  const bobApi = apiClient(ctx, bob, lab)
  const bobDial = await bobApi.connect()
  ctx.check('bob reaches the Solus API with his API token', bobDial.ok, JSON.stringify(bobDial))
  if (!bobDial.ok) return
  const countTitled = async (client: LabClient) => ({
    tasks: (await client.rpc('tasksSidebarSnapshot')).tasks.filter((row) => row.title === TASK_TITLE).length,
    works: (await client.records.listWorks()).filter((row) => row.title === WORK_TITLE).length,
  })
  const before = await countTitled(bobApi)

  ctx.step('alice shares her host with her organization; at its next start it reads itself attached')
  const shared = await accountApi(ctx.stack, alice, `/v1/hosts/${hostId}/organizations`, { body: { organizationId: lab } })
  ctx.check('the cloud records the share (204)', shared.status === 204, `${shared.status} ${await shared.text().catch(() => '')}`)
  ctx.defer('alice takes the host back from her organization', async () => {
    const removed = await accountApi(ctx.stack, alice, `/v1/hosts/${hostId}/organizations/${lab}`, { method: 'DELETE' })
    if (removed.status !== 204 && removed.status !== 404) throw new Error(`Removing the share answered ${removed.status}`)
  })
  // A running host reads its standing every five minutes, and at boot.
  const restarted = await ctx.restartHost(host)
  const standing = await ctx.until(() => localRpc(restarted, persona, 'hostOrganizations'), (read) => read.attachedAt !== null, 15_000)
  ctx.check('the host stands in her organization, shared', standing.organizations.some((entry) => entry.organizationId === lab && entry.shared), JSON.stringify(standing.organizations.map((entry) => [entry.organizationId, entry.shared])))
  ctx.check('the host is attached for organization work', standing.attachedAt !== null, String(standing.attachedAt))

  ctx.step('alice dials the host naming her organization; the door makes her organization delegation')
  const owner = hostClient(restarted, alice, hostId, { asOwner: true, organizationId: lab })
  ctx.defer('alice closes her socket', async () => owner.close())
  const dialed = await owner.connect()
  ctx.check('alice passes the ticket door', dialed.ok, JSON.stringify(dialed))
  if (!dialed.ok) return
  const held = await ctx.until(() => restarted.log().find((entry) => entry.msg === 'delegation_held' && entry.userId === persona.userId && entry.scope === `organization:${lab}`), (entry) => entry !== undefined, 15_000)
  ctx.check('the host holds her delegation for the organization', held !== undefined, JSON.stringify(restarted.log().filter((entry) => entry.msg?.startsWith('delegation_'))))

  ctx.step('alice starts a new session in the organization; the mock agent creates a task and a work')
  const sessionId = randomUUID()
  const cwd = join(restarted.dataDir, 'project')
  mkdirSync(cwd, { recursive: true })
  await owner.rpc('watchSession', { sessionId })
  const sent = await owner.rpc('prompt', promptContext(sessionId, cwd, lab), { prompt: 'organization work __MOCK_AGENT_TOOLS__', clientPromptId: `${sessionId}-1` }).then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('the host admits the turn for the organization', sent === 'ok', sent)

  ctx.step('bob reads what the agent made, on the Solus API')
  const after = await ctx.until(() => countTitled(bobApi), (counts) => counts.tasks > before.tasks && counts.works > before.works, 30_000)
  ctx.check('bob sees the task the agent created', after.tasks === before.tasks + 1, `${before.tasks} → ${after.tasks}`)
  ctx.check('bob sees the work the agent created', after.works === before.works + 1, `${before.works} → ${after.works}`)
  // The runner's report carries the record; the Solus API keeps its own copy (its `publication` is the API's, not the runner's).
  const records = await ctx.until(() => bobApi.records.sessionRecordList({ scope: 'all' }).then((list) => list.records), (list) => list.some((row) => row.sessionId === sessionId), 15_000)
  const record = records.find((row) => row.sessionId === sessionId)
  ctx.check('bob sees the session record, in the organization', record?.organizationId === lab, JSON.stringify(record?.organizationId))
  ctx.check('the record names alice as its owner and her host as its runner', record?.ownerKey === persona.userId && record.runnerHostId === hostId, JSON.stringify(record && { ownerKey: record.ownerKey, runnerHostId: record.runnerHostId }))

  ctx.step('the host\'s own tables hold none of it')
  const localTasks = await owner.rpc('tasksSidebarSnapshot')
  ctx.check('the host lists no such task of its own', localTasks.tasks.every((row) => row.title !== TASK_TITLE), JSON.stringify(localTasks.tasks.map((row) => row.title)))
  const localWorks = await owner.records.listWorks()
  ctx.check('nor such a work', localWorks.every((row) => row.title !== WORK_TITLE), JSON.stringify(localWorks.map((row) => row.title)))

  ctx.step('carol, of another organization, sees none of it')
  const carolApi = apiClient(ctx, carol, carol.persona.organizationId)
  const carolDial = await carolApi.connect()
  ctx.check('carol reaches the Solus API in her own organization', carolDial.ok, JSON.stringify(carolDial))
  if (carolDial.ok) {
    const carolCounts = await countTitled(carolApi)
    ctx.check('carol\'s organization has no such task or work', carolCounts.tasks === 0 && carolCounts.works === 0, JSON.stringify(carolCounts))
    const carolRecords = (await carolApi.records.sessionRecordList({ scope: 'all' })).records
    ctx.check('carol lists no record of the session', !carolRecords.some((row) => row.sessionId === sessionId), String(carolRecords.length))
  }
  const intruder = apiClient(ctx, carol, lab)
  const refused = await intruder.connect()
  ctx.check('carol cannot name alice\'s organization at the Solus API\'s door', !refused.ok, JSON.stringify(refused))
})
