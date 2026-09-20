import { cloudScenario } from '../src/cloud-scenario'
import { expectOk, expectRefused } from '../src/scenario'
import { checkOwnership } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS } from '../src/personas'

/**
 * Task-level sharing (§3.4): sharing a task shares its page and everything linked to
 * it — the sessions attempted under it and the works linked to it — at the task's
 * role. A person invited by name keeps their own row beside the general access. A
 * guest with a task link reaches the task, its sessions, and nothing else, and a
 * guest's turn runs on the seat of whoever made the link.
 */
export default cloudScenario('task share: a shared task opens its page, its sessions, and its works', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const cara = await ctx.as('cara')
  const aliceUserId = PERSONAS.alice.kind === 'org-member' ? PERSONAS.alice.userId : ''
  const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''
  const aliceOwnerId = aliceUserId

  ctx.step('alice makes a task with a session and a document under it')
  const task = await alice.rpc('tasksCreate', { title: 'Ship the thing', projectKey: ctx.cwd })
  const taskResource = { kind: 'task', id: task.id } as const
  const sessionId = `task-session-${Date.now()}`
  const seed = ctx.issuer.issueRunnerGrant('task-fixture', ORGANIZATION_ID, 600, aliceUserId)
  const response = await fetch(`${ctx.host.tunnelUrl}/runner/session-records`, { method: 'POST', headers: { authorization: `Bearer ${seed.grant}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: 'task-fixture', reports: [{ seq: 1, record: { sessionId, provider: 'claude-code', projectPath: ctx.cwd, lastActivityAt: Date.now(), ownerUserId: aliceUserId } }] }) })
  if (!response.ok) throw new Error('Could not seed the cloud session record')
  await alice.rpc('shareSet', { resource: { kind: 'session', id: sessionId }, grants: [] })
  await alice.rpc('shareSet', { resource: taskResource, grants: [] })
  await alice.rpc('tasksLinkSession', task.id, sessionId, 'working')
  const work = await alice.rpc('createWork', 'Spec', 'doc', '# Spec', 'Spec', undefined, 'claude-code', ctx.cwd)
  await alice.rpc('shareSet', { resource: { kind: 'work', id: work.id }, grants: [] })
  await alice.rpc('tasksLink', task.id, { kind: 'work', targetKey: work.id })
  const session = { kind: 'session', id: sessionId } as const
  await checkOwnership(ctx, taskResource, aliceOwnerId, { alice: true, bob: false })
  {
    await expectRefused(ctx, 'bob cannot read the task before it is shared', bob.rpc('tasksGet', task.id))
    await expectRefused(ctx, 'nor its session', bob.rpc('describeSession', 'claude-code', sessionId))
  }

  ctx.step('alice invites bob to the task by name as a viewer; the task, its session, and its document open for him')
  await alice.rpc('shareSet', { resource: taskResource, grants: [{ subject: { kind: 'user', id: bobUserId }, role: 'viewer' }] })
  await expectOk(ctx, 'bob reads the task page', bob.rpc('tasksGet', task.id))
  await expectOk(ctx, 'bob reads the task\'s sessions', bob.rpc('tasksSessions', task.id))
  await expectOk(ctx, 'bob reads the cloud session in it', bob.rpc('getSessionInfos', [sessionId]))
  await expectOk(ctx, 'bob loads the document in it', bob.rpc('loadWork', work.id, ctx.cwd))
  {
    await expectRefused(ctx, 'bob cannot prompt it as a viewer', bob.rpc('sharedSessionPrompt', { sessionId, text: 'x' }))
    await expectRefused(ctx, 'bob cannot change the task as a viewer', bob.rpc('tasksUpdate', task.id, { title: 'nope' }))
  }
  const snapshot = await expectOk(ctx, 'bob reads the sidebar snapshot', bob.rpc('tasksSidebarSnapshot'))
  ctx.check('the snapshot lists the shared task', !!snapshot?.tasks.some((row) => row.id === task.id))
  const sessionList = await expectOk(ctx, 'bob reads his session share list', bob.rpc('shareGet', { resource: session }))
  ctx.check('the session says it is shared through the task', sessionList?.inheritedFrom?.[0]?.taskId === task.id, JSON.stringify(sessionList?.inheritedFrom))
  {
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
  await expectOk(ctx, 'maya reads the cloud session in the task', maya.rpc('getSessionInfos', [sessionId]))
  await expectOk(ctx, 'maya loads the document in the task', maya.rpc('loadWork', work.id, ctx.cwd))
  await expectRefused(ctx, 'maya cannot list works', maya.rpc('listWorks', ctx.cwd))
  await expectRefused(ctx, 'maya cannot make a task', maya.rpc('tasksCreate', { title: 'x' }))
  ctx.check('no runner is needed to read a task session', !(await maya.rpc('sharedSessionAvailable', sessionId)))

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
  await expectRefused(ctx, 'bob lost the session with the task', bob.rpc('describeSession', 'claude-code', sessionId))
})
