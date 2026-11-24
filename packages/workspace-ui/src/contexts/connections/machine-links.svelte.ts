import { serverConnections, type ManagedConnection } from '@solus/client-core/server-connections'
import { canManageMachineLinks, type LinkMachine } from '@solus/client-core/host-linking'
import { SvelteMap } from 'svelte/reactivity'
import { serversStore } from './servers.store.svelte'

/** A view of the current owner connections. The connection owns each link list. */
export class MachineLinks {
  readonly machines = new SvelteMap<string, LinkMachine>()
  private readonly stops = new Map<string, () => void>()
  private readonly stop: () => void

  constructor() {
    this.stop = serverConnections.onReadinessChange((id, readiness) => {
      this.stops.get(id)?.()
      this.stops.delete(id)
      this.machines.delete(id)
      if (readiness === 'ready') this.watch(id)
    })
    for (const id of serverConnections.serverIds()) {
      if (serverConnections.readinessFor(id).readiness === 'ready') this.watch(id)
    }
  }

  private watch(id: string): void {
    const connection = serverConnections.connectionFor(id)
    if (!connection?.pairings) return
    const { pairings, facts, link } = connection
    const update = () => {
      const info = facts.value('serverInfo')
      if (!info || !canManageMachineLinks(info)) { this.machines.delete(id); return }
      const generation = link.sessionGeneration
      this.machines.set(id, {
        label: serversStore.hostFor(id)?.label ?? id,
        info,
        api: connection.api,
        snapshot: pairings.snapshot(),
        isCurrent: () => this.isCurrent(connection, generation),
      })
    }
    this.stops.set(id, () => { stopLinks(); stopFacts() })
    const stopLinks = pairings.subscribe(update)
    const stopFacts = facts.subscribe((key) => { if (key === 'serverInfo') update() })
    facts.ensure('serverInfo')
    update()
  }

  private isCurrent(connection: ManagedConnection, generation: number): boolean {
    return serverConnections.connectionFor(connection.serverId) === connection
      && connection.link.readiness === 'ready'
      && connection.link.sessionGeneration === generation
      && connection.facts.value('serverInfo')?.principal === 'local-owner'
  }

  dispose(): void {
    this.stop()
    for (const stop of this.stops.values()) stop()
  }
}
