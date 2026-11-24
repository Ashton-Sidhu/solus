import { serverConnections, type ManagedConnection } from '@solus/client-core/server-connections'
import { canManageMachineLinks, machineLinksHidden, type LinkMachine, type MachineLinksHidden } from '@solus/client-core/host-linking'
import type { HostLinkHealth } from '@solus/contracts/host-pairing'
import { SvelteMap } from 'svelte/reactivity'
import { serversStore } from './servers.store.svelte'

/** Link health moves slowly, and each read asks every linked machine whether it answers. */
const HEALTH_REFRESH_MS = 30_000

/**
 * A view of the current owner connections. The connection owns each link list.
 * It also says why the links of each other host are not shown
 * (docs/host-pairing.md), and, while a surface holds it, how each link is doing.
 */
export class MachineLinks {
  readonly machines = new SvelteMap<string, LinkMachine>()
  /** By server id: why the links that host holds are not shown. */
  readonly hidden = new SvelteMap<string, MachineLinksHidden>()
  /** By the installation id of the machine that holds the links: its last health read, or `unavailable` when it cannot give one. */
  readonly health = new SvelteMap<string, HostLinkHealth[] | 'unavailable'>()
  private readonly stops = new Map<string, () => void>()
  private readonly stop: () => void
  private healthTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.stop = serverConnections.onReadinessChange((id, readiness) => {
      this.stops.get(id)?.()
      this.stops.delete(id)
      this.machines.delete(id)
      if (readiness === 'ready') this.watch(id)
      else this.hidden.set(id, 'disconnected')
    })
    for (const id of serverConnections.serverIds()) {
      if (serverConnections.readinessFor(id).readiness === 'ready') this.watch(id)
      else this.hidden.set(id, 'disconnected')
    }
  }

  private watch(id: string): void {
    const connection = serverConnections.connectionFor(id)
    if (!connection?.pairings) { this.hidden.set(id, 'not-owner'); return }
    const { pairings, facts, link } = connection
    const update = () => {
      const info = facts.value('serverInfo') ?? null
      const reason = machineLinksHidden({ isConnected: true, info, hasSnapshot: !!pairings.snapshot(), hasReadFailed: pairings.hasReadFailed() })
      if (reason) this.hidden.set(id, reason)
      else this.hidden.delete(id)
      if (!info || !canManageMachineLinks(info)) { this.machines.delete(id); return }
      const generation = link.sessionGeneration
      this.machines.set(id, {
        label: serversStore.hostFor(id)?.label ?? id,
        info,
        api: connection.api,
        snapshot: pairings.snapshot(),
        isCurrent: () => this.isCurrent(connection, generation),
      })
      // A new link, or a newly connected machine, gets its health without waiting for the next read.
      if (this.healthTimer) void this.readHealth(id)
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

  /** Reads the health of every link until the result is called: only while a surface shows it. */
  holdHealth(): () => void {
    if (this.healthTimer) return () => {}
    this.healthTimer = setInterval(() => void this.readAllHealth(), HEALTH_REFRESH_MS)
    void this.readAllHealth()
    return () => {
      if (this.healthTimer) clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  /** Reads the links' health again now, as after Retry. */
  refreshHealth(): void {
    void this.readAllHealth()
  }

  private async readAllHealth(): Promise<void> {
    await Promise.all([...this.machines.keys()].map((id) => this.readHealth(id)))
  }

  /** A read for a connection that changed meanwhile is dropped: its answer is about another session. */
  private async readHealth(id: string): Promise<void> {
    const machine = this.machines.get(id)
    if (!machine?.snapshot?.hosts.length) {
      if (machine) this.health.delete(machine.info.installationId)
      return
    }
    try {
      const health = await machine.api.hostsLinkHealth()
      if (machine.isCurrent() && this.machines.get(id) === machine) this.health.set(machine.info.installationId, health)
    } catch {
      // An older host has no health read, or the read failed: its links say that their health is unknown.
      if (machine.isCurrent() && this.machines.get(id) === machine) this.health.set(machine.info.installationId, 'unavailable')
    }
  }

  dispose(): void {
    this.stop()
    for (const stop of this.stops.values()) stop()
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }
}
