import { randomBytes } from 'node:crypto'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import type { MetricsTurnPageResult } from '@solus/contracts/observability-types'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { ORGANIZATION_ID } from '../src/personas'
import type { LabClient } from '../src/client'

/**
 * Step 5 of docs/plans/access-model.md: the resources that had no check beyond
 * `host.use` follow `roleOf`. Proved from the other person's side:
 *
 * - automation (D4): bob makes one; dan cannot list, read, change, run, or delete
 *   it, and does not hear about it; alice, the administrator, lists and changes it.
 * - notification: bob's run notifies bob; nobody else lists or marks it.
 * - Insights (D2): dan reads only his own turns; alice reads every one; SQL is alice's alone.
 * - project: every member lists the directory; dan cannot change or remove bob's; alice can.
 * - browser profile (member-isolation.md §6): bob's is his alone; dan and alice neither list nor change it.
 * - a guest (maya) reaches none of it.
 *
 * An MCP server (D3) is not driven here: `integrationCreate` probes an HTTPS
 * address, and the Lab's fake MCP server is plain HTTP on loopback. Its rule is
 * proved on records in tests/unit/access.test.ts ("on integration rows").
 */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The renderer's prompt context for a session in the Lab's working directory, in the Lab organization. */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as in the seats scenario.
  return { session, settings, statusBar } as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId), { prompt: text, clientPromptId: `${sessionId}-${Date.now()}` })
}

/** One column of a turn page, as strings. */
function column(page: MetricsTurnPageResult | undefined, name: string): string[] {
  const index = page?.page.columns.findIndex((each) => each.name === name) ?? -1
  return index < 0 || !page ? [] : page.page.rows.map((row) => String(row[index]))
}

async function automationStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, dan: LabClient): Promise<string | null> {
  ctx.step('bob makes an automation: it is his and the administrator\'s, nobody else\'s (D4)')
  const action = { prompt: 'lab access automation', agentProvider: 'claude-code' as const, modelId: null, reasoningEffort: 'medium' as const, cwd: ctx.cwd }
  const automation = await expectOk(ctx, 'bob creates an automation', bob.rpc('automationCreate', `Bob's automation ${randomBytes(3).toString('hex')}`, action, true, { type: 'manual' }))
  if (!automation) return null
  const id = automation.id
  ctx.check('bob lists it', (await bob.rpc('automationList')).some((each) => each.id === id))
  ctx.check('dan does not list it', !(await dan.rpc('automationList')).some((each) => each.id === id))
  ctx.check('alice, the administrator, lists it', (await alice.rpc('automationList')).some((each) => each.id === id))
  await expectRefused(ctx, 'dan cannot read it', dan.rpc('automationRead', id))
  await expectRefused(ctx, 'dan cannot change it', dan.rpc('automationUpdate', id, { name: 'dan was here' }))
  await expectRefused(ctx, 'dan cannot pause it', dan.rpc('automationSetEnabled', id, false))
  await expectRefused(ctx, 'dan cannot run it', dan.rpc('automationRun', id))
  await expectRefused(ctx, 'dan cannot cancel its run', dan.rpc('automationCancel', id))
  await expectRefused(ctx, 'dan cannot read its runs', dan.rpc('automationListRuns', id))
  await expectRefused(ctx, 'dan cannot delete it', dan.rpc('automationDelete', id))
  const recent = await expectOk(ctx, 'dan reads the run graphs', dan.rpc('automationRecentRuns', 3))
  ctx.check('they hold none of bob\'s runs', !!recent && recent.every((run) => run.automationId !== id))
  const renamed = await expectOk(ctx, 'alice changes it', alice.rpc('automationUpdate', id, { name: 'Renamed by alice' }))
  ctx.check('the change is saved', renamed?.name === 'Renamed by alice')
  const bobReads = await expectOk(ctx, 'bob reads it back', bob.rpc('automationRead', id))
  ctx.check('bob sees alice\'s change', bobReads?.name === 'Renamed by alice', bobReads?.name)
  await settle(300)
  const heard = (client: LabClient) => client.received('automation.changed').some((event) => event.payload.kind !== 'deleted' && event.payload.automation.id === id)
  ctx.check('bob hears about his automation', heard(bob))
  ctx.check('alice hears about it', heard(alice))
  ctx.check('dan hears nothing about it', !heard(dan))
  return id
}

