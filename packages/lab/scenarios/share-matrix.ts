import { cloudScenario } from '../src/cloud-scenario'
import { expectOk, expectRefused, type ScenarioContext } from '../src/scenario'
import type { LabClient } from '../src/client'
import { checkNoLocalOwnerOnManaged, checkOwnership, checkWorkListing } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS, TEAM_A } from '../src/personas'

/**
 * Phase 1 exit (plan §9): every persona against the role matrix (§3.5) on one work,
 * in both host flavors. Alice creates; bob is org-only; cara is in team A; dan has no
 * row; maya arrives by link. A share is a scope (decision 2026-09-16): a member holds
 * what the rows give them, and a managed host starts a resource shared with the
 * organization while a personal host starts it private.
 */
export default cloudScenario('share matrix: rows decide, owner, guest, and a link on one work', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const cara = await ctx.as('cara')
  const dan = await ctx.as('dan')
  const aliceUserId = PERSONAS.alice.kind === 'org-member' ? PERSONAS.alice.userId : ''
  const aliceOwnerId = ctx.hostKind === 'personal' ? 'host-owner' : aliceUserId
  const teamHost = ctx.hostKind !== 'personal'

  ctx.step(teamHost ? 'alice creates a work on the team host; it starts shared with the organization' : 'alice creates a work on her machine; it starts private')
  const work = await alice.rpc('createWork', 'Plan', 'doc', '# Plan\n\nFirst line.', 'Plan', undefined, 'claude-code', ctx.cwd)
  const resource = { kind: 'work', id: work.id } as const
  await checkOwnership(ctx, resource, aliceOwnerId, { alice: true, bob: teamHost, cara: teamHost, dan: teamHost })
  await checkWorkListing(ctx, 'bob', work.id, teamHost)
  await checkWorkListing(ctx, 'alice', work.id, true)

  ctx.step('alice sets rows: organization = viewer, team A = editor')
  const list = await alice.rpc('shareSet', { resource, grants: [
    { subject: { kind: 'organization', id: ORGANIZATION_ID }, role: 'viewer' },
    { subject: { kind: 'team', id: TEAM_A }, role: 'editor' },
  ] })
  ctx.check('the list has both rows and alice stays owner', list.grants.length === 2 && list.callerRole === 'owner')
  const bobChanged = await expectOk(ctx, 'bob receives share.changed', bob.waitForEvent('share.changed', (event) => event.payload.resource.id === work.id))
  ctx.check('the change names alice', bobChanged?.payload.changedBy.displayName === 'Alice', bobChanged?.payload.changedBy.displayName)

  ctx.step('viewer: bob, org-only, reads and nothing more')
  await expectOk(ctx, 'bob loads the work', bob.rpc('loadWork', work.id, ctx.cwd))
  await checkWorkListing(ctx, 'bob', work.id, true)
  await expectRefused(ctx, 'bob cannot save', bob.rpc('saveWork', work.id, { content: '# Plan\n\nBob was here.' }, ctx.cwd))
  await expectRefused(ctx, 'bob cannot delete', bob.rpc('deleteWork', work.id, ctx.cwd))
  const bobList = await expectOk(ctx, 'bob reads the share list', bob.rpc('shareGet', { resource }))
  ctx.check('bob is a viewer through the organization row', bobList?.callerRole === 'viewer', bobList?.callerRole)

  ctx.step('editor: cara, in team A, writes and shares, cannot transfer or delete')
  await expectOk(ctx, 'cara saves', cara.rpc('saveWork', work.id, { content: '# Plan\n\nCara was here.' }, ctx.cwd))
  await expectRefused(ctx, 'cara cannot transfer ownership', cara.rpc('shareTransfer', { resource, toUserId: PERSONAS.cara.kind === 'org-member' ? PERSONAS.cara.userId : '' }))
  await expectRefused(ctx, 'cara cannot delete', cara.rpc('deleteWork', work.id, ctx.cwd))
  const caraList = await expectOk(ctx, 'cara reads the share list', cara.rpc('shareGet', { resource }))
  ctx.check('cara is an editor through the team row', caraList?.callerRole === 'editor', caraList?.callerRole)

  ctx.step('dan, in no team, is a viewer through the organization row')
  await expectOk(ctx, 'dan loads the work', dan.rpc('loadWork', work.id, ctx.cwd))
  await expectRefused(ctx, 'dan cannot save', dan.rpc('saveWork', work.id, { content: '# Plan\n\nDan was here.' }, ctx.cwd))
  const danList = await expectOk(ctx, 'dan reads the share list', dan.rpc('shareGet', { resource }))
  ctx.check('dan is a viewer', danList?.callerRole === 'viewer', danList?.callerRole)

  ctx.step('alice widens to the organization as editors, the scope the dialog offers')
  await alice.rpc('shareSet', { resource, grants: [{ subject: { kind: 'organization', id: ORGANIZATION_ID }, role: 'editor' }] })
  await expectOk(ctx, 'bob saves now', bob.rpc('saveWork', work.id, { content: '# Plan\n\nBob was here.' }, ctx.cwd))

  const maya = await guestStep(ctx, resource, alice)

  await checkNoLocalOwnerOnManaged(ctx, ['alice', 'bob', 'cara', 'dan'])

  ctx.step('owner: alice transfers to bob; bob becomes owner, alice keeps only what the rows give her')
  const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''
  const transferred = await alice.rpc('shareTransfer', { resource, toUserId: bobUserId })
  ctx.check('bob is the owner now', transferred.ownerUserId === bobUserId)
  const bobNow = await bob.rpc('shareGet', { resource })
  ctx.check('bob reads himself as owner', bobNow.callerRole === 'owner', bobNow.callerRole)
  const aliceNow = await alice.rpc('shareGet', { resource })
  ctx.check(
    ctx.hostKind === 'personal' ? 'on a personal host alice keeps every role (she owns the disk)' : 'on a managed host alice is now an editor through the organization row',
    ctx.hostKind === 'personal' ? aliceNow.callerRole === 'owner' : aliceNow.callerRole === 'editor',
    aliceNow.callerRole,
  )
  await expectOk(ctx, 'bob, as owner, deletes the work', bob.rpc('deleteWork', work.id, ctx.cwd))
  await expectRefused(ctx, 'the deleted work is gone for maya too', maya.rpc('loadWork', work.id, ctx.cwd))
  maya.close()
})

