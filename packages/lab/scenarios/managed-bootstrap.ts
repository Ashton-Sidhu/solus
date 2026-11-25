import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { LabClient } from '../src/client'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario } from '../src/scenario'

/**
 * Step 3 (docs/plans/managed-hosts.md §1–§2): a machine the control plane made stores
 * the link its environment carries. The link names an organization, so the machine is a
 * cloud machine (plans/034-one-cloud-machine-kind.md §2): it trusts nobody by network
 * position. The Lab issuer plays the provisioner; the host under test is the real server
 * booted from that link.
 */
const registrationRecordSchema = z.object({
  registration: z.object({ hostId: z.string(), generation: z.number(), organizationId: z.string().optional(), hasManagedCompute: z.boolean().optional() }),
})

export default scenario('managed link: stored from the environment, system-owned, nothing trusted by position', async (ctx) => {
  ctx.step('the host stored the link its environment carried')
  ctx.check('the Lab booted the host from its provisioned link', ctx.host.managedMode)
  const issued = ctx.issuer.issuedLink(ctx.host.hostId)
  ctx.check('the issuer holds the link it handed out, naming the port the host bound', issued?.tunnel?.proxiedPort === Number(new URL(ctx.host.tunnelUrl).port), JSON.stringify(issued))
  const recordPath = join(ctx.host.dataDir, 'host-registration.json')
  const record = existsSync(recordPath) ? registrationRecordSchema.safeParse(JSON.parse(readFileSync(recordPath, 'utf8'))) : null
  ctx.check('the host stored the registration from its environment', record?.success === true && record.data.registration.hostId === ctx.host.hostId && record.data.registration.generation === ctx.host.managedLink?.registration.generation, record ? JSON.stringify(record) : 'no record')
  ctx.check('the registration names the organization, and says the control plane operates the compute', record?.success === true && record.data.registration.organizationId === ORGANIZATION_ID && record.data.registration.hasManagedCompute === true, record ? JSON.stringify(record) : 'no record')

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
