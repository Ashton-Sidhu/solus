import { cloudModeScenario, type CloudHost } from '../../src/cloud-mode'
import { accountMcpServer, directory, localRpc, ownedRegisteredHost, pullAndRead, uplinkStatus, type AccountMcp } from '../../src/cloud-fixtures'
import { hostClient } from '../../src/cloud-sign-in'
import type { LabClient } from '../../src/client'

/**
 * Link only adds the tunnel (docs/adr/0001-standard-authentication.md §2.2 rule 9):
 * before the link, while linked, and after unlink, the registration (host id and
 * generation), the person's delegations, and an account read through them stay the
 * same. Only the directory route comes and goes. In development the stub tunnel's route
 * is the host's own proxied listener on loopback (solus-cloud `stubTunnelRoute`), so
 * the Lab dials it.
 */

/** The delegation events of the host's log, as one string, to compare across the link. */
function delegationEvents(host: CloudHost): string {
  return JSON.stringify(host.log().filter((entry) => entry.msg?.startsWith('delegation_')).map((entry) => [entry.msg, entry.userId, entry.scope, entry.grantId]))
}

export default cloudModeScenario('link: the tunnel comes and goes; registration, delegations, and account reads stay', async (ctx) => {
  const persona = ctx.stack.personas.alice
  const { alice, host, hostId, owner } = await ownedRegisteredHost(ctx)
  const mcp = await accountMcpServer(ctx, alice)

  /** Everything link must not change, read at one moment. */
  const identity = async (label: string, expected: { generation: number; delegations: string } | null) => {
    const status = await uplinkStatus(host, persona)
    const generation = status.registration.registered ? status.registration.registration.generation : -1
    ctx.check(`${label}: registered with the same host id`, status.registration.registered && status.registration.registration.hostId === hostId)
    if (expected) {
      ctx.check(`${label}: the generation is unchanged`, generation === expected.generation, `${expected.generation} → ${generation}`)
      ctx.check(`${label}: no delegation was made, refused, or revoked`, delegationEvents(host) === expected.delegations, delegationEvents(host))
    }
    await accountReadWorks(label, owner, mcp)
    return { generation, delegations: delegationEvents(host), linked: status.link.linked }
  }

  const accountReadWorks = async (label: string, client: LabClient, server: AccountMcp) => {
    // The host learns its owner from the cloud a moment after registration; a pull before that is refused.
    const pulled = await ctx.until(() => client.rpc('agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error)), (answer) => answer === 'ok', 20_000)
    ctx.check(`${label}: an account read (profile pull) succeeds`, pulled === 'ok', pulled)
    const view = await pullAndRead(ctx, client, server)
    ctx.check(`${label}: the account connection is connected from the cloud`, view.connection?.status === 'connected' && view.connection.source === 'cloud', JSON.stringify(view.connection))
  }

  const routeOf = async () => (await directory(ctx.stack, alice)).find((entry) => entry.hostId === hostId)?.routes ?? null

  ctx.step('before the link')
  const before = await identity('before', null)
  ctx.check('before: not linked', !before.linked)
  ctx.check('before: the directory lists no route', JSON.stringify(await routeOf()) === '[]', JSON.stringify(await routeOf()))

  ctx.step('alice links the host from its local owner connection')
  const linked = await localRpc(host, persona, 'uplinkLink')
  ctx.check('uplinkStatus: linked', linked.link.linked)
  ctx.defer('the host unlinks if the scenario stopped while linked', async () => {
    const status = await uplinkStatus(host, persona)
    if (status.link.linked) await localRpc(host, persona, 'uplinkUnlink')
  })
  const routes = await routeOf()
  const route = routes?.[0]?.url ?? ''
  ctx.check('the directory lists one tunnel route', routes?.length === 1 && routes[0]?.kind === 'tunnel', JSON.stringify(routes))
  ctx.check('in development it is the host\'s proxied listener on loopback', route === host.tunnelUrl, `${route} vs ${host.tunnelUrl}`)
  const health = route ? await fetch(`${route}/health`).then((response) => response.status, () => 0) : 0
  ctx.check('GET <route>/health answers 200', health === 200, String(health))
  if (route) {
    const viaRoute = hostClient({ localUrl: host.localUrl, tunnelUrl: route }, alice, hostId, { asOwner: true })
    ctx.defer('the client on the route closes', async () => viaRoute.close())
    const dialed = await viaRoute.connect()
    ctx.check('alice dials the host at its route with her host token', dialed.ok, JSON.stringify(dialed))
  }
  await identity('linked', before)

  ctx.step('alice unlinks the host')
  const unlinked = await localRpc(host, persona, 'uplinkUnlink')
  ctx.check('uplinkStatus: not linked', !unlinked.link.linked)
  ctx.check('the directory route is gone', JSON.stringify(await routeOf()) === '[]', JSON.stringify(await routeOf()))
  await identity('unlinked', before)
})
