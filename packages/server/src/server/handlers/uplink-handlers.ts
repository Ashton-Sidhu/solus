import type { SolusServer } from '../server'
import type { UplinkLinkManager } from '../uplink/link'

/**
 * The owner's control over this host's cloud link. Every method is in
 * `LOCAL_ONLY_RPC_METHODS`: linking changes how the host is reached, so it takes a
 * trusted local connection, never a grant.
 */
export function registerUplinkHandlers(server: SolusServer, deps: { manager: UplinkLinkManager }): void {
  server.register('uplinkStatus', () => deps.manager.status())
  server.register('uplinkLink', (args) => {
    const [request] = args
    if (!request?.ticket?.trim()) throw new Error('uplinkLink requires an enrollment ticket')
    if (!request.directoryUrl?.trim()) throw new Error('uplinkLink requires the directory origin')
    return deps.manager.link({ ticket: request.ticket.trim(), directoryUrl: request.directoryUrl.trim() })
  })
  server.register('uplinkUnlink', () => deps.manager.unlink())
}
