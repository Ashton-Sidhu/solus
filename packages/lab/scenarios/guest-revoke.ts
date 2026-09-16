import { expectOk, expectRefused, scenario } from '../src/scenario'
import { PERSONAS } from '../src/personas'

/**
 * Phase 1 exit (plan §9, §3.4 revocation): a regenerated or removed link ends every
 * guest socket within a second; removing a member's named row changes nothing for
 * them, because membership alone makes them an editor (decision 2026-09-15).
 */
export default scenario('guest revoke: regenerate and remove the link; remove a member', async (ctx) => {
  const alice = await ctx.as('alice')
  const bob = await ctx.as('bob')
  const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''

  ctx.step('alice shares a work by link and to bob')
  const work = await alice.rpc('createWork', 'Notes', 'doc', 'hello', 'hello', undefined, 'claude-code', ctx.cwd)
  const resource = { kind: 'work', id: work.id } as const
  await alice.rpc('shareSet', { resource, grants: [{ subject: { kind: 'user', id: bobUserId }, role: 'editor' }] })
  const link = (await alice.rpc('shareSetLink', { resource, role: 'editor' }))!
  const maya = ctx.client('maya', { shareSecret: link.secret })
  ctx.check('maya joins as an editor', (await maya.connect()).ok)
  await expectOk(ctx, 'maya edits', maya.rpc('saveWork', work.id, { content: 'maya was here' }, ctx.cwd))

  ctx.step('regenerating the link ends maya within a second and refuses the old secret')
  const rotated = (await alice.rpc('shareSetLink', { resource, role: 'editor', regenerate: true }))!
  ctx.check('a new secret came back', rotated.secret !== link.secret)
  const revokedAt = Date.now()
  try {
    await maya.waitForDisconnect(1_000)
    ctx.check('maya\'s socket ended within one second', true, `${Date.now() - revokedAt} ms`)
  } catch (error) {
    ctx.check('maya\'s socket ended within one second', false, error instanceof Error ? error.message : String(error))
  }
  const oldSecret = ctx.client('maya', { shareSecret: link.secret })
  const stale = await oldSecret.connect()
  ctx.check('the old secret is refused', !stale.ok && stale.stage === 'ticket')
  const maya2 = ctx.client('maya', { shareSecret: rotated.secret })
  ctx.check('the new secret admits', (await maya2.connect()).ok)

  ctx.step('changing only the link role keeps guests connected with the new role')
  const roleOnly = await alice.rpc('shareSetLink', { resource, role: 'viewer' })
  ctx.check('a role change mints no new secret', roleOnly === null)
  await new Promise((r) => setTimeout(r, 300))
  ctx.check('maya stays connected', maya2.connected)
  await expectRefused(ctx, 'maya is now a viewer and cannot edit', maya2.rpc('saveWork', work.id, { content: 'x' }, ctx.cwd))
  await expectOk(ctx, 'maya still reads', maya2.rpc('loadWork', work.id, ctx.cwd))

  ctx.step('turning the link off ends every guest')
  await alice.rpc('shareSetLink', { resource, role: null })
  try {
    await maya2.waitForDisconnect(1_000)
    ctx.check('maya\'s socket ended after the link was removed', true)
  } catch (error) {
    ctx.check('maya\'s socket ended after the link was removed', false, error instanceof Error ? error.message : String(error))
  }
  const noLink = ctx.client('maya', { shareSecret: rotated.secret })
  ctx.check('no secret works once the link is off', !(await noLink.connect()).ok)

  ctx.step('removing bob\'s named row keeps his socket and his access: membership is the floor')
  await expectOk(ctx, 'bob edits while named', bob.rpc('saveWork', work.id, { content: 'bob was here' }, ctx.cwd))
  await alice.rpc('shareSet', { resource, grants: [] })
  const notice = await expectOk(ctx, 'bob receives the change that removed his row', bob.waitForEvent('share.changed', (event) => event.payload.resource.id === work.id && event.payload.removedUserIds.includes(bobUserId)))
  ctx.check('the notice names alice', notice?.payload.changedBy.displayName === 'Alice')
  ctx.check('bob\'s socket stays open', bob.connected)
  await expectOk(ctx, 'bob still opens and edits the work as a member', bob.rpc('saveWork', work.id, { content: 'still bob' }, ctx.cwd))
  await expectOk(ctx, 'bob still uses the host', bob.rpc('listWorks', ctx.cwd))
  maya.close(); oldSecret.close(); maya2.close(); noLink.close()
})
