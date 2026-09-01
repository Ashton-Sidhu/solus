import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID, loadServers } from '@client-core/server-registry'
import type { ProjectIdentity } from '../../../../shared/types'
import type { SessionHistorySource } from '../../../lib/sessionPickerHistory'
import { repoKeyForPath } from '../../servers/run-on'

export interface RemoteHistoryHosts {
  /** This client's own host, which the picker already scans directly. */
  localServerId: string
  /** Every other saved host, whether or not it currently holds a tab. */
  remoteServerIds(): string[]
  projectIdentities(serverId: string): Promise<ProjectIdentity[]>
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
  const serverIds = hosts.remoteServerIds()
  if (serverIds.length === 0 || projectRoots.length === 0) return []

  const localIdentities = await hosts.projectIdentities(hosts.localServerId).catch(() => [])
  const repoKeys = new Set(
    projectRoots
      .map((root) => repoKeyForPath(localIdentities, root))
      .filter((repoKey): repoKey is string => !!repoKey),
  )
  if (repoKeys.size === 0) return []

  const perHost = await Promise.all(
    serverIds.map(async (serverId) => {
      try {
        if (!(await hosts.isReachable(serverId))) return []
        const identities = await hosts.projectIdentities(serverId)
        return identities
          .filter((identity) => repoKeys.has(identity.repoKey))
          .map((identity) => ({
            id: `${serverId}:${identity.path}`,
            serverId,
            projectPath: identity.path,
          }))
      } catch {
        // One unreachable or unauthorised host must not cost the others their rows.
        return []
      }
    }),
  )
  return perHost.flat()
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
    isReachable: async (serverId) => !!(await serverConnections.probeHealth(serverId)),
  }
}
