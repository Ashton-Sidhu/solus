import { serverConnections } from './server-connections'
import { LOCAL_SERVER_ID } from './server-registry'

/** Client policy stays separate from host-advertised feature support. On web,
 * the primary host is the client machine because no desktop-local target is
 * registered; `resolveId` already owns that distinction. */
export const hostPolicy = {
  isClientMachine(serverId: string | null | undefined): boolean {
    if (!serverId) return false
    return serverConnections.resolveId(serverId) === serverConnections.resolveId(LOCAL_SERVER_ID)
  },
}
