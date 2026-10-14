import type { HostPresenceSnapshot } from '@solus/contracts/presence'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import type { LabClient } from '../src/client'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { ORGANIZATION_ID } from '../src/personas'

/**
 * The renderer's prompt context for a conversation in the Lab's working directory, with
 * the Lab organization selected: on a machine attached for organization work a new root
 * needs one (plans/009-organization-vms.md §1).
 */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as the seats scenario also relies on.
  return { session, settings, statusBar } as IpcContext
}

/**
 * The roster describes the session a person has focused: a draft in it, then a
 * turn alice starts in it reads running and, parked on a permission, waiting for
 * input, with the host's own name for the session on the row.
 */
async function activityStep(ctx: ScenarioContext, alice: LabClient, bob: LabClient, sessionId: string): Promise<void> {
  ctx.step('the roster says what the focused session is doing')
  const bobRow = (event: { payload: HostPresenceSnapshot }) => event.payload.participants.find((row) => row.user.displayName === 'Bob')
  // A session others may watch was born by its first turn, so it has an index row; an
  // unindexed one is a session only its starter has: alice focuses a new one of her own.
  const unindexedId = `${sessionId}-unindexed`
  await expectOk(ctx, 'alice opens a new session of her own', alice.rpc('watchSession', { sessionId: unindexedId }))
  await expectOk(ctx, 'alice focuses it', alice.rpc('presenceSetFocus', { focus: { kind: 'session', sessionId: unindexedId } }))
  const aliceFocused = await expectOk(ctx, 'alice reads her row on that session', alice.waitForEvent('host.presenceChanged', (event) => event.payload.participants.some((row) => row.user.displayName === 'Alice' && row.focus.kind === 'session' && row.focus.sessionId === unindexedId)))
  const aliceActivity = aliceFocused?.payload.participants.find((row) => row.user.displayName === 'Alice')?.activity
  ctx.check('an unindexed session is named by nobody and rests', aliceActivity === undefined || (aliceActivity.state === 'idle' && aliceActivity.title === null), JSON.stringify(aliceActivity))
  const bobBeforeRun = (await expectOk(ctx, 'alice re-reads the host', alice.rpc('presenceSnapshot')))?.host.participants.find((row) => row.user.displayName === 'Bob')
  ctx.check('the session bob has focused rests between turns', bobBeforeRun?.activity === undefined || bobBeforeRun.activity.state === 'idle', JSON.stringify(bobBeforeRun?.activity))
  await expectOk(ctx, 'bob drafts in the session he has focused', bob.rpc('presenceSetComposing', { sessionId, isComposing: true }))
  await expectOk(ctx, 'alice sees the draft on the roster row', alice.waitForEvent('host.presenceChanged', (event) => bobRow(event)?.isComposing === true))
  await expectOk(ctx, 'bob drops the draft', bob.rpc('presenceSetComposing', { sessionId, isComposing: false }))
  // A permission prompt parks the mock run on a person, so the roster reads running, then waiting.
  const promptedAt = Date.now()
  await expectOk(ctx, 'alice prompts the session bob is looking at', alice.rpc('prompt', promptContext(ctx, sessionId), { prompt: 'presence __MOCK_PERMISSION__', clientPromptId: `${sessionId}-${promptedAt}` }))
  // The first "running" republish is the provider connecting, before the run is
  // registered; the parked turn is the stable row, so the author is read there.
  await expectOk(ctx, 'alice hears bob\'s row say the agent runs', alice.waitForEvent('host.presenceChanged', (event) => event.occurredAt >= promptedAt && bobRow(event)?.activity?.state === 'running'))
  const waiting = await expectOk(ctx, 'then say it waits for input', alice.waitForEvent('host.presenceChanged', (event) => event.occurredAt >= promptedAt && bobRow(event)?.activity?.state === 'waiting'))
  const waitingActivity = waiting ? bobRow(waiting)?.activity : undefined
  ctx.check('the parked row names alice as the turn\'s author', waitingActivity?.activeTurn?.author.displayName === 'Alice', waitingActivity?.activeTurn?.author.displayName)
  // The mock backend answers every session on one provider thread, so the index
  // row behind the title is the first prompt any scenario sent it; the proof is
  // that the host named the session at all, not which prompt it chose.
  const waitingTitle = waitingActivity?.title ?? undefined
  ctx.check('the indexed session now has a name from the host', (waitingTitle?.length ?? 0) > 0, waitingTitle)
  // Delivered to bob on his own socket, a frame behind alice's at most: waited for, not assumed already read.
  await expectOk(ctx, 'bob hears the same row about himself', bob.waitForEvent('host.presenceChanged', (event) => bobRow(event)?.activity?.state === 'waiting'))
}

/**
 * Presence (docs/plans/multiplayer-presence.md): the host names everyone from the
 * principal; a session's room is its connected watchers; typing and focus reach the
 * right people; a guest sees its one room and never the host; and a dropped socket
 * leaves every room at once.
 */
