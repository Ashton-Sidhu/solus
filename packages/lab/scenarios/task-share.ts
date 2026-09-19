import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { checkOwnership, checkSeatOfRun } from '../src/oracle'
import { PERSONAS } from '../src/personas'

/** The renderer's prompt context for a conversation in the Lab's working directory, resuming the provider thread. */
function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: sessionId, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'auto', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, latestCheckpointId: null }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', rateLimitBehavior: 'queue' }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  const context = { session, settings, statusBar }
  // SAFETY: the host reads only the fields named here (run-input.ts); the rest of the snapshot is renderer presentation state, as the seats scenario also relies on.
  return context as IpcContext
}

/**
 * Task-level sharing (§3.4): sharing a task shares its page and everything linked to
 * it — the sessions attempted under it and the works linked to it — at the task's
 * role. A person invited by name keeps their own row beside the general access. A
 * guest with a task link reaches the task, its sessions, and nothing else, and a
 * guest's turn runs on the seat of whoever made the link.
 */
export default scenario('task share: a shared task opens its page, its sessions, and its works', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const cara = await ctx.as('cara')
  const aliceUserId = PERSONAS.alice.kind === 'org-member' ? PERSONAS.alice.userId : ''
  const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''
  const aliceOwnerId = ctx.hostKind === 'personal' ? 'host-owner' : aliceUserId
  const teamHost = ctx.hostKind === 'managed'

  ctx.step('alice makes a task with a session and a document under it')
  if (ctx.hostKind === 'managed') await alice.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-alice' })
  const task = await alice.rpc('tasksCreate', { title: 'Ship the thing', projectKey: ctx.cwd })
  const taskResource = { kind: 'task', id: task.id } as const
  const created = await alice.rpc('createHeadlessSession', { prompt: 'hello from the task', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd, skipTaskCreation: true })
  const sessionId = created.agentSessionId
  await alice.rpc('tasksLinkSession', task.id, sessionId, 'working')
  const work = await alice.rpc('createWork', 'Spec', 'doc', '# Spec', 'Spec', undefined, 'claude-code', ctx.cwd)
  await alice.rpc('tasksLink', task.id, { kind: 'work', targetKey: work.id })
  const session = { kind: 'session', id: sessionId } as const
  await checkOwnership(ctx, taskResource, aliceOwnerId, { alice: true, bob: teamHost })
  if (!teamHost) {
    await expectRefused(ctx, 'bob cannot read the task before it is shared', bob.rpc('tasksGet', task.id))
    await expectRefused(ctx, 'nor its session', bob.rpc('getSessionInfo', sessionId))
  }

  ctx.step('alice invites bob to the task by name as a viewer; the task, its session, and its document open for him')
  await alice.rpc('shareSet', { resource: taskResource, grants: [{ subject: { kind: 'user', id: bobUserId }, role: 'viewer' }] })
  await expectOk(ctx, 'bob reads the task page', bob.rpc('tasksGet', task.id))
  await expectOk(ctx, 'bob reads the task\'s sessions', bob.rpc('tasksSessions', task.id))
  await expectOk(ctx, 'bob watches the session in it', bob.rpc('watchSession', { sessionId }))
  await expectOk(ctx, 'bob loads the document in it', bob.rpc('loadWork', work.id, ctx.cwd))
  if (!teamHost) {
    await expectRefused(ctx, 'bob cannot prompt it as a viewer', bob.rpc('promptSession', sessionId, 'x'))
    await expectRefused(ctx, 'bob cannot change the task as a viewer', bob.rpc('tasksUpdate', task.id, { title: 'nope' }))
  }
  const snapshot = await expectOk(ctx, 'bob reads the sidebar snapshot', bob.rpc('tasksSidebarSnapshot'))
  ctx.check('the snapshot lists the shared task', !!snapshot?.tasks.some((row) => row.id === task.id))
  const sessionList = await expectOk(ctx, 'bob reads his session share list', bob.rpc('shareGet', { resource: session }))
  ctx.check('the session says it is shared through the task', sessionList?.inheritedFrom?.[0]?.taskId === task.id, JSON.stringify(sessionList?.inheritedFrom))
  if (!teamHost) {
    await expectRefused(ctx, 'cara, not invited, cannot read the task', cara.rpc('tasksGet', task.id))
  }

  ctx.step('bob as an editor of the task may change it and prompt its session; his own row survives a scope change')
  await alice.rpc('shareSet', { resource: taskResource, grants: [{ subject: { kind: 'user', id: bobUserId }, role: 'editor' }] })
  await expectOk(ctx, 'bob renames the task', bob.rpc('tasksUpdate', task.id, { title: 'Ship the thing, together' }))
  await alice.rpc('shareSet', { resource: taskResource, grants: [
    { subject: { kind: 'user', id: bobUserId }, role: 'editor' },
    { subject: { kind: 'team', id: 'team-a' }, role: 'viewer' },
  ] })
  await expectOk(ctx, 'cara, in team A, now reads the task', cara.rpc('tasksGet', task.id))
  await expectOk(ctx, 'bob still edits', bob.rpc('tasksUpdate', task.id, { body: 'bob was here' }))
  await expectRefused(ctx, 'bob cannot delete the task', bob.rpc('tasksDelete', task.id))

  ctx.step('a guest with a task link reaches the task and its session, nothing else, and runs on alice\'s seat')
  const link = (await alice.rpc('shareSetLink', { resource: taskResource, role: 'editor' }))!
  const maya = ctx.client('maya', { shareSecret: link.secret })
  ctx.check('maya is admitted with the task link', (await maya.connect()).ok)
  const info = await maya.rpc('connectionsGetServerInfo')
  ctx.check('the host tells maya she was let in to a task', info.share?.resource.kind === 'task' && info.share.resource.id === task.id, JSON.stringify(info.share))
  await expectOk(ctx, 'maya reads the task page', maya.rpc('tasksGet', task.id))
  const guestSnapshot = await expectOk(ctx, 'maya reads a sidebar snapshot of exactly her task', maya.rpc('tasksSidebarSnapshot'))
  ctx.check('the guest snapshot holds one task', guestSnapshot?.tasks.length === 1 && guestSnapshot.tasks[0]?.id === task.id)
  await expectOk(ctx, 'maya watches the session in the task', maya.rpc('watchSession', { sessionId }))
  await expectOk(ctx, 'maya loads the document in the task', maya.rpc('loadWork', work.id, ctx.cwd))
  await expectRefused(ctx, 'maya cannot list works', maya.rpc('listWorks', ctx.cwd))
  await expectRefused(ctx, 'maya cannot make a task', maya.rpc('tasksCreate', { title: 'x' }))
  const marker = `guest-task-turn-${Date.now()}`
  // The guest shell prompts through the renderer's path, resuming the shared provider thread.
  await expectOk(ctx, 'maya prompts the session as an editor guest', maya.rpc('prompt', promptContext(ctx, sessionId), { prompt: marker, clientPromptId: `${sessionId}-${Date.now()}` }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  checkSeatOfRun(ctx, marker, aliceOwnerId === 'host-owner' ? 'host-owner' : aliceUserId)

  ctx.step('turning the task link off ends the guest')
  await alice.rpc('shareSetLink', { resource: taskResource, role: null })
  try {
    await maya.waitForDisconnect(1_000)
    ctx.check('maya\'s socket ended after the task link was removed', true)
  } catch (error) {
    ctx.check('maya\'s socket ended after the task link was removed', false, error instanceof Error ? error.message : String(error))
  }
  maya.close()

  ctx.step('only the owner deletes the task; its share rows go with it')
  await expectOk(ctx, 'alice deletes the task', alice.rpc('tasksDelete', task.id))
  if (!teamHost) await expectRefused(ctx, 'bob lost the session with the task', bob.rpc('getSessionInfo', sessionId))
})
