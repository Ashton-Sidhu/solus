import { accountConnectionsUrl } from '../../vault/account-reads'
import { credentialUserFor } from '../../admission/actor'
import { grantsFor } from '../../admission/access-policy'
import { generatePairToken, listRevokedDevices, revokeDevice, getInstallationId } from '../../admission/auth'
import { discoverTailnetServers, listReachableEndpoints } from '../endpoints'
import { shareRoutesFor } from '../../sharing/share-routes'
import { shareResourceSchema, type ShareResource } from '@solus/contracts/sharing'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { bootstrapDiscoveredServerOverSsh } from '../ssh-bootstrap'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { SolusServer } from '../server'
import { hostUserKey } from '../../host/host-user'
import type { PairedHosts } from '../../execution/orchestration/paired-hosts'
import { hostDisplayName } from '../../platform/host-display-name'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): Pick<ConnectionsServerInfo, 'host' | 'port' | 'allowLan' | 'remoteAccess' | 'requireAuth' | 'trustLocalNetwork' | 'hostKind' | 'roles'>
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): ActiveConnectionSession[]
  discoverLanServers(): Promise<DiscoveredServer[]>
  setRemoteAccess(remoteAccess: boolean): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  setTrustLocalNetwork(trustLocalNetwork: boolean): { trustLocalNetwork: boolean }
  /** The hosts this host paired with (docs/plans/cross-host-sessions.md §10). */
  pairedHosts: Pick<PairedHosts, 'list' | 'pair' | 'forget'>
  /** Closes an open connection to a host whose pairing was replaced or forgotten. */
  disconnectRemoteHost(hostId: string): void
  /** This host's tunnel origin while its connector is online; null otherwise. */
  tunnelUrl(): string | null
  /** The account origin when the resource is mirrored there (a published session of an organization on a linked host); null otherwise. */
  mirrorOrigin(resource: ShareResource): Promise<string | null>
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
  server.register('connectionsGetServerInfo', (_args, ctx) => {
    const info = deps.getServerInfo()
    const principal = ctx.principal
    // What this connection may do here, so every control disables exactly when the gate would refuse (permissions.md).
    const answer: ConnectionsServerInfo = { ...info, installationId: getInstallationId(), principal: principal.kind, grants: grantsFor(principal) }
    const connectionsUrl = credentialUserFor(ctx.actor) ? accountConnectionsUrl() : null
    if (connectionsUrl) answer.accountConnectionsUrl = connectionsUrl
    // The one person the client is on this host: "is this me?" compares against it (plans/012 §1).
    if (ctx.actor.user) answer.user = ctx.actor.user
    if (principal.kind === 'remote-owner') answer.userId = principal.userId
    // The person at the machine is the host's user (plans/012 §1): the reader knows its key as their own.
    if (principal.kind === 'local-owner') answer.userId = hostUserKey()
    if (principal.kind === 'org-member') {
      answer.userId = principal.userId
      answer.organizationId = principal.organizationId
      answer.displayName = principal.displayName
    }
    if (principal.kind === 'guest') {
      // The one thing a guest client needs to know at boot: what it was let in to see.
      answer.displayName = principal.displayName
      answer.userId = principal.accountUserId
      answer.share = { resource: principal.share.resource, role: principal.share.role }
    }
    return answer
  })

  server.register('connectionsListEndpoints', async () => {
    const { host, port } = deps.getServerInfo()
    return await listReachableEndpoints(host, port)
  })

  // docs/plans/host-sharing.md §2: a mirrored session's link names the account origin,
  // which hands the guest to this host when it answers and to the mirror when it does
  // not; everything else is reached on this host alone.
  server.register('shareLinkOrigin', async (args) => {
    const resource = shareResourceSchema.parse(args[0])
    const mirror = await deps.mirrorOrigin(resource)
    if (mirror) return { origin: mirror }
    const { host, port } = deps.getServerInfo()
    return { origin: shareRoutesFor(deps.tunnelUrl(), await listReachableEndpoints(host, port))[0]?.url ?? null }
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
    captureServerEvent('pair_token_generated', {})
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

  server.register('pairedHostsList', () => deps.pairedHosts.list())

  server.register('pairedHostsPair', async (args) => {
    const [{ url, code }] = args
    // The other host lists this one under this name in its Connections.
    const paired = await deps.pairedHosts.pair({ url, code }, `${hostDisplayName()} (Solus host)`)
    deps.disconnectRemoteHost(paired.installationId)
    return paired
  })

  server.register('pairedHostsForget', (args) => {
    const [{ installationId }] = args
    const forgotten = deps.pairedHosts.forget(installationId)
    deps.disconnectRemoteHost(installationId)
    return { forgotten }
  })
}
