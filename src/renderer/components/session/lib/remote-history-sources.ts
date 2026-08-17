import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID, loadServers } from '@client-core/server-registry'
import { sessionSnapshotCache, type SessionSnapshotCache } from '@client-core/session-snapshot-cache'
import type { DispatchHistoryRoot, ProjectIdentity } from '../../../../shared/types'
import type { SessionHistorySource } from '../../../lib/sessionPickerHistory'
import { repoKeyForPath } from '../../servers/run-on'

export interface RemoteHistoryHosts {
  /** This client's own host, which the picker already scans directly. */
  localServerId: string
  /** Every other saved host, whether or not it currently holds a tab. */
  remoteServerIds(): string[]
  projectIdentities(serverId: string): Promise<ProjectIdentity[]>
  dispatchHistoryRoots(serverId: string, repoKeys: string[]): Promise<DispatchHistoryRoot[]>
  /** False for a host that is asleep or unreachable, so the scan skips it
   *  instead of waiting on a socket that will only ever retry. */
  isReachable(serverId: string): Promise<boolean>
}

/**
 * The paths on other hosts that hold the projects this picker is scoped to.
 *
 * A session lives on the machine it was created on, so "Run on host" work
 * disappears from history the moment its tab closes unless the picker asks that
 * host as well. Repositories are matched by `repoKey` rather than path, because
 * the same checkout is `/Users/me/solus` here and `/home/me/solus` there. A host
 * that has never held one of these repositories yields no source, and therefore
 * costs no session request at all.
 */
export async function remoteHistorySources(
  hosts: RemoteHistoryHosts,
  projectRoots: string[],
  snapshotCache: SessionSnapshotCache = sessionSnapshotCache,
): Promise<SessionHistorySource[]> {
  const sources = (await Promise.all(remoteHistorySourceBatches(hosts, projectRoots, snapshotCache))).flat()
  return [...new Map(sources.map((source) => [source.id, source])).values()]
}

/** Resolve each host independently so an asleep saved host cannot delay a
 * connected host's rows. Dispatch roots and normal projects are also separate:
 * the focused exact-path RPC should not wait for a large project manifest. */
export function remoteHistorySourceBatches(
  hosts: RemoteHistoryHosts,
  projectRoots: string[],
  snapshotCache: SessionSnapshotCache = sessionSnapshotCache,
): Array<Promise<SessionHistorySource[]>> {
  const serverIds = hosts.remoteServerIds()
  if (serverIds.length === 0 || projectRoots.length === 0) return []

  const repoKeys = hosts.projectIdentities(hosts.localServerId)
    .catch(() => [])
    .then((localIdentities) => new Set(
      projectRoots
        .map((root) => repoKeyForPath(localIdentities, root))
        .filter((repoKey): repoKey is string => !!repoKey),
    ))

  return serverIds.flatMap((serverId) => {
    const reachable = hosts.isReachable(serverId).catch(() => false)
    const source = (projectPath: string, repoKey?: string): SessionHistorySource => ({
      id: `${serverId}:${projectPath}`,
      serverId,
      projectPath,
      repoKey,
    })
    return [
      (async () => {
        const [isReachable, keys] = await Promise.all([reachable, repoKeys])
        if (keys.size === 0) return []
        // An unreachable host still names its last-known sources so the list
        // can render its snapshot — without waiting on a socket that will
        // only ever retry (dispatch-client step 2, aggregation decision 4).
        if (!isReachable) {
          return snapshotCache
            .cachedSourcesForRepoKeys(serverId, keys)
            .map((cached) => ({ ...cached, serverId, cachedOnly: true }))
        }
        const roots = await hosts.dispatchHistoryRoots(serverId, [...keys]).catch(() => [])
        return roots.filter((root) => keys.has(root.repoKey)).map((root) => source(root.path, root.repoKey))
      })(),
      (async () => {
        const [isReachable, keys] = await Promise.all([reachable, repoKeys])
        if (!isReachable || keys.size === 0) return []
        const identities = await hosts.projectIdentities(serverId).catch(() => [])
        return identities.filter((identity) => keys.has(identity.repoKey)).map((identity) => source(identity.path, identity.repoKey))
      })(),
    ].map((batch) => batch.catch(() => []))
  })
}

/** The saved hosts, bound to the live connection registry. */
export function savedRemoteHistoryHosts(): RemoteHistoryHosts {
  // The host the picker already scans directly — the client's own machine
  // when it has one, else the new-work default — must not be scanned twice.
  const localServerId = serverConnections.localServerId()
    ?? serverConnections.defaultServerId()
    ?? LOCAL_SERVER_ID
  return {
    localServerId,
    remoteServerIds: () =>
      loadServers()
        .map((server) => server.id)
        .filter((serverId) => serverId !== localServerId),
    projectIdentities: (serverId) => serverConnections.projectIdentities(serverId),
    dispatchHistoryRoots: (serverId, repoKeys) =>
      serverConnections.apiFor(serverId).resolveDispatchHistoryRoots(repoKeys),
    isReachable: async (serverId) =>
      serverConnections.statusFor(serverId) === 'connected'
      || !!(await serverConnections.probeHealth(serverId)),
  }
}
