import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { LabClient } from '../src/client'
import { PERSONAS, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario } from '../src/scenario'

/**
 * Step 3 (docs/plans/managed-hosts.md §1–§2): a managed host stores the link its
 * environment carries and then trusts nobody by network position. The Lab issuer
 * plays the provisioner; the host under test is the real server in managed mode.
 */
const linkRecordSchema = z.object({
  desired: z.literal('linked'),
  link: z.object({ hostId: z.string(), proxiedPort: z.number(), connectionGeneration: z.number() }),
})

export default scenario('managed link: stored from the environment, system-owned, nothing trusted by position', async (ctx) => {
  ctx.step('the host stored the link its environment carried')
  ctx.check('the Lab booted the host in managed mode', ctx.host.managedMode)
  const issued = ctx.issuer.issuedLink(ctx.host.hostId)
  ctx.check('the issuer holds the link it handed out, naming the port the host bound', issued?.proxiedPort === Number(new URL(ctx.host.tunnelUrl).port), JSON.stringify(issued))
  const recordPath = join(ctx.host.dataDir, 'uplink-link.json')
  const record = existsSync(recordPath) ? linkRecordSchema.safeParse(JSON.parse(readFileSync(recordPath, 'utf8'))) : null
  ctx.check('the host stored the link record from its environment', record?.success === true && record.data.link.hostId === ctx.host.hostId && record.data.link.connectionGeneration === ctx.host.managedLink?.link.connectionGeneration, record ? JSON.stringify(record) : 'no record')

  ctx.step('nothing on the machine is trusted by network position')
  const bare = new LabClient({ persona: personaForHost('alice', 'managed'), hostUrl: ctx.host.localUrl, issuer: ctx.issuer, hostId: ctx.host.hostId, hostKind: 'managed', credentialFree: true })
  const bareOutcome = await bare.dial(undefined)
  ctx.check('a credential-free loopback dial on the ordinary listener is refused', !bareOutcome.ok, JSON.stringify(bareOutcome))
  bare.close()
  const pair = await fetch(`${ctx.host.localUrl}/pair/open`, { method: 'POST' })
  ctx.check('pairing does not exist on a managed host', pair.status === 404, String(pair.status))

  ctx.step('the link is system-owned: an organization owner sees it but cannot unlink it')
  const alice = await ctx.as('alice')
  const info = await alice.rpc('connectionsGetServerInfo')
  ctx.check('the host reports itself as managed', info.hostKind === 'managed', JSON.stringify(info))
  const status = await expectOk(ctx, 'the organization owner reads the link status', alice.rpc('uplinkStatus'))
  ctx.check('the status says linked', status?.linked === true, JSON.stringify(status))
  await expectRefused(ctx, 'unlink is refused on a managed host', alice.rpc('uplinkUnlink'), 'MANAGED_HOST')
  const bob = await ctx.as('bob')
  await expectRefused(ctx, 'a member cannot unlink it either', bob.rpc('uplinkUnlink'), 'MANAGED_HOST')

  ctx.step('each member gets a workspace of their own beneath the host root (§3)')
  const bobPaths = await bob.rpc('start')
  const alicePaths = await alice.rpc('start')
  ctx.check('bob\'s default project path is his own directory', bobPaths.projectPath.endsWith(`/${PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''}`), bobPaths.projectPath)
  ctx.check('and it is his home on this host', bobPaths.homePath === bobPaths.projectPath, bobPaths.homePath)
  ctx.check('the organization owner gets a different one', alicePaths.projectPath !== bobPaths.projectPath, alicePaths.projectPath)
  const readiness = await bob.rpc('setupHostReadiness')
  ctx.check('the clone destination the dialog offers is the same workspace', readiness.projectsRoot === bobPaths.projectPath, readiness.projectsRoot)
}, { only: 'managed' })
