import { generatePairToken, listRevokedDevices, revokeDevice, getInstallationId } from '../auth'
import { listReachableEndpoints } from '../endpoints'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): { host: string; port: number; allowLan: boolean }
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): Array<{ id: string; deviceLabel: string; deviceId: string | null; connectedAt: number }>
}

export function registerConnectionsHandlers(server: SolusServer, deps: ConnectionsDeps): void {
  server.register('connectionsGetServerInfo', () => {
    const info = deps.getServerInfo()
    return { ...info, installationId: getInstallationId() }
  })

  server.register('connectionsListEndpoints', () => {
    const { host, port } = deps.getServerInfo()
    return listReachableEndpoints(host, port)
  })

  server.register('connectionsGeneratePairToken', () => {
    const t = generatePairToken()
    log.info(`generated pair token (code=${t.code}, expires in 5m)`)
    return t
  })

  server.register('connectionsListSessions', () => {
    return deps.getActiveSessions()
  })

  server.register('connectionsRevokeDevice', (args) => {
    const [{ deviceId }] = args as [{ deviceId: string }]
    revokeDevice(deviceId)
    return { ok: true, revoked: listRevokedDevices() }
  })
}
