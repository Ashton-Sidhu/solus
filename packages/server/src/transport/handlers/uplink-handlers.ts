import type { UplinkStatus } from '@solus/contracts/uplink'
import type { HostRegistrar } from '../../host/host-registration'
import type { SolusServer } from '../server'
import type { UplinkLinkManager } from '../uplink/link'

/**
 * The owner's control over this host's registration and its link. Every method is in
 * `host.local.reach` (permissions.md): it takes a trusted local connection, never a
 * grant. `uplinkRegister` registers the host to the owner's account (ADR 0001 §2.2
 * rule 8), or on a registered host redeems an organization-bound code as an attachment
 * (organization-vms §4). `uplinkLink` and `uplinkUnlink` turn the tunnel on and off
 * (rule 9), and change nothing else.
 */
export function registerUplinkHandlers(server: SolusServer, deps: { registrar: HostRegistrar; manager: UplinkLinkManager; status: () => UplinkStatus }): void {
  server.register('uplinkStatus', () => deps.status())
  server.register('uplinkRegister', async (args) => {
    const [request] = args
    if (!request?.ticket?.trim()) throw new Error('uplinkRegister requires an enrollment ticket')
    if (!request.directoryUrl?.trim()) throw new Error('uplinkRegister requires the directory origin')
    await deps.registrar.register({
      ticket: request.ticket.trim(),
      directoryUrl: request.directoryUrl.trim(),
      ...(request.organizationIds?.length ? { organizationIds: request.organizationIds } : {}),
    })
    return deps.status()
  })
  server.register('uplinkLink', async () => {
    await deps.manager.link()
    return deps.status()
  })
  server.register('uplinkUnlink', async () => {
    await deps.manager.unlink()
    return deps.status()
  })
  server.register('uplinkDetachOrganization', async (args) => {
    const [organizationId] = args
    if (!organizationId?.trim()) throw new Error('uplinkDetachOrganization requires an organization')
    await deps.registrar.detach(organizationId.trim())
    return deps.status()
  })
}
