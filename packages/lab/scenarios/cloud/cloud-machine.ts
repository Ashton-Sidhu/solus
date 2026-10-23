import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { decodeJwtClaims } from '@solus/client-core/oauth-session'
import { ACCESS_TOKEN_TYPE, HOST_LINK_ENV, hostAudience, TOKEN_EXCHANGE_GRANT_TYPE, hostLinkEnvSchema, uplinkStatusSchema } from '@solus/contracts/uplink'
import { cloudModeScenario } from '../../src/cloud-mode'
import { accountApi, directory, hostKeyOf } from '../../src/cloud-fixtures'
import { hostClient, type SignedIn } from '../../src/cloud-sign-in'
import { accountCall } from '../../src/local-cloud'

/**
 * A managed host in cloud mode (docs/adr/0001-standard-authentication.md §5 stage 5
 * "Managed hosts"; docs/plans/managed-hosts.md §2): bob, a member of a new
 * organization of alice's, creates a machine through the cloud's own route. The cloud's
 * development provider (Sprites in memory) prints the link it gives the machine
 * (`SOLUS_HOST_LINK`), as the console mailer prints mail; the Lab boots a host with it,
 * as the machine's boot would. The host registers its own key with the one-time
 * ticket. Members get five-minute host tokens that list the organization and pass
 * its ticket door as members; a person of another organization gets no token.
 */

const hostTokenClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
  access: z.string().optional(),
  organizations: z.array(z.object({ id: z.string(), role: z.string() })).optional(),
})
const serverInfoSchema = z.object({ principal: z.string() })
const tokenErrorSchema = z.object({ error: z.string(), solus_refusal: z.string().optional() })

/** The link the development provider printed for this machine's first boot. */
function provisionedLink(cloudLog: string, hostId: string): string | null {
  const log = readFileSync(cloudLog, 'utf8')
  const start = log.lastIndexOf(`booted on sprite solus-h-${hostId}`)
  if (start < 0) return null
  return /SOLUS_HOST_LINK: '([^']+)'/.exec(log.slice(start))?.[1] ?? null
}

