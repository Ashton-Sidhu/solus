import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { LabClient } from '../src/client'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario } from '../src/scenario'

/**
 * A machine with managed compute joins as every machine does
 * (plans/034-one-cloud-machine-kind.md §3): the control plane gives it a link code in
 * its environment, the server enrolls with it before it listens, and then links itself
 * at the address the control plane has. The ticket is an organization's, so the
 * machine is a cloud machine (§2): it trusts nobody by network position. The Lab issuer
 * plays the control plane; the host under test is the real server booted with that code.
 */
const registrationRecordSchema = z.object({
  registration: z.object({ hostId: z.string(), generation: z.number(), organizationId: z.string().optional(), hasManagedCompute: z.boolean().optional() }),
})
const linkRecordSchema = z.object({ desired: z.string(), reach: z.string().optional(), tunnel: z.object({ hostname: z.string(), proxiedPort: z.number() }) })
const cloudMachineRecordSchema = z.object({ organizationId: z.string(), hasManagedCompute: z.boolean().optional() })

/** A record of the host's data directory, or null when it is absent or not of this shape. */
function recordOf<T>(dataDir: string, file: string, schema: z.ZodType<T>): T | null {
  const path = join(dataDir, file)
  return existsSync(path) ? schema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data ?? null : null
}

export default scenario('managed machine: enrolled at boot with its link code, linked at its address, system-owned, nothing trusted by position', async (ctx) => {
  ctx.step('the host enrolled with the link code its environment carried, and linked itself')
  ctx.check('the Lab booted the host with a link code in its environment', ctx.host.enrolledAtBoot)
  const issued = ctx.issuer.issuedLink(ctx.host.hostId)
  ctx.check('the issuer registered the host and linked it, at the port the host bound', issued?.desired === 'linked' && issued.tunnel?.proxiedPort === Number(new URL(ctx.host.tunnelUrl).port), JSON.stringify(issued))
  const record = recordOf(ctx.host.dataDir, 'host-registration.json', registrationRecordSchema)
  ctx.check('the host stored the registration that its enrollment answered', record !== null && record.registration.hostId === ctx.host.hostId && record.registration.generation === issued?.generation, JSON.stringify(record))
  ctx.check('the registration names the organization, and says the control plane operates the compute', record?.registration.organizationId === ORGANIZATION_ID && record.registration.hasManagedCompute === true, JSON.stringify(record))
  const link = recordOf(ctx.host.dataDir, 'host-link.json', linkRecordSchema)
  ctx.check('its link is the address the control plane has: no tunnel', link?.desired === 'linked' && link.reach === 'direct' && link.tunnel.hostname === issued?.tunnel?.hostname, JSON.stringify(link))
  const secretsPath = join(ctx.host.dataDir, 'secrets', 'uplink-tokens.json')
  ctx.check('it holds no connector token', !existsSync(secretsPath) || !readFileSync(secretsPath, 'utf8').includes('connectorToken'))
  const remembered = recordOf(ctx.host.dataDir, 'cloud-machine.json', cloudMachineRecordSchema)
  ctx.check('the data directory remembers the cloud machine and its organization', remembered?.organizationId === ORGANIZATION_ID && remembered.hasManagedCompute === true, JSON.stringify(remembered))

  ctx.step('nothing on the machine is trusted by network position')
  const bare = new LabClient({ persona: personaForHost('alice', 'cloud'), hostUrl: ctx.host.localUrl, issuer: ctx.issuer, hostId: ctx.host.hostId, hostKind: 'cloud', credentialFree: true })
  const bareOutcome = await bare.dial(undefined)
  ctx.check('a credential-free loopback dial on the ordinary listener is refused', !bareOutcome.ok, JSON.stringify(bareOutcome))
  bare.close()
  const pair = await fetch(`${ctx.host.localUrl}/pair/open`, { method: 'POST' })
  ctx.check('pairing does not exist on a cloud machine', pair.status === 404, String(pair.status))

  ctx.step('the link is system-owned: an organization owner sees it but cannot unlink it')
  const alice = await ctx.as('alice')
  const info = await alice.rpc('connectionsGetServerInfo')
  ctx.check('the host reports itself as a cloud machine', info.hostKind === 'cloud', JSON.stringify(info))
  const standing = await expectOk(ctx, 'the organization owner reads the machine\'s standing', alice.rpc('hostOrganizations'))
  ctx.check('the standing says a cloud machine of the organization, with no owner', standing?.kind === 'cloud' && standing.owner === null && standing.organizations.some((entry) => entry.organizationId === ORGANIZATION_ID), JSON.stringify(standing && { kind: standing.kind, owner: standing.owner, organizations: standing.organizations.map((entry) => entry.organizationId) }))
  const status = await expectOk(ctx, 'the organization owner reads the link status', alice.rpc('uplinkStatus'))
  ctx.check('the status says registered and linked', status?.registration.registered === true && status.link.linked === true, JSON.stringify(status))
  await expectRefused(ctx, 'unlink is refused on a cloud machine', alice.rpc('uplinkUnlink'), 'MANAGED_HOST')
  const bob = await ctx.as('bob')
  await expectRefused(ctx, 'a member cannot unlink it either', bob.rpc('uplinkUnlink'), 'MANAGED_HOST')

  ctx.step('each member gets a workspace of their own beneath the host root (§3)')
  const bobPaths = await bob.rpc('start')
  const alicePaths = await alice.rpc('start')
  // A member folder is the member's name and the start of their account id (commit 010992d89).
  ctx.check('bob\'s default project path is his own directory', basename(bobPaths.projectPath).startsWith('bob-'), bobPaths.projectPath)
  ctx.check('and it is his home on this host', bobPaths.homePath === bobPaths.projectPath, bobPaths.homePath)
  ctx.check('the organization owner gets a different one', alicePaths.projectPath !== bobPaths.projectPath, alicePaths.projectPath)
  const readiness = await bob.rpc('setupHostReadiness')
  ctx.check('the clone destination the dialog offers is the same workspace', readiness.projectsRoot === bobPaths.projectPath, readiness.projectsRoot)
}, { only: 'cloud' })
