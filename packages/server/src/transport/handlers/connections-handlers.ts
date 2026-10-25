import { accountConnectionsUrl } from '../../vault/account-reads'
import { ownerKeyOf } from '../../admission/actor'
import { credentialLocationOf } from '../../vault/vault'
import { permissionsFor } from '../../admission/access-policy'
import { wirePrincipalKind } from '../../admission/principal'
import { generatePairToken, listRevokedDevices, revokeDevice, getInstallationId } from '../../admission/auth'
import { advertisedRoutes, discoverTailnetServers, listReachableEndpoints } from '../endpoints'
import { hostIdentity } from '../../host/host-identity'
import { shareRoutesFor } from '../../sharing/share-routes'
import { shareResourceSchema, type ShareResource } from '@solus/contracts/sharing'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { SolusServer } from '../server'
import { hostUserKey } from '../../host/host-user'
import { memberUsers } from '../../host/member-users'
import { recentEventLoopStall } from '../../host/event-loop-stalls'
import type { IntroducedHosts } from '../../execution/orchestration/introduced-hosts'
import { z } from 'zod'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): Pick<ConnectionsServerInfo, 'host' | 'port' | 'allowLan' | 'remoteAccess' | 'requireAuth' | 'trustLocalNetwork' | 'hostKind' | 'roles'>
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): ActiveConnectionSession[]
  discoverLanServers(): Promise<DiscoveredServer[]>
  setRemoteAccess(remoteAccess: boolean): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  setTrustLocalNetwork(trustLocalNetwork: boolean): { trustLocalNetwork: boolean }
  /** The hosts this host was introduced to (docs/plans/host-reach.md §4). */
  introducedHosts: Pick<IntroducedHosts, 'list' | 'issue' | 'accept' | 'forget' | 'allow'>
  /** Closes an open connection to a host whose introduction was replaced or forgotten. */
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
  server.register('connectionsGetServerInfo', async (_args, ctx) => {
    const info = deps.getServerInfo()
    const principal = ctx.principal
    // What this connection may do here, so every control disables exactly when the gate would refuse (permissions.md).
    const answer: ConnectionsServerInfo = {
      ...info,
      installationId: getInstallationId(),
      routes: await advertisedRoutes(info.host, info.port),
      identityKey: hostIdentity().publicKey(),
      principal: wirePrincipalKind(principal),
      permissions: permissionsFor(principal),
    }
    const connectionsUrl = credentialLocationOf(ownerKeyOf(ctx.actor)).kind === 'account' ? accountConnectionsUrl() : null
    if (connectionsUrl) answer.accountConnectionsUrl = connectionsUrl
    // The one person the client is on this host: "is this me?" compares against it (plans/012 §1).
    if (ctx.actor.user) answer.user = ctx.actor.user
    if (principal.kind === 'owner') {
      // The person at the machine is the host's user (plans/012 §1): the reader knows its key as their own.
      answer.userId = principal.via === 'grant' ? principal.userId : hostUserKey()
    }
    if (principal.kind === 'org-member') {
      answer.userId = principal.userId
      answer.organizationId = principal.organizationId
      answer.displayName = principal.displayName
      // The host object has not made their Linux user yet (docs/plans/member-isolation.md §8.1).
      const users = memberUsers()
      if (users && !users.userOf(principal.userId)) answer.memberWorkspace = 'preparing'
    }
    if (principal.kind === 'guest') {
      // The one thing a guest client needs to know at boot: what it was let in to see.
      answer.displayName = principal.displayName
      answer.userId = principal.accountUserId
      answer.share = { resource: principal.share.resource, role: principal.share.role }
    }
    // A client that just came back after a drop learns if this host froze (docs/mobile-connections.md).
    const stall = recentEventLoopStall()
    if (stall) answer.recentEventLoopStall = stall
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

  server.register('hostIntroductionsList', () => deps.introducedHosts.list())

  server.register('hostIntroductionIssue', (args) => {
    const [forHost] = args
    return deps.introducedHosts.issue(forHostSchema.parse(forHost))
  })

  server.register('hostIntroductionAccept', async (args) => {
    const [{ introduction, grantedDeviceId }] = args
    const parsed = introductionSchema.parse(introduction)
    await deps.introducedHosts.accept(parsed, z.string().min(1).parse(grantedDeviceId))
    deps.disconnectRemoteHost(parsed.installationId)
    return { ok: true as const }
  })

  server.register('hostIntroductionForget', (args) => {
    const [{ installationId }] = args
    const forgotten = deps.introducedHosts.forget(installationId)
    deps.disconnectRemoteHost(installationId)
    return { forgotten }
  })

  server.register('hostIntroductionAllow', (args) => {
    const [{ installationId }] = args
    return { allowed: deps.introducedHosts.allow(installationId) }
  })
}

const forHostSchema = z.object({ installationId: z.string().min(1), label: z.string().max(128) })
const introductionSchema = z.object({
  installationId: z.string().min(1),
  label: z.string().max(128),
  urls: z.array(z.string().min(1)).max(16),
  sessionToken: z.string().min(1),
  deviceId: z.string().min(1),
  identityKey: hostIdentityKeySchema,
})
