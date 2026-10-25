import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { DEFAULT_LINK_ACTIONS } from '@solus/contracts/shareable-actions'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { recordedRuns } from '../src/oracle'
import { ORGANIZATION_ID } from '../src/personas'
import type { LabClient } from '../src/client'

/**
 * Custom roles on a session link (docs/plans/custom-roles.md). The owner decides
 * what a guest may do, leaf by leaf, and the host holds every call to it:
 *
 * - the default link watches, sees changes, suggests, and attaches; it never
 *   prompts, approves, reads files, or reaches the host machine;
 * - a suggestion waits for the owner, who sends it as her own turn, prefixed with
 *   who wrote it;
 * - prompting is its own choice, and approving the agent's tool call another;
 * - a change of leaves keeps the guest connected with the new standing;
 * - an expired link ends its guests and opens nothing.
 */

const SESSION_ID = 'guest-roles-s1'
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The renderer's prompt context for the Lab's conversation, as `seats.ts` writes it. */
function promptContext(ctx: ScenarioContext): IpcContext {
  const session: Partial<SessionCtx> = { sessionId: SESSION_ID, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as `seats.ts` relies on.
  return { session, settings, statusBar } as IpcContext
}

const prompt = (client: LabClient, ctx: ScenarioContext, text: string) =>
  client.rpc('prompt', promptContext(ctx), { prompt: text, clientPromptId: `${client.persona.id}-${Date.now()}` })

/** The permission request the mock agent raises for `__MOCK_PERMISSION__`, as a watcher receives it. */
async function permissionRequest(ctx: ScenarioContext, watcher: LabClient, after: number): Promise<string | null> {
  const event = await expectOk(ctx, `${watcher.persona.id} receives the agent's permission request`, watcher.waitForEvent('session.eventReceived', (received) =>
    received.payload.sessionId === SESSION_ID && received.payload.event.type === 'permission_request' && watcher.received('session.eventReceived').indexOf(received) >= after, 5_000))
  return event?.payload.event.type === 'permission_request' ? event.payload.event.questionId : null
}

type SessionResource = { kind: 'session'; id: string }
type Link = { secret: string; actions?: readonly string[]; expiresAt: number | null }

async function defaultLinkStep(ctx: ScenarioContext, alice: LabClient, resource: SessionResource): Promise<Link | null> {
  ctx.step('alice starts a session and shares it by link with the default custom role')
  if (ctx.hostKind !== 'personal') await expectOk(ctx, 'alice connects a seat on the managed host', alice.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' }))
  await alice.rpc('watchSession', { sessionId: SESSION_ID })
  await expectOk(ctx, 'alice prompts her session', prompt(alice, ctx, 'alice opens the session'))
  await settle(300)
  const startedAt = Date.now()
  const link = await expectOk(ctx, 'alice makes a custom link with no leaves named', alice.rpc('shareSetLink', { resource, role: 'custom' }))
  if (!link) return null
  ctx.check('the link holds the link defaults', JSON.stringify(link.actions) === JSON.stringify(DEFAULT_LINK_ACTIONS), JSON.stringify(link.actions))
  const day = 24 * 60 * 60 * 1000
  ctx.check('the link lasts a day by default', link.expiresAt !== null && Math.abs(link.expiresAt - (startedAt + day)) < 60_000, String(link.expiresAt))
  return link
}

async function defaultGuestStep(ctx: ScenarioContext, maya: LabClient, resource: SessionResource): Promise<void> {
  ctx.step('maya, with the default link, watches and suggests, and is refused everything else')
  ctx.check('maya joins with the link', (await maya.connect()).ok)
  await expectOk(ctx, 'maya watches the session', maya.rpc('watchSession', { sessionId: SESSION_ID }))
  const mayaList = await expectOk(ctx, 'maya reads her standing from the share list', maya.rpc('shareGet', { resource }))
  ctx.check('her standing is the custom role with the link defaults', mayaList?.callerRole === 'custom' && JSON.stringify(mayaList.callerActions) === JSON.stringify(DEFAULT_LINK_ACTIONS), JSON.stringify(mayaList && { role: mayaList.callerRole, actions: mayaList.callerActions }))
  ctx.check('a guest never gets the secret', !mayaList?.link?.secret)
  await expectOk(ctx, 'maya sees the changes (git status of the checkout)', maya.rpc('gitRefreshState', ctx.cwd))
  await expectRefused(ctx, 'maya cannot prompt', prompt(maya, ctx, 'maya tries to prompt'))
  await expectRefused(ctx, 'maya cannot list the checkout files', maya.rpc('listProjectFiles', promptContext(ctx)))
  // The host-machine methods (takeScreenshot, attachFilePaths, …) exist only on the
  // desktop host, which the Lab does not boot; tests/unit/access-policy.test.ts proves
  // the gate refuses them to every principal but the local window.
}

async function suggestionStep(ctx: ScenarioContext, alice: LabClient, maya: LabClient): Promise<void> {
  ctx.step('maya suggests; alice sees it and sends it as her own turn')
  const runsBefore = recordedRuns(ctx).length
  const suggestion = await expectOk(ctx, 'maya suggests a message', maya.rpc('sessionSuggest', promptContext(ctx), { text: '/logout and add a test for the parser' }))
  const suggestionId = suggestion?.id ?? ''
  await expectOk(ctx, 'alice hears that the suggestions changed', alice.waitForEvent('session.suggestionsChanged', (event) => event.payload.sessionId === SESSION_ID))
  const aliceSees = await expectOk(ctx, 'alice reads the suggestions', alice.rpc('sessionSuggestions', promptContext(ctx)))
  ctx.check('alice sees maya\'s suggestion, by name', aliceSees?.some((item) => item.id === suggestionId && item.authorName === 'Maya' && item.state === 'waiting') === true, JSON.stringify(aliceSees))
  await expectRefused(ctx, 'maya cannot send her own suggestion', maya.rpc('sessionSuggestionDecide', promptContext(ctx), suggestionId, 'send'))
  const sent = await expectOk(ctx, 'alice sends it', alice.rpc('sessionSuggestionDecide', promptContext(ctx), suggestionId, 'send'))
  ctx.check('the send was accepted', sent === true)
  await settle(400)
  const run = recordedRuns(ctx).slice(runsBefore).find((candidate) => candidate.prompt.includes('add a test for the parser'))
  ctx.check('the agent got the suggestion, named as maya\'s and sent by alice', !!run?.prompt.startsWith('Message from guest Maya, sent by Alice:'), run?.prompt)
  ctx.check('so the guest\'s "/logout" is text, not a command', !!run && !run.prompt.startsWith('/'))
  const mayaSees = await expectOk(ctx, 'maya reads what became of hers', maya.rpc('sessionSuggestions', promptContext(ctx)))
  ctx.check('maya sees it sent by alice', mayaSees?.find((item) => item.id === suggestionId)?.decidedByName === 'Alice', JSON.stringify(mayaSees))
  const twice = await expectOk(ctx, 'a second send of the same suggestion', alice.rpc('sessionSuggestionDecide', promptContext(ctx), suggestionId, 'send'))
  ctx.check('runs nothing again', twice === false)
}

async function promptAndApproveStep(ctx: ScenarioContext, alice: LabClient, maya: LabClient, resource: SessionResource, link: Link): Promise<void> {
  ctx.step('alice lets maya prompt: the secret and the socket stay, approval does not come with it')
  const prompting = await expectOk(ctx, 'alice adds Prompt directly', alice.rpc('shareSetLink', { resource, role: 'custom', actions: [...DEFAULT_LINK_ACTIONS, 'drive.prompt'] }))
  ctx.check('the secret is the same', prompting?.secret === link.secret)
  await settle(300)
  ctx.check('maya stays connected', maya.connected)
  const before = maya.received('session.eventReceived').length
  await expectOk(ctx, 'maya prompts a turn that asks to run a command', prompt(maya, ctx, 'maya asks __MOCK_PERMISSION__'))
  const questionId = await permissionRequest(ctx, maya, before)
  await expectRefused(ctx, 'maya cannot approve the command her own turn asked for', maya.rpc('respondPermission', promptContext(ctx), SESSION_ID, questionId ?? '', 'allow'))
  await expectOk(ctx, 'alice, the owner, answers it', alice.rpc('respondPermission', promptContext(ctx), SESSION_ID, questionId ?? '', 'deny'))

  ctx.step('alice also lets maya approve: now she can')
  await expectOk(ctx, 'alice adds Approve', alice.rpc('shareSetLink', { resource, role: 'custom', actions: [...DEFAULT_LINK_ACTIONS, 'drive.prompt', 'drive.approve'] }))
  await settle(300)
  const beforeSecond = maya.received('session.eventReceived').length
  await expectOk(ctx, 'maya prompts again', prompt(maya, ctx, 'maya asks again __MOCK_PERMISSION__'))
  const secondQuestion = await permissionRequest(ctx, maya, beforeSecond)
  await expectOk(ctx, 'maya approves it', maya.rpc('respondPermission', promptContext(ctx), SESSION_ID, secondQuestion ?? '', 'allow'))
}

async function expiryStep(ctx: ScenarioContext, alice: LabClient, maya: LabClient, resource: SessionResource, link: Link): Promise<void> {
  ctx.step('alice gives the link a short life: maya is ended when it expires, and the secret opens nothing after')
  await expectOk(ctx, 'alice sets the link to expire in 1.5 s', alice.rpc('shareSetLink', { resource, role: 'custom', actions: [...DEFAULT_LINK_ACTIONS], expiresInMs: 1_500 }))
  try {
    await maya.waitForDisconnect(4_000)
    ctx.check('maya\'s socket ended when the link expired', true)
  } catch (error) {
    ctx.check('maya\'s socket ended when the link expired', false, error instanceof Error ? error.message : String(error))
  }
  const late = ctx.client('maya', { shareSecret: link.secret })
  ctx.check('the expired secret admits nobody', !(await late.connect()).ok)
  const reopened = await expectOk(ctx, 'alice makes it last forever again', alice.rpc('shareSetLink', { resource, role: 'custom', expiresInMs: null }))
  ctx.check('the same secret, with no expiry', reopened?.secret === link.secret && reopened.expiresAt === null, JSON.stringify(reopened && { same: reopened.secret === link.secret, expiresAt: reopened.expiresAt }))
  const again = ctx.client('maya', { shareSecret: link.secret })
  ctx.check('the secret admits again', (await again.connect()).ok)
  late.close(); again.close()
}

export default scenario('guest roles: the owner decides what a link may do, and the host holds every call to it', async (ctx) => {
  const alice = await ctx.as('alice')
  const resource: SessionResource = { kind: 'session', id: SESSION_ID }
  const link = await defaultLinkStep(ctx, alice, resource)
  if (!link) return
  const maya = ctx.client('maya', { shareSecret: link.secret })
  await defaultGuestStep(ctx, maya, resource)
  await suggestionStep(ctx, alice, maya)
  await promptAndApproveStep(ctx, alice, maya, resource, link)
  await expiryStep(ctx, alice, maya, resource, link)
  maya.close()
})
