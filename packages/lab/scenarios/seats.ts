import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { checkSeatOfRun, recordedRuns } from '../src/oracle'
import { PERSONAS } from '../src/personas'
import type { LabClient } from '../src/client'

/**
 * Seats exit (docs/plans/provider-seats.md): a member with no seat is refused with
 * SEAT_REQUIRED and no process is spawned; a connected seat rides the run into the
 * provider; the owner's seat is the host login; a guest runs on the sharer's seat;
 * two members' turns record two seat users; a seat is the member's alone
 * to see; disconnecting it refuses the next prompt; removal is the administrator's.
 */

const danUserId = PERSONAS.dan.kind === 'org-member' ? PERSONAS.dan.userId : ''
const caraUserId = PERSONAS.cara.kind === 'org-member' ? PERSONAS.cara.userId : ''

/** The renderer's prompt context for a conversation in the Lab's working directory; a provider thread id resumes it. */
function promptContext(ctx: ScenarioContext, sessionId: string, agentSessionId: string | null = null): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'auto', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', rateLimitBehavior: 'queue' }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  const context = { session, settings, statusBar }
  // SAFETY: the host reads only the fields named here (run-input.ts); the rest of the snapshot is renderer presentation state, as `hostProviderContext` in setup-rpc.ts also relies on.
  return context as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string, agentSessionId: string | null = null) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId, agentSessionId), { prompt: text, clientPromptId: `${sessionId}-${Date.now()}` })
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

const headlessSession = (client: LabClient, ctx: ScenarioContext, text: string) =>
  client.rpc('createHeadlessSession', { prompt: text, provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd, skipTaskCreation: true })

async function noSeatStep(ctx: ScenarioContext, dan: LabClient, runsBefore: number): Promise<void> {
  ctx.step('dan has no seat: his prompt is refused before anything runs')
  const seatsAtStart = await expectOk(ctx, 'dan lists his seats', dan.rpc('seatList'))
  ctx.check('both providers read none', seatsAtStart?.every((seat) => seat.state === 'none') === true, JSON.stringify(seatsAtStart))
  await expectRefused(ctx, 'dan\'s prompt is refused with SEAT_REQUIRED', prompt(dan, ctx, 'dan-no-seat', 'dan without a seat'), 'SEAT_REQUIRED')
  await expectRefused(ctx, 'so is a headless session he starts', headlessSession(dan, ctx, 'dan headless no seat'), 'SEAT_REQUIRED')
  ctx.check('the provider was never started', recordedRuns(ctx).length === runsBefore)
}