export default cloudModeScenario('cloud machine: a managed host of an organization, its members, and a stranger', async (ctx) => {
  const alice = await ctx.signIn('alice')
  const bob = await ctx.signIn('bob')
  const carol = await ctx.signIn('carol')
  const cloudLog = ctx.stack.processes.find((entry) => entry.name === 'cloud')?.log ?? ''

  ctx.step('alice founds an organization for the machine and bob joins it')
  // One organization per run: an organization holds one managed host, and only its owner deletes one on the website.
  const stamp = randomBytes(4).toString('hex')
  const created = await accountCall(ctx.stack.origin, '/api/auth/organization/create', { cookie: alice.websiteCookie, body: { name: `Machines ${stamp}`, slug: `machines-${stamp}` } })
  const organizationId = z.object({ id: z.string() }).parse(await created.json()).id
  const invited = await accountCall(ctx.stack.origin, '/api/auth/organization/invite-member', { cookie: alice.websiteCookie, body: { email: bob.persona.email, role: 'member', organizationId } })
  const invitationId = z.object({ id: z.string() }).parse(await invited.json()).id
  const accepted = await accountCall(ctx.stack.origin, '/api/auth/organization/accept-invitation', { cookie: bob.websiteCookie, body: { invitationId } })
  ctx.check('bob is a member of the organization', accepted.ok, String(accepted.status))

  ctx.step('bob creates the managed host through the cloud\'s route')
  const made = await accountApi(ctx.stack, bob, '/v1/hosts', { body: { organizationId, label: `Lab machine ${stamp}` } })
  const madeBody: unknown = await made.json().catch(() => null)
  ctx.check('the cloud creates the machine (201)', made.status === 201, `${made.status} ${JSON.stringify(madeBody)}`)
  const hostId = z.object({ hostId: z.string() }).safeParse(madeBody).data?.hostId
  if (!hostId) return

  ctx.step('the Lab boots the machine with the link its provider was given')
  const linkJson = await ctx.until(async () => provisionedLink(cloudLog, hostId), (value) => value !== null, 20_000)
  ctx.check('the development provider gave the machine a link', linkJson !== null)
  if (!linkJson) return
  const link = hostLinkEnvSchema.parse(JSON.parse(linkJson))
  ctx.check('the link names the machine, its organization, and a one-time ticket', link.registration.hostId === hostId && link.registration.organizationId === organizationId && link.credentialTicket.startsWith('hct_'), JSON.stringify({ ...link.registration, ticket: link.credentialTicket.slice(0, 4) }))
  const machine = await ctx.bootHost({ flavor: 'managed', environment: { [HOST_LINK_ENV]: linkJson } })
  const adopted = await ctx.until(() => machine.log().some((entry) => entry.msg === 'provisioned_registration_adopted' && entry.hostId === hostId), (yes) => yes, 15_000)
  ctx.check('the machine registered its own key with the ticket', adopted)
  ctx.check('it keeps the key for its client', hostKeyOf(machine)?.clientId === `host_${hostId}`, hostKeyOf(machine)?.clientId)

  ctx.step('the directory lists the machine for its members')
  for (const member of [alice, bob]) {
    const entry = (await directory(ctx.stack, member)).find((row) => row.hostId === hostId)
    ctx.check(`${member.persona.name}'s directory lists it as a managed host of the organization`, entry?.kind === 'managed' && entry.organizationIds.includes(organizationId), JSON.stringify(entry))
    ctx.check(`${member.persona.name}'s directory gives it a route`, (entry?.routes.length ?? 0) > 0, JSON.stringify(entry?.routes))
  }
  ctx.check('carol\'s directory does not list it', !(await directory(ctx.stack, carol)).some((row) => row.hostId === hostId))

  const memberDial = async (member: SignedIn, role: 'owner' | 'member') => {
    const token = await member.oauth.accessToken({ kind: 'host', hostId })
    const claims = token ? decodeJwtClaims(token, hostTokenClaimsSchema) : null
    const audiences = claims ? (Array.isArray(claims.aud) ? claims.aud : [claims.aud]) : []
    ctx.check(`${member.persona.name} gets a token for the machine`, audiences.includes(hostAudience(hostId)), JSON.stringify(audiences))
    ctx.check(`${member.persona.name}'s token lives 300 s`, claims !== null && claims.exp - claims.iat === 300, claims ? String(claims.exp - claims.iat) : 'none')
    ctx.check(`${member.persona.name}'s token lists the organization as a member`, claims?.access === 'org-member' && claims.organizations?.some((entry) => entry.id === organizationId && entry.role === role) === true, JSON.stringify(claims?.organizations))
    const client = hostClient(machine, member, hostId, { asOwner: false, organizationId, organizationRole: role })
    ctx.defer(`${member.persona.name} closes the machine socket`, async () => client.close())
    const dialed = await client.connect()
    ctx.check(`${member.persona.name} is admitted by the machine`, dialed.ok, JSON.stringify(dialed))
    if (!dialed.ok) return
    const info = serverInfoSchema.parse(await client.rpc('connectionsGetServerInfo'))
    ctx.check(`the machine sees ${member.persona.name} as an organization member`, info.principal === 'org-member', info.principal)
    // A managed host trusts no caller by position, so its status is read over a member's socket.
    const status = uplinkStatusSchema.parse(await client.rpc('uplinkStatus'))
    ctx.check(`uplinkStatus to ${member.persona.name}: registered as the machine, for the organization`, status.registration.registered && status.registration.registration.hostId === hostId && status.registration.registration.organizationId === organizationId)
  }
  ctx.step('alice, the organization\'s owner, dials the machine')
  await memberDial(alice, 'owner')
  ctx.step('bob, a member, dials the machine')
  await memberDial(bob, 'member')

  ctx.step('carol, of another organization, asks for a token for the machine')
  const serversToken = (await carol.oauth.accessToken({ kind: 'api' })) ?? ''
  const refused = await fetch(`${ctx.stack.origin}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', connection: 'close' },
    body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE, client_id: carol.clientId, subject_token: serversToken, subject_token_type: ACCESS_TOKEN_TYPE, resource: hostAudience(hostId) }),
  })
  const refusal = tokenErrorSchema.safeParse(await refused.json().catch(() => null))
  ctx.check('the cloud refuses carol a token (invalid_target, host_not_found)', refused.status === 400 && refusal.data?.error === 'invalid_target' && refusal.data.solus_refusal === 'host_not_found', `${refused.status} ${JSON.stringify(refusal.data)}`)
  ctx.check('her client gets no token for it', (await carol.oauth.accessToken({ kind: 'host', hostId })) === null)
  ctx.check('a refused exchange leaves her sign-in working', (await carol.oauth.accessToken({ kind: 'account' })) !== null)
})