export default scenario('presence: rooms, typing, focus, and leaving', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const sessionId = `lab-presence-${Date.now()}`
  const hasName = (rows: ReadonlyArray<{ user: { displayName: string } }>, name: string) => rows.some((row) => row.user.displayName === name)

  ctx.step('each client learns its own id and the host roster names the other')
  const aliceSnapshot = await expectOk(ctx, 'alice reads the snapshot', alice.rpc('presenceSnapshot'))
  const bobSnapshot = await expectOk(ctx, 'bob reads the snapshot', bob.rpc('presenceSnapshot'))
  ctx.check('the two clients have different ids', !!aliceSnapshot && !!bobSnapshot && aliceSnapshot.clientId !== bobSnapshot.clientId)
  ctx.check('bob sees alice on the host', !!bobSnapshot && hasName(bobSnapshot.host.participants, 'Alice'))
  ctx.check('alice sees bob on the host', !!aliceSnapshot && hasName(aliceSnapshot.host.participants, 'Bob'))
  const bobRow = aliceSnapshot?.host.participants.find((row) => row.user.displayName === 'Bob')
  ctx.check('bob is a member with no focus yet', bobRow?.access === 'member' && bobRow.focus.kind === 'none')
  await expectOk(ctx, 'alice heard bob arrive', alice.waitForEvent('host.presenceChanged', (event) => hasName(event.payload.participants, 'Bob')))

  ctx.step('alice starts a session; its first turn gives the organization editor access')
  // A new organization session is private until the first turn admits it; that turn
  // gives the organization editor access on the machine (plans/009-organization-vms.md §9,
  // "Live access on the VM"). A share before then is refused: sharing with an organization
  // moves the record into it, and the session has no record yet (share-manager.ts).
  // A managed host has no host login: alice runs on a pasted seat there, as any member does.
  if (ctx.hostKind !== 'personal') await expectOk(ctx, 'alice pastes a seat to run on', alice.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' }))
  await alice.rpc('watchSession', { sessionId })
  const startedAt = Date.now()
  await expectOk(ctx, 'alice sends the first turn', alice.rpc('prompt', promptContext(ctx, sessionId), { prompt: 'presence first turn', clientPromptId: `${sessionId}-${startedAt}` }))
  await expectOk(ctx, 'the first turn settles', alice.waitForEvent('session.eventReceived', (event) => event.payload.sessionId === sessionId && event.payload.event.type === 'turn_settled'))

  ctx.step('two watchers make a room of two')
  await expectOk(ctx, 'bob watches the session', bob.rpc('watchSession', { sessionId }))
  const room = await expectOk(ctx, 'alice hears the room grow', alice.waitForEvent('session.presenceChanged', (event) => event.payload.sessionId === sessionId && event.payload.participants.length === 2))
  ctx.check('the room names both', !!room && hasName(room.payload.participants, 'Alice') && hasName(room.payload.participants, 'Bob'))
  ctx.check('nothing is running', room?.payload.activeTurn === null)
  await expectOk(ctx, 'bob hears the room too', bob.waitForEvent('session.presenceChanged', (event) => event.payload.sessionId === sessionId && event.payload.participants.length === 2))

  ctx.step('typing and focus reach the other watcher')
  await expectOk(ctx, 'bob reports a draft', bob.rpc('presenceSetComposing', { sessionId, isComposing: true }))
  await expectOk(ctx, 'alice sees bob typing', alice.waitForEvent('session.presenceChanged', (event) => event.payload.sessionId === sessionId && event.payload.participants.some((row) => row.user.displayName === 'Bob' && row.isComposing)))
  await expectOk(ctx, 'bob reports the draft gone', bob.rpc('presenceSetComposing', { sessionId, isComposing: false }))
  await expectOk(ctx, 'alice sees bob stop', alice.waitForEvent('session.presenceChanged', (event) => event.payload.sessionId === sessionId && event.payload.participants.length === 2 && event.payload.participants.every((row) => !row.isComposing)))
  await expectOk(ctx, 'bob reports his focus', bob.rpc('presenceSetFocus', { focus: { kind: 'session', sessionId } }))
  await expectOk(ctx, 'alice sees where bob is', alice.waitForEvent('host.presenceChanged', (event) => event.payload.participants.some((row) => row.user.displayName === 'Bob' && row.focus.kind === 'session' && row.focus.sessionId === sessionId)))

  await activityStep(ctx, alice, bob, sessionId)

  ctx.step('a dropped socket leaves every room at once')
  const closedAt = Date.now()
  bob.close()
  // Only an event after the close counts: the room before bob joined also lacked him.
  const roomAfter = await expectOk(ctx, 'alice sees bob leave the session', alice.waitForEvent('session.presenceChanged', (event) => event.occurredAt >= closedAt && event.payload.sessionId === sessionId && !hasName(event.payload.participants, 'Bob'), 2_000))
  ctx.check('the room keeps alice', !!roomAfter && hasName(roomAfter.payload.participants, 'Alice'))
  await expectOk(ctx, 'alice sees bob leave the host', alice.waitForEvent('host.presenceChanged', (event) => event.occurredAt >= closedAt && !hasName(event.payload.participants, 'Bob'), 2_000))
  // The seats scenario expects alice without a seat on a managed host; leave it as found.
  if (ctx.hostKind !== 'personal') await expectOk(ctx, 'alice disconnects the seat again', alice.rpc('seatDisconnect', { provider: 'claude-code' }))
})