/** A guest arrives by a viewer link: one resource, one role, no host (§3.4, §3.5). Returns the connected guest. */
async function guestStep(ctx: ScenarioContext, resource: { kind: 'work'; id: string }, alice: LabClient): Promise<LabClient> {
  ctx.step('guest: maya arrives by a viewer link')
  const link = await alice.rpc('shareSetLink', { resource, role: 'viewer' })
  ctx.check('the link secret is returned once', !!link?.secret)
  const maya = ctx.client('maya', { shareSecret: link!.secret })
  const dialed = await maya.connect()
  ctx.check('maya is admitted with the secret', dialed.ok, JSON.stringify(dialed))
  const mayaInfo = await maya.rpc('connectionsGetServerInfo')
  ctx.check('maya is a guest on the wire', mayaInfo.principal === 'guest', mayaInfo.principal)
  ctx.check('the host tells maya what she was let in to see', mayaInfo.share?.resource.id === resource.id && mayaInfo.share.role === 'viewer' && mayaInfo.displayName === 'Maya', JSON.stringify(mayaInfo.share))
  await expectOk(ctx, 'maya loads the work', maya.rpc('loadWork', resource.id, ctx.cwd))
  await expectRefused(ctx, 'maya cannot save', maya.rpc('saveWork', resource.id, { content: 'x' }, ctx.cwd))
  await expectRefused(ctx, 'maya cannot list works (host-wide)', maya.rpc('listWorks', ctx.cwd))
  await expectRefused(ctx, 'maya cannot list projects', maya.rpc('listProjects'), 'PLANE_DISABLED')
  await expectRefused(ctx, 'maya cannot read the share list beyond her own resource', maya.rpc('shareGet', { resource: { kind: 'work', id: 'other' } }))
  const mayaList = await expectOk(ctx, 'maya reads her resource\'s share list', maya.rpc('shareGet', { resource }))
  ctx.check('maya is a viewer', mayaList?.callerRole === 'viewer', mayaList?.callerRole)
  ctx.check('a viewer sees that a link exists but not its secret', !!mayaList?.link && mayaList.link.secret === undefined)
  const aliceList = await expectOk(ctx, 'alice reads the list', alice.rpc('shareGet', { resource }))
  ctx.check('the sharer always has the link at hand', aliceList?.link?.secret === link!.secret)
  const wrongSecret = ctx.client('maya', { shareSecret: 'not-the-secret' })
  const refused = await wrongSecret.connect()
  ctx.check('a wrong secret earns no ticket', !refused.ok && refused.stage === 'ticket' && refused.status === 401, JSON.stringify(refused))
  const noSecret = ctx.client('maya')
  const bare = await noSecret.connect()
  ctx.check('a guest grant without a secret earns no ticket', !bare.ok && bare.stage === 'ticket', JSON.stringify(bare))

  wrongSecret.close(); noSecret.close()
  return maya
}
