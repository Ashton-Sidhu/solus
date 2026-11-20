import { TasksStore } from '@solus/client-core/tasks-store'
import type { PersonalSettings } from '@solus/contracts/settings'
import type { AccountSession } from '../account/account-session'
import type { HostConnections } from '../hosts/host-connections'
import type { HostRegistry } from '../hosts/host-registry'

interface TasksStoreContext {
  connections: Pick<HostConnections, 'connection'>
  personal: { current(): Pick<PersonalSettings, 'taskSources'> }
  account: Pick<AccountSession, 'syncAccount' | 'organizationId' | 'changes'>
  registry: Pick<HostRegistry, 'hosts' | 'changes'>
}

const stores = new WeakMap<TasksStoreContext, Map<string, TasksStore>>()

/** Shared task state, created on first use. The Tasks feature owns its lifetime. */
export function tasksStoreFor(context: TasksStoreContext, hostId: string): TasksStore {
  let byHost = stores.get(context)
  if (!byHost) {
    byHost = new Map()
    stores.set(context, byHost)
    const owned = byHost
    const identity = () =>
      JSON.stringify([context.account.syncAccount, context.account.organizationId])
    let accountKey = identity()
    context.account.changes.subscribe(() => {
      const next = identity()
      if (next === accountKey) return
      accountKey = next
      for (const store of owned.values()) store.reset()
    })
    context.registry.changes.subscribe(() => {
      const hosts = new Set(context.registry.hosts().map((host) => host.id))
      for (const [id, store] of owned) {
        if (hosts.has(id)) continue
        store.reset()
        owned.delete(id)
      }
    })
  }
  let store = byHost.get(hostId)
  if (!store) {
    store = new TasksStore(
      () => {
        const connection = context.connections.connection(hostId)
        if (!connection || connection.state.readiness !== 'ready')
          throw new Error('The task host is disconnected.')
        return connection.api
      },
      () => context.personal.current().taskSources
    )
    byHost.set(hostId, store)
  }
  return store
}
