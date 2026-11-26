import { enforce, hostPolicies } from '../../host/policy/host-policy-store'
import type { HostSelfTest } from '@solus/contracts/host-connection'
import type { HostRegistrationRequest, UplinkStatus } from '@solus/contracts/uplink'
import type { HostRegistrar } from '../../host/host-registration'
import type { SolusServer } from '../server'
import { registerAndLink, type UplinkLinkManager } from '../uplink/link'

/**
 * The owner's control over this host's registration and its link. Every method is in
 * `host.local.reach` (permissions.md): it takes a trusted local connection, never a
 * grant. `uplinkRegister` registers the host to the owner's account (ADR 0001 §2.2
 * rule 8) and links a new registration (rule 9). A ticket that names an organization
 * makes this machine a cloud machine of it (plans/034-one-cloud-machine-kind.md §3),
 * and after that these methods are refused here. `uplinkLink` and `uplinkUnlink` turn
 * the tunnel on and off, and change nothing else.
 */
export interface UplinkHandlerDeps {
  registrar: HostRegistrar
  manager: UplinkLinkManager
  status: () => UplinkStatus
  selfTest: () => Promise<HostSelfTest>
  /**
   * This call made the server a cloud machine, and nobody owns it now: the connections that
   * it admitted as its owner before, the caller's included, must end after the answer went out.
   */
  onBecameCloudMachine: () => void
}

export function registerUplinkHandlers(server: SolusServer, deps: UplinkHandlerDeps): void {
  server.register('uplinkStatus', () => deps.status())
  server.register('hostSelfTest', () => deps.selfTest())
  server.register('uplinkRegister', async (args) => {
    const [request] = args
    if (!request?.ticket?.trim()) throw new Error('uplinkRegister requires an enrollment ticket')
    if (!request.directoryUrl?.trim()) throw new Error('uplinkRegister requires the directory origin')
    const registration: HostRegistrationRequest = { ticket: request.ticket.trim(), directoryUrl: request.directoryUrl.trim() }
    if (request.address?.trim()) registration.address = request.address.trim()
    if (request.link === false) registration.link = false
    await registerAndLink(deps.registrar, deps.manager, registration)
    if (deps.registrar.current()?.organizationId) deps.onBecameCloudMachine()
    return deps.status()
  })
  server.register('uplinkLink', async () => {
    enforce(hostPolicies().capabilityDenial('cloudTunnel', 'the Solus Cloud tunnel'))
    await deps.manager.link()
    return deps.status()
  })
  server.register('uplinkUnlink', async () => {
    await deps.manager.unlink()
    return deps.status()
  })
}
