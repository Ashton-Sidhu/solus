import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeJwtClaims } from '@solus/client-core/oauth-session'
import { ACCESS_TOKEN_TTL_SECONDS, ACCESS_TOKEN_TYPE, LINK_CODE_ENV, hostAudience, hostRegistrationSchema, isOrganizationTicket, parseLinkCode, TOKEN_EXCHANGE_GRANT_TYPE, uplinkStatusSchema } from '@solus/contracts/uplink'
import { cloudModeScenario } from '../../src/cloud-mode'
import { accountApi, directory, hostKeyOf, type DirectoryEntry } from '../../src/cloud-fixtures'
import { hostClient, type SignedIn } from '../../src/cloud-sign-in'
import { accountCall } from '../../src/local-cloud'

/**
 * A cloud machine with managed compute, in cloud mode (docs/adr/0001-standard-authentication.md
 * §5 stage 5 "Managed hosts"; plans/034-one-cloud-machine-kind.md §3): bob, a member of a
 * new organization of alice's, creates a machine through the cloud's own route. The
 * cloud's development provider (in memory) prints the link code it gives the machine
 * (`SOLUS_LINK_CODE`), as the console mailer prints mail; the Lab boots a host with the
 * code in its environment, as the machine's boot would. The host enrolls with the code
 * before it listens, as every machine joins, and then links itself. Members get
 * host tokens of the standard lifetime that list the organization and pass its ticket door as
 * members; a person of another organization gets no token.
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

const registrationRecordSchema = z.object({ registration: hostRegistrationSchema })
const linkRecordSchema = z.object({ desired: z.string(), reach: z.string().optional() })

/**
 * The link code the development provider printed for this machine's first boot: the
 * line `[memory hosts] service solus booted on machine <name>`, then
 * `{ SOLUS_LINK_CODE: '<code>' }`. The provider names the machine with its host id.
 */
function bootLinkCode(cloudLog: string, hostId: string): string | null {
  const log = readFileSync(cloudLog, 'utf8')
  const start = log.lastIndexOf(`[memory hosts] service solus booted on machine solus-h-${hostId}`)
  if (start < 0) return null
  return /SOLUS_LINK_CODE: '([^']+)'/.exec(log.slice(start))?.[1] ?? null
}

/** A record of the machine's data directory, or null when it is absent or not of this shape. */
function recordOf<T>(dataDir: string, file: string, schema: z.ZodType<T>): T | null {
  const path = join(dataDir, file)
  return existsSync(path) ? schema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data ?? null : null
}

/** How the directory lists a machine the cloud made for an organization: a cloud machine of it, whose compute the cloud operates. */
function isManagedCloudMachineOf(entry: DirectoryEntry | undefined, organizationId: string): boolean {
  return entry?.kind === 'cloud' && entry.hasManagedCompute === true && entry.organizationIds.includes(organizationId)
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

  ctx.step('the Lab boots the machine with the link code its provider was given')
  const code = await ctx.until(async () => bootLinkCode(cloudLog, hostId), (value) => value !== null, 20_000)
  ctx.check('the development provider gave the machine a link code', code !== null)
  if (!code) return
  // The code names its Solus cloud: a machine that enrolls at boot has no other way to know it.
  const parsed = code.includes('@') ? parseLinkCode(code, ctx.stack.origin) : null
  ctx.check('the code is an organization ticket and names this Solus cloud', parsed !== null && isOrganizationTicket(parsed.ticket) && parsed.directoryUrl === new URL(ctx.stack.origin).origin, JSON.stringify(parsed && { ticket: parsed.ticket.slice(0, 4), directoryUrl: parsed.directoryUrl }))
  const machine = await ctx.bootHost({ flavor: 'cloud', environment: { [LINK_CODE_ENV]: code } })
  const enrolled = await ctx.until(() => machine.log().some((entry) => entry.msg === 'host_enrolled_at_boot' && entry.hostId === hostId), (yes) => yes, 15_000)
  ctx.check('the machine enrolled at boot with the ticket and its own key', enrolled)
  ctx.check('it keeps the key for its client', hostKeyOf(machine)?.clientId === `host_${hostId}`, hostKeyOf(machine)?.clientId)
  const registration = recordOf(machine.dataDir, 'host-registration.json', registrationRecordSchema)?.registration
  ctx.check('the registration names the machine and its organization', registration?.hostId === hostId && registration.organizationId === organizationId, JSON.stringify(registration && { hostId: registration.hostId, organizationId: registration.organizationId }))
  ctx.check('the registration says the cloud operates the machine\'s compute', registration?.hasManagedCompute === true, JSON.stringify(registration?.hasManagedCompute))
  // Nobody turns the link of a cloud machine on: it asks by itself, and the cloud has its address from the provider.
  const link = await ctx.until(() => recordOf(machine.dataDir, 'host-link.json', linkRecordSchema), (record) => record !== null, 15_000)
  ctx.check('the machine linked itself at the address the cloud has: no tunnel', link?.desired === 'linked' && link.reach === 'direct', JSON.stringify(link))

  ctx.step('the directory lists the machine for its members')
  for (const member of [alice, bob]) {
    const entry = (await directory(ctx.stack, member)).find((row) => row.hostId === hostId)
    ctx.check(`${member.persona.name}'s directory lists it as a cloud machine of the organization, with managed compute`, isManagedCloudMachineOf(entry, organizationId), JSON.stringify(entry))
    ctx.check(`${member.persona.name}'s directory gives it a route`, (entry?.routes.length ?? 0) > 0, JSON.stringify(entry?.routes))
  }
  ctx.check('carol\'s directory does not list it', !(await directory(ctx.stack, carol)).some((row) => row.hostId === hostId))

  const memberDial = async (member: SignedIn, role: 'owner' | 'member') => {
    const token = await member.oauth.accessToken({ kind: 'host', hostId })
    const claims = token ? decodeJwtClaims(token, hostTokenClaimsSchema) : null
    const audiences = claims ? (Array.isArray(claims.aud) ? claims.aud : [claims.aud]) : []
    ctx.check(`${member.persona.name} gets a token for the machine`, audiences.includes(hostAudience(hostId)), JSON.stringify(audiences))
    ctx.check(`${member.persona.name}'s token lives ${ACCESS_TOKEN_TTL_SECONDS} s`, claims !== null && claims.exp - claims.iat === ACCESS_TOKEN_TTL_SECONDS, claims ? String(claims.exp - claims.iat) : 'none')
    ctx.check(`${member.persona.name}'s token lists the organization as a member`, claims?.access === 'org-member' && claims.organizations?.some((entry) => entry.id === organizationId && entry.role === role) === true, JSON.stringify(claims?.organizations))
    const client = hostClient(machine, member, hostId, { asOwner: false, organizationId, organizationRole: role })
    ctx.defer(`${member.persona.name} closes the machine socket`, async () => client.close())
    const dialed = await client.connect()
    ctx.check(`${member.persona.name} is admitted by the machine`, dialed.ok, JSON.stringify(dialed))
    if (!dialed.ok) return
    const info = serverInfoSchema.parse(await client.rpc('connectionsGetServerInfo'))
    ctx.check(`the machine sees ${member.persona.name} as an organization member`, info.principal === 'org-member', info.principal)
    // A cloud machine trusts no caller by position, so its status is read over a member's socket.
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
