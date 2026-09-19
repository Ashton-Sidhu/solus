import { expectOk, expectRefused, scenario } from '../src/scenario'
import { checkNoLocalOwnerOnManaged, checkOwnership } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS } from '../src/personas'

/**
 * Phase 1 exit (plan §9, §3.4 ownership): the creator owns a resource, sessions
 * included; only the owner transfers or deletes; a member is an editor through the
 * organization row (a managed host starts a resource with one, a personal host
 * needs the owner to share; decision 2026-09-16); a managed host has no owner person.
 */
export default scenario('ownership: the creator owns a work and a session; transfer is the owner\'s alone', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const cara = await ctx.as('cara')
  const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''
  const caraUserId = PERSONAS.cara.kind === 'org-member' ? PERSONAS.cara.userId : ''

  ctx.step('bob creates a work: he owns it; shared with the organization, every member opens it')
  const work = await bob.rpc('createWork', 'Bob\'s doc', 'doc', 'mine', 'mine', undefined, 'claude-code', ctx.cwd)
  const resource = { kind: 'work', id: work.id } as const
  if (ctx.hostKind === 'personal') {
    await bob.rpc('shareSet', { resource, grants: [{ subject: { kind: 'organization', id: ORGANIZATION_ID }, role: 'editor' }] })
  }
  await checkOwnership(ctx, resource, bobUserId, { bob: true, cara: true, alice: true })
  await expectOk(ctx, 'the organization owner opens it on either flavor', alice.rpc('loadWork', work.id, ctx.cwd))
  if (ctx.hostKind === 'managed') {
    // A managed host's organization owner is a member like any other, not the owner person (§3.4, §13).
    await expectRefused(ctx, 'the organization owner cannot transfer a member\'s work on a managed host', alice.rpc('shareTransfer', { resource, toUserId: caraUserId }))
  }

  ctx.step('only the owner transfers; the transfer target becomes the owner')
  await expectRefused(ctx, 'cara, an editor through membership, cannot transfer', cara.rpc('shareTransfer', { resource, toUserId: caraUserId }))
  await expectRefused(ctx, 'nor delete', cara.rpc('deleteWork', work.id, ctx.cwd))
  const transferred = await bob.rpc('shareTransfer', { resource, toUserId: caraUserId })
  ctx.check('cara owns it now', transferred.ownerUserId === caraUserId)
  await checkOwnership(ctx, resource, caraUserId, { cara: true, bob: true, alice: true })
  await expectOk(ctx, 'bob, no longer owner, still opens it as a member', bob.rpc('loadWork', work.id, ctx.cwd))
  await expectRefused(ctx, 'but bob can no longer transfer it', bob.rpc('shareTransfer', { resource, toUserId: bobUserId }))

  ctx.step('a session is owned by whoever started it; members may watch and stop it')
  // A member's turn runs on their own seat (Step 2): bob needs one before he can start a session.
  await expectOk(ctx, 'bob connects a seat first', bob.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-bob' }))
  const created = await bob.rpc('createHeadlessSession', { prompt: 'hello from bob', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: ctx.cwd, skipTaskCreation: true })
  const sessionId = created.agentSessionId
  ctx.check('bob started a session', sessionId.length > 0, sessionId)
  const session = { kind: 'session', id: sessionId } as const
  if (ctx.hostKind === 'personal') {
    await bob.rpc('shareSet', { resource: session, grants: [{ subject: { kind: 'organization', id: ORGANIZATION_ID }, role: 'editor' }] })
  }
  await checkOwnership(ctx, session, bobUserId, { bob: true, cara: true, alice: true })
  await expectOk(ctx, 'cara watches bob\'s session', cara.rpc('watchSession', { sessionId }))
  await expectOk(ctx, 'cara reads its info', cara.rpc('getSessionInfo', sessionId))
  await expectOk(ctx, 'as an editor cara may stop it', cara.rpc('stopSession', sessionId))

  await checkNoLocalOwnerOnManaged(ctx, ['alice', 'bob', 'cara'])
})
