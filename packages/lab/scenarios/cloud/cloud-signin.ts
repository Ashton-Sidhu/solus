import { z } from 'zod'
import { hostClient, registerHost } from '../../src/cloud-sign-in'
import { cloudModeScenario } from '../../src/cloud-mode'
import { removeHost } from '../../src/cloud-fixtures'

/**
 * The base of cloud mode (docs/adr/0001-standard-authentication.md §2.2 rules 1, 2, 6,
 * 8): alice signs in with no browser, her identity comes from the ID token, she
 * registers a new host to her account with no link, presents her token for the host
 * at its ticket door, and the host then holds her personal delegation.
 */
const serverInfoSchema = z.object({ principal: z.string() })

export default cloudModeScenario('cloud sign-in: identity, registration without a link, a personal delegation', async (ctx) => {
  const alice = ctx.stack.personas.alice

  ctx.step('alice signs in: website password, then authorization code + PKCE as solus-desktop')
  const signedIn = await ctx.signIn('alice')
  const state = signedIn.oauth.state()
  ctx.check('the client is signed in', state.kind === 'signed-in', state.kind)
  if (state.kind !== 'signed-in') return
  ctx.check('the ID token names alice (sub)', state.identity.sub === alice.userId, `${state.identity.sub} vs ${alice.userId}`)
  ctx.check('the ID token carries her verified email', state.identity.email === alice.email && state.identity.emailVerified, `${state.identity.email} verified=${state.identity.emailVerified}`)
  await signedIn.oauth.refreshIdentity()
  const fromUserinfo = signedIn.oauth.state()
  ctx.check('/userinfo, read with an account token, gives the same person', fromUserinfo.kind === 'signed-in' && fromUserinfo.identity.sub === alice.userId && fromUserinfo.identity.name === alice.name)

  ctx.step('alice registers a new host with an enrollment ticket; no link')
  const host = await ctx.bootHost()
  const status = await registerHost(ctx.stack, host, signedIn)
  ctx.check('the host is registered', status.registration.registered)
  if (!status.registration.registered) return
  const hostId = status.registration.registration.hostId
  ctx.defer('alice removes the host from her account', () => removeHost(ctx.stack, signedIn, hostId))
  ctx.check('the registration names the local cloud as issuer', status.registration.registration.issuer === ctx.stack.origin, status.registration.registration.issuer)
  ctx.check('the host is not linked', !status.link.linked)

  ctx.step('alice dials the host with an access token for its audience')
  const client = hostClient(host, signedIn, hostId, { asOwner: true })
  ctx.defer('alice closes her socket', async () => client.close())
  const dialed = await client.connect()
  ctx.check('the ticket door admits her token and the socket opens', dialed.ok, JSON.stringify(dialed))
  if (!dialed.ok) return
  const info = serverInfoSchema.parse(await client.rpc('connectionsGetServerInfo'))
  ctx.check('the host sees her as its remote owner', info.principal === 'remote-owner', info.principal)

  ctx.step('the host trades her token for a personal delegation')
  const held = await ctx.until(() => host.log().find((entry) => entry.msg === 'delegation_held' && entry.userId === alice.userId), (entry) => entry !== undefined)
  ctx.check('the host holds alice\'s delegation', held !== undefined)
  ctx.check('its scope is personal', held?.scope === 'personal', held?.scope)
  const refused = host.log().filter((entry) => entry.msg === 'delegation_refused')
  ctx.check('no delegation was refused', refused.length === 0, refused.map((entry) => entry.scope).join(', '))
})