async function notificationStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, dan: LabClient, automationId: string): Promise<void> {
  ctx.step('bob runs his automation: its notification is his alone')
  const run = await expectOk(ctx, 'bob runs it', bob.rpc('automationRun', automationId))
  ctx.check('a run started', !!run, JSON.stringify(run))
  await expectOk(ctx, 'bob hears his feed change', bob.waitForEvent('notifications.changed', () => true, 20_000))
  const bobs = await expectOk(ctx, 'bob lists his notifications', bob.rpc('notificationsList', {}))
  const notification = bobs?.items.find((item) => item.resource.kind === 'automation' && item.resource.automationId === automationId)
  ctx.check('bob has the run\'s notification', !!notification, JSON.stringify(bobs?.items.map((item) => item.resource)))
  if (!notification) return
  const dans = await expectOk(ctx, 'dan lists his notifications', dan.rpc('notificationsList', {}))
  ctx.check('dan does not see bob\'s', !!dans && !dans.items.some((item) => item.id === notification.id))
  const alices = await expectOk(ctx, 'alice lists hers', alice.rpc('notificationsList', {}))
  ctx.check('nor does alice, the administrator: a notification is personal', !!alices && !alices.items.some((item) => item.id === notification.id))
  await expectRefused(ctx, 'dan cannot mark it read', dan.rpc('notificationsSetRead', { id: notification.id, read: true }))
  await expectRefused(ctx, 'alice cannot archive it', alice.rpc('notificationsSetArchived', { id: notification.id, archived: true }))
  const marked = await expectOk(ctx, 'bob marks it read', bob.rpc('notificationsSetRead', { id: notification.id, read: true }))
  ctx.check('it reads as read', marked?.ok === true && marked.notification.readAt !== null)
  ctx.check('dan heard no change to anyone\'s feed but his own', dan.received('notifications.changed').length === 0)
}

async function insightsStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, dan: LabClient, since: number): Promise<void> {
  ctx.step('dan and bob each run a turn: dan reads only his in Insights; alice reads both (D2)')
  const danSession = `access-dan-${randomBytes(3).toString('hex')}`
  const bobSession = `access-bob-${randomBytes(3).toString('hex')}`
  await expectOk(ctx, 'dan runs a turn', prompt(dan, ctx, danSession, 'dan access turn'))
  await settle(300)
  await expectOk(ctx, 'bob runs a turn', prompt(bob, ctx, bobSession, 'bob access turn'))
  await settle(800)
  const request = { timeRange: { from: since - 1_000, to: Date.now() + 60_000 }, pageIndex: 0, pageSize: 100, sort: { field: 'started_at' as const, dir: 'desc' as const } }
  const dans = await expectOk(ctx, 'dan reads his turn page', dan.rpc('metricsTurnPage', request))
  const danSessions = column(dans, 'session_id')
  ctx.check('dan\'s page holds his turn', danSessions.includes(danSession), JSON.stringify(danSessions))
  ctx.check('and not bob\'s', !danSessions.includes(bobSession), JSON.stringify(danSessions))
  const alices = await expectOk(ctx, 'alice reads the turn page', alice.rpc('metricsTurnPage', request))
  const aliceSessions = column(alices, 'session_id')
  ctx.check('alice\'s page holds both', aliceSessions.includes(danSession) && aliceSessions.includes(bobSession), JSON.stringify(aliceSessions))
  const bobTrace = column(alices, 'trace_id')[aliceSessions.indexOf(bobSession)]
  if (bobTrace) {
    await expectRefused(ctx, 'dan cannot open bob\'s turn', dan.rpc('metricsTurnTrace', bobTrace))
    await expectOk(ctx, 'alice opens it', alice.rpc('metricsTurnTrace', bobTrace))
  }
  const summary = await expectOk(ctx, 'dan reads the summary', dan.rpc('metricsTurnListingSummary', request))
  ctx.check('dan\'s summary counts only his turns', summary?.totalRows === danSessions.length, `${summary?.totalRows} vs ${danSessions.length}`)
  await expectRefused(ctx, 'dan cannot run SQL over every turn', dan.rpc('metricsRunSql', 'SELECT COUNT(*) FROM turns'))
  await expectOk(ctx, 'alice, the administrator, can', alice.rpc('metricsRunSql', 'SELECT COUNT(*) FROM turns'))
}

async function projectStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, dan: LabClient): Promise<void> {
  ctx.step('bob adds a project: every member lists it; only bob or alice changes it')
  const project = await expectOk(ctx, 'bob adds a project', bob.rpc('workspaceProjectAdd', { repositoryKey: `github.com/lab/access-${randomBytes(3).toString('hex')}` }))
  if (!project) return
  ctx.check('dan lists the organization\'s directory, with bob\'s project', (await dan.rpc('workspaceProjectList')).some((each) => each.id === project.id))
  await expectRefused(ctx, 'dan cannot rename it', dan.rpc('workspaceProjectUpdate', project.id, { displayName: 'dan was here' }))
  await expectRefused(ctx, 'dan cannot remove it', dan.rpc('workspaceProjectRemove', project.id))
  const renamed = await expectOk(ctx, 'alice renames it', alice.rpc('workspaceProjectUpdate', project.id, { displayName: 'Renamed by alice' }))
  ctx.check('the name is saved', renamed?.displayName === 'Renamed by alice')
  await expectOk(ctx, 'alice removes it', alice.rpc('workspaceProjectRemove', project.id))
  ctx.check('bob no longer lists it', !(await bob.rpc('workspaceProjectList')).some((each) => each.id === project.id))
}

