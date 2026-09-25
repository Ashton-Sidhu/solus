import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { savedCloudServerIds } from '@solus/client-core/server-registry'
import { ALL_HOST_ROLES, COLLABORATION_ONLY_ROLES, hostRolesOf, type HostRole } from '@solus/client-core/host-roles'

/**
 * Which planes each host serves (docs/plans/cloud-service-model.md). Read from
 * `connectionsGetServerInfo` as each host connects; until a host answers, a cloud
 * directory row is collaboration-only and every other host serves both. A host
 * without `execution` never appears where work is started or a checkout is read;
 * a host without `collaboration` never appears where tasks, works, or shares are.
 */
const NO_HOST_ROLES: readonly HostRole[] = []

class HostRolesStore {
  private readonly rolesByServer = new SvelteMap<string, readonly HostRole[]>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor() {
    serverConnections.onConnectionCreated((connection) => {
      void this.load(connection.serverId)
    })
    serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') void this.load(serverConnections.resolveId(serverId))
    })
    queueMicrotask(() => {
      for (const serverId of serverConnections.connectedServerIds()) void this.load(serverId)
    })
  }

  rolesFor(serverId: string | null | undefined): readonly HostRole[] {
    if (!serverId) return ALL_HOST_ROLES
    const resolved = serverConnections.resolveId(serverId)
    return this.rolesByServer.get(resolved) ?? this.assumedRolesFor(resolved)
  }

  hasExecution(serverId: string | null | undefined): boolean {
    return this.rolesFor(serverId).includes('execution')
  }

  hasCollaboration(serverId: string | null | undefined): boolean {
    return this.rolesFor(serverId).includes('collaboration')
  }

  /** The tests seed a host's answer without a connection. */
  accept(serverId: string, roles: readonly HostRole[]): void {
    this.rolesByServer.set(serverId, roles)
  }

  /** A host this client does not know — deleted, or never listed here — serves
   *  nothing, so no gate offers work or records on it
   *  (docs/plans/workspace-and-machines.md §6). */
  private assumedRolesFor(serverId: string): readonly HostRole[] {
    if (savedCloudServerIds().has(serverId)) return COLLABORATION_ONLY_ROLES
    return serverConnections.isKnownServer(serverId) ? ALL_HOST_ROLES : NO_HOST_ROLES
  }

  private load(serverId: string): Promise<void> {
    const pending = this.inFlight.get(serverId)
    if (pending) return pending
    // Inside the chain, so an older host or a narrower test double without the
    // method is a caught rejection, never a throw out of a status listener.
    const promise = Promise.resolve()
      .then(() => serverConnections.apiFor(serverId).connectionsGetServerInfo())
      .then((info) => {
        this.rolesByServer.set(serverId, hostRolesOf(info, this.assumedRolesFor(serverId)))
      })
      .catch(() => {
        // A host that cannot say keeps what the registry assumed of it.
      })
      .finally(() => {
        if (this.inFlight.get(serverId) === promise) this.inFlight.delete(serverId)
      })
    this.inFlight.set(serverId, promise)
    return promise
  }
}

export const hostRolesStore = new HostRolesStore()
