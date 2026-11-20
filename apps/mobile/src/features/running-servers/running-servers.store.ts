import { RunningServersStore } from '@solus/client-core/running-servers'
import type { HostConnections } from '../hosts/host-connections'

/** Feature state is scoped to a connection owner, without adding domain state to SolusApp. */
class RunningServersRegistry {
  private readonly owners = new WeakMap<HostConnections, Map<string, RunningServersStore>>()
  forHost(connections: HostConnections, hostId: string): RunningServersStore {
    let stores = this.owners.get(connections)
    if (!stores) { stores = new Map(); this.owners.set(connections, stores) }
    let store = stores.get(hostId)
    if (!store) {
      store = new RunningServersStore(() => {
        const connection = connections.connection(hostId)
        return connection ? { api: connection.api, events: connection.events, ready: connection.state.readiness === 'ready' } : null
      }, (changed) => connections.changes.subscribe(changed))
      stores.set(hostId, store)
    }
    return store
  }
}
export const runningServers = new RunningServersRegistry()
