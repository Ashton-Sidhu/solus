import { z } from 'zod'
import { cloudModeScenario } from '../../src/cloud-mode'
import { accountApi, accountMcpServer, localRpc, ownedRegisteredHost, pullAndRead } from '../../src/cloud-fixtures'
import { hostClient } from '../../src/cloud-sign-in'

/**
 * Sign-out ends one client grant (docs/adr/0001-standard-authentication.md §2.2 rule 5,
 * §5 stage 4): alice's desktop revokes its refresh token. The account plane refuses
 * that grant at once (refresh, account reads), and the host's delegation made from it
 * is refused at its next refresh — within one access-token life — after which the host
 * forgets it and keeps no credential from it. Her other client's grant (mobile) goes on,
 * and a new connection from it gives the host a new delegation.
 *
 * The other client is `solus-mobile` on purpose: the provider reads any use of a revoked
 * refresh token as a replay and ends every grant of that client id for the person (ADR
 * 0001 §5 "Limits" 1), which this scenario does when it proves the token is dead.
 */

const tokenErrorSchema = z.object({ error: z.string() })

export default cloudModeScenario('sign-out: one client grant ends; its delegation ends; the other client goes on', async (ctx) => {
  const persona = ctx.stack.personas.alice
  // The host replaces a delegated token in its last minute: the next refresh comes within one access-token life (90 s in the Lab, five minutes deployed).
  const tokenLifeMs = ctx.stack.accessTokenTtlSeconds * 1000
  const { alice: desktop, host, hostId, owner } = await ownedRegisteredHost(ctx)
  const mcp = await accountMcpServer(ctx, desktop)
  const before = await pullAndRead(ctx, owner, mcp)
  ctx.check('before: the account key reaches the MCP server through the host', before.connection?.source === 'cloud' && before.tools.some((name) => name.includes('echo')), JSON.stringify(before))
  const mobile = await ctx.signIn('alice', 'mobile')
  ctx.check('alice is signed in on a second client (mobile)', (await mobile.oauth.accessToken({ kind: 'account' })) !== null)

  ctx.step('alice signs out of the desktop')
  const revokedToken = desktop.store.load()?.refreshToken ?? ''
  await desktop.oauth.signOut()
  ctx.check('the revocation is accepted (2xx)', desktop.revocations.length === 1 && (desktop.revocations[0] ?? 0) >= 200 && (desktop.revocations[0] ?? 0) < 300, JSON.stringify(desktop.revocations))
  ctx.check('the desktop client is signed out', desktop.oauth.state().kind === 'signed-out', desktop.oauth.state().kind)
  const signedOutAt = Date.now()

  ctx.step('the revoked grant gets nothing from the account plane')
  for (const resource of ['urn:solus:account', `urn:solus:host:${hostId}`]) {
    const refreshed = await fetch(`${ctx.stack.origin}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', connection: 'close' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: revokedToken, client_id: desktop.clientId, resource }),
    })
    const refusal = tokenErrorSchema.safeParse(await refreshed.json().catch(() => null))
    ctx.check(`a refresh for ${resource} is refused (invalid_grant)`, refreshed.status === 400 && refusal.data?.error === 'invalid_grant', `${refreshed.status} ${refusal.data?.error}`)
  }
  const pull = await localRpc(host, persona, 'agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('an account read with the delegation is refused at once (the grant is checked live)', pull.includes('401'), pull)

  ctx.step('the host\'s next delegation refresh is refused, and it forgets the delegation')
  // Each pull asks for a delegated token; inside the renewal window that is a refresh.
  const revoked = await ctx.until(async () => {
    await localRpc(host, persona, 'agentProfilePull').catch(() => undefined)
    return host.log().find((entry) => entry.msg === 'delegation_revoked' && entry.userId === persona.userId)
  }, (entry) => entry !== undefined, tokenLifeMs + 30_000)
  const refused = host.log().find((entry) => entry.msg === 'delegation_refused' && entry.userId === persona.userId)
  ctx.check('the refresh is refused as GRANT_REVOKED', refused?.code === 'GRANT_REVOKED', JSON.stringify(refused))
  ctx.check('the host forgets her delegation', revoked !== undefined && revoked.scope === 'personal', JSON.stringify(revoked))
  ctx.check('within one access-token life of the sign-out', Date.now() - signedOutAt <= tokenLifeMs, `${Math.round((Date.now() - signedOutAt) / 1000)} s of ${ctx.stack.accessTokenTtlSeconds} s`)
  const noToken = await localRpc(host, persona, 'agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error))
  ctx.check('the host now has no way to read her account', noToken.includes('Sign in again'), noToken)

  ctx.step('no credential from the ended grant survives on the host')
  // The host's log starts again at boot: keep the ended grant's id first.
  const endedGrantId = host.log().find((entry) => entry.msg === 'delegation_held' && entry.userId === persona.userId)?.grantId
  const keySeenBefore = mcp.fake.mcpAuthorizations.filter((header) => header === `Bearer ${mcp.key}`).length
  const restarted = await ctx.restartHost(host)
  const integration = (await localRpc(restarted, persona, 'integrationList')).find((row) => row.slug === mcp.slug)
  const tools = integration ? await localRpc(restarted, persona, 'integrationTools', { id: integration.id }).catch(() => []) : []
  ctx.check('after a restart the host lists no tools of the server', !tools.some((tool) => tool.name.includes('echo')), JSON.stringify(tools.map((tool) => tool.name)))
  ctx.check('and it never sent the key again', mcp.fake.mcpAuthorizations.filter((header) => header === `Bearer ${mcp.key}`).length === keySeenBefore)
  ctx.check('the restarted host made no delegation for her', !restarted.log().some((entry) => entry.msg === 'delegation_held'))

  ctx.step('the mobile grant goes on')
  const directory = await accountApi(ctx.stack, mobile, '/v1/hosts')
  ctx.check('mobile reads the directory', directory.status === 200, String(directory.status))
  const viaMobile = hostClient(restarted, mobile, hostId, { asOwner: true })
  ctx.defer('the mobile socket closes', async () => viaMobile.close())
  const dialed = await viaMobile.connect()
  ctx.check('mobile dials the host with its own host token', dialed.ok, JSON.stringify(dialed))
  const held = await ctx.until(() => restarted.log().find((entry) => entry.msg === 'delegation_held' && entry.userId === persona.userId), (entry) => entry !== undefined)
  ctx.check('the host holds a new delegation, from the mobile grant', held !== undefined && endedGrantId !== undefined && held.grantId !== endedGrantId, JSON.stringify(held))
  const after = await pullAndRead(ctx, viaMobile, mcp)
  ctx.check('the connection is connected from the cloud again', after.connection?.status === 'connected' && after.connection.source === 'cloud', JSON.stringify(after.connection))
  ctx.check('the server\'s tools are listed with the key, through the new delegation', after.tools.some((name) => name.includes('echo')) && mcp.fake.mcpAuthorizations.filter((header) => header === `Bearer ${mcp.key}`).length > keySeenBefore, JSON.stringify(after.tools))
})
