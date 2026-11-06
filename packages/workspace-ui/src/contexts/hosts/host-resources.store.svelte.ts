import { EMPTY_HOST_RESOURCE_VIEW, HostResourceWatch, type HostResourceView } from '@solus/client-core/host-resource-watch'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteMap } from 'svelte/reactivity'
import { hosts } from './hosts.svelte'

interface Held {
  holders: number
  watch: HostResourceWatch
}

/** What the Resources tab shows of each host. A host's watch runs only while a
 *  surface holds it, so a closed page costs the host nothing. */
class HostResourcesStore {
  readonly #views = new SvelteMap<string, HostResourceView>()
  readonly #held = new Map<string, Held>()

  viewFor(serverId: string): HostResourceView {
    return this.#views.get(serverId) ?? EMPTY_HOST_RESOURCE_VIEW
  }

  /** Hold the host's watch. Call the result to let it go. */
  retain(serverId: string): () => void {
    let held = this.#held.get(serverId)
    if (!held) {
      held = {
        holders: 0,
        watch: new HostResourceWatch({
          api: serverConnections.apiFor(serverId),
          events: serverConnections.eventsFor(serverId),
          mayReadProcesses: () => hosts.get(serverId).me.may('host.admin'),
          onChange: (view) => this.#views.set(serverId, view),
        }),
      }
      this.#held.set(serverId, held)
      held.watch.start()
    }
    held.holders += 1
    return () => {
      const current = this.#held.get(serverId)
      if (!current || --current.holders > 0) return
      current.watch.stop()
      this.#held.delete(serverId)
      this.#views.delete(serverId)
    }
  }
}

export const hostResourcesStore = new HostResourcesStore()