/** A call the host refuses with this message, whatever its code: the profile handlers refuse a name the caller does not own as a missing profile. */
async function expectMissing(ctx: ScenarioContext, name: string, call: Promise<unknown>, message: string): Promise<void> {
  try {
    await call
    ctx.check(name, false, 'the call succeeded')
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    ctx.check(name, text.includes(message), text)
  }
}

async function browserProfileStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, dan: LabClient): Promise<void> {
  ctx.step('bob makes a browser profile: it is his alone, not dan\'s and not the administrator\'s (member-isolation.md §6)')
  const name = `Lab bob ${randomBytes(3).toString('hex')}`
  const set = await expectOk(ctx, 'bob creates a browser profile', bob.rpc('browserCreateProfile', ctx.cwd, name))
  const profile = set?.profiles.find((each) => each.name === name)
  if (!profile) return
  const listed = async (client: LabClient) => (await client.rpc('browserListProfiles', ctx.cwd)).profiles.some((each) => each.id === profile.id)
  ctx.check('bob lists it', await listed(bob))
  ctx.check('dan does not list it', !await listed(dan))
  ctx.check('alice, the administrator, does not list it', !await listed(alice))
  const missing = `No browser profile ${profile.id}`
  await expectMissing(ctx, 'dan cannot rename it', dan.rpc('browserRenameProfile', ctx.cwd, profile.id, 'dan was here'), missing)
  await expectMissing(ctx, 'dan cannot clear it', dan.rpc('browserClearProfile', ctx.cwd, profile.id), missing)
  await expectMissing(ctx, 'dan cannot make it his default', dan.rpc('browserSetDefaultProfile', ctx.cwd, profile.id), missing)
  await expectMissing(ctx, 'dan cannot delete it', dan.rpc('browserDeleteProfile', ctx.cwd, profile.id), missing)
  await expectMissing(ctx, 'alice cannot rename it either', alice.rpc('browserRenameProfile', ctx.cwd, profile.id, 'alice was here'), missing)
  ctx.check('bob still has it, unchanged', (await bob.rpc('browserListProfiles', ctx.cwd)).profiles.some((each) => each.id === profile.id && each.name === name))
  // Cookie import is not driven: it reads a real browser's cookie store on the
  // host. That alice's import never reaches bob's jar is proved in
  // tests/unit/browser-cookie-import.test.ts and browser-profiles.test.ts.
}

async function guestStep(ctx: ScenarioContext, bob: LabClient, automationId: string | null): Promise<void> {
  ctx.step('maya, a guest on bob\'s work, reaches none of these')
  const work = await expectOk(ctx, 'bob makes a work to share', bob.records.createWork('Shared with maya', 'doc', 'hello', 'hello', undefined, 'claude-code', ctx.cwd))
  if (!work) return
  const link = await expectOk(ctx, 'bob shares it by link', bob.rpc('shareSetLink', { resource: { kind: 'work', id: work.id }, role: 'viewer' }))
  if (!link?.secret) return
  const maya = ctx.client('maya', { shareSecret: link.secret })
  const dialed = await maya.connect()
  ctx.check('maya is admitted', dialed.ok, JSON.stringify(dialed))
  await expectRefused(ctx, 'maya cannot list automations', maya.rpc('automationList'))
  if (automationId) await expectRefused(ctx, 'maya cannot read bob\'s automation', maya.rpc('automationRead', automationId))
  await expectRefused(ctx, 'maya cannot list projects', maya.rpc('workspaceProjectList'))
  await expectRefused(ctx, 'maya cannot read notifications', maya.rpc('notificationsList', {}))
  await expectRefused(ctx, 'maya cannot read Insights', maya.rpc('metricsTurnPage', { timeRange: { from: 0, to: Date.now() }, pageIndex: 0, pageSize: 10, sort: { field: 'started_at', dir: 'desc' } }))
  await expectRefused(ctx, 'maya cannot list MCP servers', maya.rpc('integrationList'))
  maya.close()
}

export default scenario('access-roles: automations, notifications, Insights, projects, and browser profiles follow roleOf', async (ctx) => {
  const since = Date.now()
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const dan = await ctx.as('dan')
  // A member's turn runs on their own seat (the seats scenario).
  await expectOk(ctx, 'bob connects a seat', bob.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-bob' }))
  await expectOk(ctx, 'dan connects a seat', dan.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-dan' }))

  const automationId = await automationStep(ctx, alice, bob, dan)
  if (automationId) await notificationStep(ctx, alice, bob, dan, automationId)
  await insightsStep(ctx, alice, bob, dan, since)
  await projectStep(ctx, alice, bob, dan)
  await browserProfileStep(ctx, alice, bob, dan)
  await guestStep(ctx, bob, automationId)
  if (automationId) await expectOk(ctx, 'bob deletes his automation', bob.rpc('automationDelete', automationId))
  // The seats scenario starts with dan having no seat; leave the host as found.
  await expectOk(ctx, 'dan disconnects his seat', dan.rpc('seatDisconnect', { provider: 'claude-code' }))
  await expectOk(ctx, 'bob disconnects his seat', bob.rpc('seatDisconnect', { provider: 'claude-code' }))
})
