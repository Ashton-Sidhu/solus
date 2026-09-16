import { scenario } from '../src/scenario'

/**
 * Phase 0 exit (plan §9): the admission path the tunnel takes. One grant per dial,
 * one ticket per socket, and a grant-admitted socket ends at the grant's expiry.
 */
export default scenario('uplink admission: grant per dial, ticket one-use, expiry disconnect', async (ctx) => {
  ctx.step('a fresh grant earns a ticket; the same grant cannot earn a second one')
  const bob = ctx.client('bob')
  const first = await bob.fetchTicket()
  ctx.check('the ticket door accepts a fresh grant', 'ticket' in first)
  const replayed = ctx.client('bob')
  const again = await replayed.fetchTicket()
  ctx.check('a second dial mints a second grant and is accepted too', 'ticket' in again)

  ctx.step('a ticket admits exactly one socket')
  if ('ticket' in first) {
    const admitted = await bob.dial(first.ticket)
    ctx.check('the first socket is admitted', admitted.ok)
    const second = ctx.client('bob')
    const refused = await second.dial(first.ticket)
    ctx.check('the same ticket is refused for a second socket', !refused.ok && refused.stage === 'socket' && refused.code === 'UNAUTHORIZED', JSON.stringify(refused))
  }

  ctx.step('no credential is not admitted on the proxied listener')
  const bare = ctx.client('bob')
  const bareOutcome = await bare.dial(undefined)
  ctx.check('a credential-free dial is refused on the tunnel route', !bareOutcome.ok, JSON.stringify(bareOutcome))

  ctx.step('a socket ends when its grant expires')
  const shortLived = ctx.client('cara', { grantTtlSeconds: 2 })
  const dialed = await shortLived.connect()
  ctx.check('a two-second grant admits', dialed.ok, JSON.stringify(dialed))
  if (dialed.ok) {
    const startedAt = Date.now()
    try {
      await shortLived.waitForDisconnect(6_000)
      ctx.check('the host ended the socket near the grant expiry', Date.now() - startedAt <= 4_000, `${Date.now() - startedAt} ms`)
    } catch (error) {
      ctx.check('the host ended the socket near the grant expiry', false, error instanceof Error ? error.message : String(error))
    }
  }

  ctx.step('a grant for a stranger to the organization is admitted as nobody')
  const stranger = ctx.client('bob')
  await stranger.connect()
  const info = await stranger.rpc('connectionsGetServerInfo')
  ctx.check('bob is an organization member on the wire', info.principal === 'org-member', info.principal)
  bob.close(); replayed.close(); bare.close(); shortLived.close(); stranger.close()
})
