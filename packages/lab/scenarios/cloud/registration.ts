import { registerHost } from '../../src/cloud-sign-in'
import { cloudModeScenario } from '../../src/cloud-mode'
import { controlTokenWith, directory, hostKeyOf, removeHost, uplinkStatus } from '../../src/cloud-fixtures'

/**
 * Registration apart from link (docs/adr/0001-standard-authentication.md §2.2 rules 8
 * and 9, "Registration apart from link"): a signed-in owner registers a host with no
 * link; the directory lists it with no internet route. "Remove host" ends the
 * registration, and the host reads as not registered. Registering again keeps the host
 * id, advances the generation, and rotates the key: the old key gets no token.
 */
export default cloudModeScenario('registration: no link, remove host, register again with a new key', async (ctx) => {
  const persona = ctx.stack.personas.alice
  const alice = await ctx.signIn('alice')
  const host = await ctx.bootHost()

  ctx.step('alice registers the host; no link')
  const first = await registerHost(ctx.stack, host, alice)
  ctx.check('uplinkStatus: registered', first.registration.registered)
  ctx.check('uplinkStatus: not linked', !first.link.linked)
  if (!first.registration.registered) return
  const hostId = first.registration.registration.hostId
  const firstGeneration = first.registration.registration.generation
  ctx.defer('alice removes the host from her account', async () => {
    const removed = await removeHost(ctx.stack, alice, hostId)
    if (removed !== 204 && removed !== 404) throw new Error(`Remove host answered ${removed}`)
  })
  const withOwner = await ctx.until(() => uplinkStatus(host, persona), (status) => status.registration.registered && status.registration.owner !== null)
  ctx.check('the host learns its owner from the cloud: alice', withOwner.registration.registered && withOwner.registration.owner?.userId === persona.userId, JSON.stringify(withOwner.registration.registered ? withOwner.registration.owner : null))
  const listed = (await directory(ctx.stack, alice)).find((entry) => entry.hostId === hostId)
  ctx.check('the directory lists the host', listed !== undefined)
  ctx.check('it is alice\'s personal host', listed?.kind === 'personal', listed?.kind)
  ctx.check('it has no internet route', listed?.routes.length === 0, JSON.stringify(listed?.routes))
  const firstKey = hostKeyOf(host)
  ctx.check('the host keeps its key', firstKey !== null && firstKey.clientId === `host_${hostId}`, firstKey?.clientId)
  if (!firstKey) return

  ctx.step('alice removes the host on the website (Remove host)')
  const removed = await removeHost(ctx.stack, alice, hostId)
  ctx.check('Remove host is accepted', removed === 204, String(removed))
  ctx.check('the directory no longer lists the host', !(await directory(ctx.stack, alice)).some((entry) => entry.hostId === hostId))
  ctx.check('the removed key gets no control token', (await controlTokenWith(ctx.stack, firstKey)).error === 'invalid_client')
  // A running host keeps its record until it next asks for its own token; at boot it
  // checks its registration (ADR 0001 "A refused registration"). The Lab restarts it.
  ctx.step('the host restarts and checks its registration')
  const restarted = await ctx.restartHost(host)
  const afterRemove = await ctx.until(() => uplinkStatus(restarted, persona), (status) => !status.registration.registered)
  ctx.check('the host reads as not registered', !afterRemove.registration.registered, JSON.stringify(afterRemove.registration))
  // The log is written a moment after the record changes.
  ctx.check('the host logged the refusal', await ctx.until(() => restarted.log().some((entry) => entry.msg === 'host_registration_refused' && entry.hostId === hostId), (yes) => yes, 5_000))
  ctx.check('the host forgot its key', hostKeyOf(restarted) === null)

  ctx.step('alice registers the host again')
  const second = await registerHost(ctx.stack, restarted, alice)
  ctx.check('uplinkStatus: registered again', second.registration.registered)
  if (!second.registration.registered) return
  ctx.check('the host id is the same', second.registration.registration.hostId === hostId, second.registration.registration.hostId)
  ctx.check('the generation advanced', second.registration.registration.generation > firstGeneration, `${firstGeneration} → ${second.registration.registration.generation}`)
  ctx.check('still not linked', !second.link.linked)
  const secondKey = hostKeyOf(restarted)
  ctx.check('the key is new', secondKey !== null && secondKey.privateJwk.x !== firstKey.privateJwk.x)
  const relisted = (await directory(ctx.stack, alice)).find((entry) => entry.hostId === hostId)
  ctx.check('the directory lists it again, with no route', relisted !== undefined && relisted.routes.length === 0)

  ctx.step('the token endpoint takes only the new key')
  const old = await controlTokenWith(ctx.stack, firstKey)
  ctx.check('an assertion with the old key is refused (401 invalid_client)', old.status === 401 && old.error === 'invalid_client', `${old.status} ${old.error}`)
  if (secondKey) {
    const current = await controlTokenWith(ctx.stack, secondKey)
    ctx.check('an assertion with the new key gets a control token', current.status === 200, `${current.status} ${current.error}`)
  }
})