async function connectStep(ctx: ScenarioContext, dan: LabClient, bob: LabClient): Promise<void> {
  ctx.step('dan connects a pasted token; only he hears about it')
  const bobSeatsBefore = await bob.rpc('seatList')
  const connected = await expectOk(ctx, 'dan pastes a Claude token', dan.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-dan' }))
  ctx.check('the seat is connected by token and cannot show usage', connected?.state === 'connected' && connected.method === 'token' && connected.usageCapable === false, JSON.stringify(connected))
  const notice = await expectOk(ctx, 'dan receives host.seatChanged', dan.waitForEvent('host.seatChanged', (event) => event.payload.provider === 'claude-code' && event.payload.state === 'connected'))
  ctx.check('the notice names dan', notice?.payload.userId === danUserId)
  await settle(200)
  ctx.check('bob hears nothing about dan\'s seat', bob.received('host.seatChanged').length === 0)
  const bobSeats = await expectOk(ctx, 'bob lists his own seats', bob.rpc('seatList'))
  ctx.check('bob\'s seats are unchanged by dan\'s', JSON.stringify(bobSeats) === JSON.stringify(bobSeatsBefore))

  ctx.step('dan\'s turn runs on his seat')
  const started = await expectOk(ctx, 'dan\'s prompt is accepted', prompt(dan, ctx, 'dan-seat', 'dan with a seat'))
  ctx.check('the prompt started', started?.disposition === 'started', started?.disposition)
  await settle(300)
  const danRun = checkSeatOfRun(ctx, 'dan with a seat', danUserId)
  ctx.check('the run carries dan\'s token in the env', danRun?.seat?.envToken === 'lab-token-dan')
  ctx.check('the seat lives beside the data directory, under dan\'s own directory', !!danRun?.seat?.home.startsWith(`${ctx.host.dataDir}-seats/claude/${danUserId}`), danRun?.seat?.home)
}

async function hostLoginStep(ctx: ScenarioContext, alice: LabClient): Promise<void> {
  ctx.step('the host\'s own work runs on the host login; on a managed host nobody is the host')
  if (ctx.hostKind !== 'personal') {
    await expectRefused(ctx, 'alice, an organization owner without a seat, is refused like any member', prompt(alice, ctx, 'alice-managed', 'alice on managed'), 'SEAT_REQUIRED')
    return
  }
  const ownerSeats = await expectOk(ctx, 'alice, the owner, lists her seats: the host login', alice.rpc('seatList'))
  ctx.check('the owner\'s seats are the host login', ownerSeats?.every((seat) => seat.hostLogin === true) === true, JSON.stringify(ownerSeats))
  await expectOk(ctx, 'alice prompts on it', prompt(alice, ctx, 'alice-owner', 'alice as the owner'))
  await settle(300)
  const ownerRun = checkSeatOfRun(ctx, 'alice as the owner', 'host-owner')
  ctx.check('the run is the host login, not a member seat', ownerRun?.seat?.isHostLogin === true && !ownerRun.seat.home.includes('-seats/'), ownerRun?.seat?.home)
  try {
    await alice.rpc('seatRemove', { userId: 'host-owner' })
    ctx.check('the host login cannot be removed as a seat', false, 'the call succeeded')
  } catch (error) {
    ctx.check('the host login cannot be removed as a seat', error instanceof Error && /host login/.test(error.message), error instanceof Error ? error.message : String(error))
  }
}

async function twoMembersStep(ctx: ScenarioContext, dan: LabClient, cara: LabClient): Promise<void> {
  // One after the other: the mock backend keys every run on one fixed thread id,
  // so simultaneous runs collide in the mock, not in the seat rule under test.
  ctx.step('two members each run on their own seat')
  await expectOk(ctx, 'cara pastes her token', cara.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-cara' }))
  await expectOk(ctx, 'dan prompts', prompt(dan, ctx, 'dan-second', 'dan second turn'))
  await settle(300)
  await expectOk(ctx, 'cara prompts', prompt(cara, ctx, 'cara-first', 'cara first turn'))
  await settle(300)
  checkSeatOfRun(ctx, 'dan second turn', danUserId)
  checkSeatOfRun(ctx, 'cara first turn', caraUserId)
}

async function removalStep(ctx: ScenarioContext, alice: LabClient, dan: LabClient, cara: LabClient, bob: LabClient, runsBefore: number): Promise<void> {
  ctx.step('disconnecting the seat refuses the next prompt; removal is the administrator\'s')
  const disconnected = await expectOk(ctx, 'cara disconnects', cara.rpc('seatDisconnect', { provider: 'claude-code' }))
  ctx.check('her seat reads none', disconnected?.state === 'none')
  await expectRefused(ctx, 'cara\'s next prompt is refused', prompt(cara, ctx, 'cara-after', 'cara after disconnect'), 'SEAT_REQUIRED')
  await expectRefused(ctx, 'bob, a member, cannot remove dan\'s seat', bob.rpc('seatRemove', { userId: danUserId }))
  const removed = await expectOk(ctx, 'alice, the administrator, removes dan\'s seat', alice.rpc('seatRemove', { userId: danUserId }))
  ctx.check('one seat was removed', removed?.removed === 1, JSON.stringify(removed))
  await expectRefused(ctx, 'dan is back to no seat', prompt(dan, ctx, 'dan-removed', 'dan after removal'), 'SEAT_REQUIRED')
  const runs = recordedRuns(ctx).slice(runsBefore)
  ctx.check('every run reached the provider on a seat', runs.every((run) => run.seat !== null), JSON.stringify(runs.map((run) => [run.prompt, run.seat?.userId ?? null])))
}

export default scenario('seats: every turn runs on its author\'s own login', async (ctx) => {
  const alice = await ctx.as('alice')
  const dan = await ctx.as('dan')
  const cara = await ctx.as('cara')
  const bob = await ctx.as('bob')
  const runsBefore = recordedRuns(ctx).length

  await noSeatStep(ctx, dan, runsBefore)
  await connectStep(ctx, dan, bob)
  await hostLoginStep(ctx, alice)
  await twoMembersStep(ctx, dan, cara)
  await removalStep(ctx, alice, dan, cara, bob, runsBefore)
})
