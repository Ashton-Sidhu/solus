import { decodeJwtClaims } from '@solus/client-core/oauth-session'
import { z } from 'zod'
import { cloudModeScenario } from '../../src/cloud-mode'
import { accountMcpServer, ownedRegisteredHost, pullAndRead } from '../../src/cloud-fixtures'
import { localOwnerClient } from '../../src/cloud-sign-in'

/**
 * Delegations kept alive (docs/adr/0001-standard-authentication.md §5 "Delegations kept
 * alive", §6 item 5): while a signed-in client of a person is connected to the host by
 * any route, the host holds a delegation for them. alice's desktop dials the host with
 * its token; her mobile client reaches the host by its trusted local route (no account
 * token at the door) and presents its host token with `accountPresent`. The desktop
 * signs out; the host learns it from the refused refresh and forgets the desktop's
 * delegation. The mobile client's next presentation makes a new one from its own grant,
 * and an account read (an MCP key from her account vault) works again. When mobile
 * signs out too, a presented token from its ended grant makes nothing, and account
 * reads fail.
 */

const accessClaimsSchema = z.object({ iat: z.number(), exp: z.number() })

export default cloudModeScenario('delegation kept alive: a second client on a trusted route keeps the person\'s delegation after the first signs out', async (ctx) => {
  const persona = ctx.stack.personas.alice
  const tokenLifeMs = ctx.stack.accessTokenTtlSeconds * 1000
  const { alice: desktop, host, hostId, owner } = await ownedRegisteredHost(ctx)
  const mcp = await accountMcpServer(ctx, desktop)
  const before = await pullAndRead(ctx, owner, mcp)
  ctx.check('before: an account read through the host works', before.connection?.source === 'cloud' && before.tools.some((name) => name.includes('echo')), JSON.stringify(before))
  const accountToken = await desktop.oauth.accessToken({ kind: 'account' })
  const claims = accountToken ? decodeJwtClaims(accountToken, accessClaimsSchema) : null
  ctx.check('the cloud\'s account tokens live the stack\'s life (development only)', claims !== null && claims.exp - claims.iat === ctx.stack.accessTokenTtlSeconds, claims ? `${claims.exp - claims.iat} s` : 'none')
  const heldBy = () => host.log().filter((entry) => entry.msg === 'delegation_held' && entry.userId === persona.userId && entry.scope === 'personal').map((entry) => entry.grantId)
  const desktopGrant = heldBy()[0]

  ctx.step('alice\'s mobile client reaches the host on its trusted local route and presents its host token')
  const mobile = await ctx.signIn('alice', 'mobile')
  const trusted = localOwnerClient(host, persona)
  ctx.defer('the trusted mobile socket closes', async () => trusted.close())
  const dialed = await trusted.connect()
  ctx.check('the trusted route admits mobile with no token at the door', dialed.ok, JSON.stringify(dialed))
  if (!dialed.ok) return
  const present = async () => {
    const token = await mobile.oauth.accessToken({ kind: 'host', hostId })
    if (!token) return { delegated: false, token: null }
    return { ...(await trusted.rpc('accountPresent', { accessToken: token })), token }
  }
  const first = await present()
  ctx.check('accountPresent answers delegated (the desktop\'s delegation is held)', first.delegated, JSON.stringify({ delegated: first.delegated }))
  ctx.check('the host made no second delegation while one is held', heldBy().length === 1, JSON.stringify(heldBy()))

  ctx.step('the desktop signs out and closes its socket')
  await desktop.oauth.signOut()
  owner.close()
  ctx.check('the revocation is accepted (2xx)', desktop.revocations.length === 1 && (desktop.revocations[0] ?? 0) >= 200 && (desktop.revocations[0] ?? 0) < 300, JSON.stringify(desktop.revocations))
  const signedOutAt = Date.now()

  ctx.step('the host learns of it from the refused refresh and forgets the desktop\'s delegation')
  const revoked = await ctx.until(async () => {
    // Each read asks for a delegated token; in its last minute that is a refresh.
    await trusted.rpc('agentProfilePull').catch(() => undefined)
    return host.log().find((entry) => entry.msg === 'delegation_revoked' && entry.userId === persona.userId)
  }, (entry) => entry !== undefined, tokenLifeMs + 30_000)
  const refused = host.log().find((entry) => entry.msg === 'delegation_refused' && entry.userId === persona.userId)
  ctx.check('the refresh is refused as GRANT_REVOKED', refused?.code === 'GRANT_REVOKED', JSON.stringify(refused))
  ctx.check('the host forgets the delegation', revoked?.scope === 'personal', JSON.stringify(revoked))
  ctx.check('within one access-token life of the sign-out', Date.now() - signedOutAt <= tokenLifeMs, `${Math.round((Date.now() - signedOutAt) / 1000)} s of ${ctx.stack.accessTokenTtlSeconds} s`)
  const gone = await trusted.rpc('agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('with no delegation, an account read fails', gone !== 'ok', gone)

  ctx.step('the mobile client presents again; the host makes a new delegation from the mobile grant')
  const again = await present()
  ctx.check('accountPresent answers delegated', again.delegated, JSON.stringify({ delegated: again.delegated }))
  // The log line follows the delegation a moment after the answer.
  const grants = await ctx.until(() => heldBy(), (held) => held.length >= 2, 5_000)
  ctx.check('the host holds a new delegation, not the desktop\'s', grants.length === 2 && desktopGrant !== undefined && grants[1] !== desktopGrant, JSON.stringify(grants))
  const after = await pullAndRead(ctx, trusted, mcp)
  ctx.check('the account read works again: connected from the cloud', after.connection?.status === 'connected' && after.connection.source === 'cloud', JSON.stringify(after.connection))
  ctx.check('the server\'s tools are listed with the key', after.tools.some((name) => name.includes('echo')), JSON.stringify(after.tools))

  ctx.step('the mobile client signs out too: nothing keeps the delegation')
  const lastToken = again.token
  await mobile.oauth.signOut()
  ctx.check('mobile\'s revocation is accepted (2xx)', mobile.revocations.length === 1 && (mobile.revocations[0] ?? 0) >= 200 && (mobile.revocations[0] ?? 0) < 300, JSON.stringify(mobile.revocations))
  ctx.check('a signed-out client has no token to present', (await mobile.oauth.accessToken({ kind: 'host', hostId })) === null)
  const mobileSignedOutAt = Date.now()
  const revokedAgain = await ctx.until(async () => {
    await trusted.rpc('agentProfilePull').catch(() => undefined)
    return host.log().filter((entry) => entry.msg === 'delegation_revoked' && entry.userId === persona.userId).length
  }, (count) => count >= 2, tokenLifeMs + 30_000)
  ctx.check('the host forgets the mobile delegation at its refused refresh', revokedAgain >= 2, String(revokedAgain))
  ctx.check('within one access-token life of the sign-out', Date.now() - mobileSignedOutAt <= tokenLifeMs, `${Math.round((Date.now() - mobileSignedOutAt) / 1000)} s`)
  if (lastToken) {
    // The host token is a JWT that verifies until it ends; its grant has ended, so the exchange is refused.
    const stale = await trusted.rpc('accountPresent', { accessToken: lastToken })
    ctx.check('a token from the ended grant makes no delegation', !stale.delegated, JSON.stringify(stale))
  }
  const none = await trusted.rpc('agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('with both clients signed out, an account read fails', none !== 'ok', none)
})
