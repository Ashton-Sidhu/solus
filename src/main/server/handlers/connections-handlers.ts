import { generatePairToken, listRevokedDevices, revokeDevice, getInstallationId } from '../auth'
import { discoverTailnetServers, listReachableEndpoints } from '../endpoints'
import { createLogger } from '../../logger'
import { bootstrapDiscoveredServerOverSsh } from '../ssh-bootstrap'
import type { DiscoveredServer } from '../../../shared/types'
import type { SolusServer } from '../server'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): { host: string; port: number; allowLan: boolean; remoteAccess: boolean; requireAuth: boolean; trustLocalNetwork: boolean }
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): ActiveConnectionSession[]
  discoverLanServers(): Promise<DiscoveredServer[]>
  setRemoteAccess(remoteAccess: boolean): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  setTrustLocalNetwork(trustLocalNetwork: boolean): { trustLocalNetwork: boolean }
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

  server.register('connectionsListEndpoints', async () => {
    const { host, port } = deps.getServerInfo()
    return await listReachableEndpoints(host, port)
  })

  server.register('discoverServers', async () => {
    const { port } = deps.getServerInfo()
    const [lan, tailnet] = await Promise.all([
      deps.discoverLanServers(),
      discoverTailnetServers({ boundPort: port, ownInstallationId: getInstallationId() }),
    ])
    const discovered = new Map<string, DiscoveredServer>()
    for (const candidate of [...tailnet, ...lan]) {
      if (!discovered.has(candidate.installationId)) discovered.set(candidate.installationId, candidate)
    }
    return [...discovered.values()]
  })

  server.register('connectionsGeneratePairToken', () => {
    const t = generatePairToken()
    log.info('pair_token_generated', { code: t.code, expiresInMinutes: 5 })
    return t
  })

  server.register('connectionsListSessions', () => {
    return aggregateConnectionSessionsByDevice(deps.getActiveSessions())
  })

  server.register('connectionsBootstrapDiscoveredServer', (args, ctx) => {
    if (!ctx.deviceId) throw new Error('SSH bootstrap requires an authenticated device.')
    const [input] = args
    return bootstrapDiscoveredServerOverSsh(input)
  })

  server.register('connectionsRevokeDevice', (args) => {
    const [{ deviceId }] = args
    revokeDevice(deviceId)
    return { ok: true, revoked: listRevokedDevices() }
  })

  server.register('connectionsSetRemoteAccess', async (args) => {
    const [{ remoteAccess }] = args
    return deps.setRemoteAccess(remoteAccess === true)
  })

  server.register('connectionsSetTrustLocalNetwork', (args) => {
    const [{ trustLocalNetwork }] = args
    return deps.setTrustLocalNetwork(trustLocalNetwork === true)
  })
}
