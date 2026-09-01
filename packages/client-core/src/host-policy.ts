import { serverConnections } from './server-connections'

/** Client policy stays separate from host-advertised feature support. Only
 * the desktop's registered local target is the client machine; on web nothing
 * is — a browser cannot reveal files in Finder or open a local terminal, and
 * pretending the serving host was "local" made those actions lie
 * (dispatch-client step 5). */
export const hostPolicy = {
  isClientMachine(serverId: string | null | undefined): boolean {
    if (!serverId) return false
    const localServerId = serverConnections.localServerId()
    return !!localServerId && serverConnections.resolveId(serverId) === localServerId
  },
}
