import { generatePairToken, listRevokedDevices, revokeDevice, getInstallationId } from '../auth'
import { discoverTailnetServers, listReachableEndpoints } from '../endpoints'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): { host: string; port: number; allowLan: boolean; remoteAccess: boolean; requireAuth: boolean }
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): ActiveConnectionSession[]
  setRemoteAccess(remoteAccess: boolean): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
}

export interface ActiveConnectionSession {
  id: string
  deviceLabel: string
  deviceId: string | null
  connectedAt: number
}

export interface AggregatedConnectionSession extends ActiveConnectionSession {
  connectionCount: number
  connectionIds: string[]
}

export function aggregateConnectionSessionsByDevice(sessions: ActiveConnectionSession[]): AggregatedConnectionSession[] {
  const grouped = new Map<string, AggregatedConnectionSession>()

  for (const session of sessions) {
    const key = session.deviceId ? `device:${session.deviceId}` : `connection:${session.id}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        id: session.deviceId ? key : session.id,
        deviceLabel: session.deviceLabel,
        deviceId: session.deviceId,
        connectedAt: session.connectedAt,
        connectionCount: 1,
        connectionIds: [session.id],
      })
      continue
    }

    existing.connectionCount += 1
    existing.connectionIds.push(session.id)
    existing.connectedAt = Math.min(existing.connectedAt, session.connectedAt)
  }

  return [...grouped.values()].sort((a, b) => a.connectedAt - b.connectedAt)
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

  server.register('discoverServers', () => {
    const { port } = deps.getServerInfo()
    return discoverTailnetServers({ boundPort: port, ownInstallationId: getInstallationId() })
  })

  server.register('connectionsGeneratePairToken', () => {
    const t = generatePairToken()
    log.info(`generated pair token (code=${t.code}, expires in 5m)`)
    return t
  })

  server.register('connectionsListSessions', () => {
    return aggregateConnectionSessionsByDevice(deps.getActiveSessions())
  })

  server.register('connectionsRevokeDevice', (args) => {
    const [{ deviceId }] = args as [{ deviceId: string }]
    revokeDevice(deviceId)
    return { ok: true, revoked: listRevokedDevices() }
  })

  server.register('connectionsSetRemoteAccess', async (args) => {
    const [{ remoteAccess }] = args as [{ remoteAccess: boolean }]
    return deps.setRemoteAccess(remoteAccess === true)
  })
}
