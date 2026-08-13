import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID, loadServers } from '@client-core/server-registry'
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
): Promise<SessionHistorySource[]> {
  const sources = (await Promise.all(remoteHistorySourceBatches(hosts, projectRoots))).flat()
  return [...new Map(sources.map((source) => [source.id, source])).values()]
}

/** Resolve each host independently so an asleep saved host cannot delay a
 * connected host's rows. Dispatch roots and normal projects are also separate:
 * the focused exact-path RPC should not wait for a large project manifest. */
export function remoteHistorySourceBatches(
  hosts: RemoteHistoryHosts,
  projectRoots: string[],
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
    const source = (projectPath: string): SessionHistorySource => ({
      id: `${serverId}:${projectPath}`,
      serverId,
      projectPath,
    })
    return [
      (async () => {
        const [isReachable, keys] = await Promise.all([reachable, repoKeys])
        if (!isReachable || keys.size === 0) return []
        const roots = await hosts.dispatchHistoryRoots(serverId, [...keys]).catch(() => [])
        return roots.filter((root) => keys.has(root.repoKey)).map((root) => source(root.path))
      })(),
      (async () => {
        const [isReachable, keys] = await Promise.all([reachable, repoKeys])
        if (!isReachable || keys.size === 0) return []
        const identities = await hosts.projectIdentities(serverId).catch(() => [])
        return identities.filter((identity) => keys.has(identity.repoKey)).map((identity) => source(identity.path))
      })(),
    ].map((batch) => batch.catch(() => []))
  })
}

/** The saved hosts, bound to the live connection registry. */
export function savedRemoteHistoryHosts(): RemoteHistoryHosts {
  // On web no host is "local": the primary connection plays that role, and it
  // must not be scanned twice.
  const localServerId = serverConnections.resolveId(LOCAL_SERVER_ID)
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
