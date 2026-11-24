import type { HostLinkHealth } from '@solus/contracts/host-pairing'
import type { LinkMachine } from '@solus/client-core/host-linking'
import { Listeners } from '../../lib/listeners'

/** How often a shown link is checked; each read makes the host call each linked machine. */
export const LINK_HEALTH_INTERVAL_MS = 30_000

export type LinkHealthRead = readonly HostLinkHealth[] | 'unavailable'

/**
 * The health of the machine links that a screen shows (docs/host-pairing.md,
 * "Link health"). It reads only the machines that a screen watches, and only
 * while one watches: each read makes the host call every machine it links to.
 * A read from a connection that changed is dropped. A failed read is
 * `unavailable` (an older host), so the link shows "Health unknown", not a
 * check that never ends.
 */
export class LinkHealthReader {
  private health: ReadonlyMap<string, LinkHealthRead> = new Map()
  private readonly watched = new Map<string, number>()
  private readonly reading = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  readonly changes = new Listeners()

  constructor(private readonly deps: {
    machines(): readonly LinkMachine[]
    intervalMs?: number
    setIntervalFn?: typeof setInterval
    clearIntervalFn?: typeof clearInterval
  }) {}

  /** The last read of each watched machine, by its installation id. A new map after each change. */
  current = (): ReadonlyMap<string, LinkHealthRead> => this.health

  /** Reads the machines now and then at each interval, until the returned stop. */
  watch(installationIds: readonly string[]): () => void {
    for (const id of installationIds) this.watched.set(id, (this.watched.get(id) ?? 0) + 1)
    this.timer ??= (this.deps.setIntervalFn ?? setInterval)(() => void this.read(), this.deps.intervalMs ?? LINK_HEALTH_INTERVAL_MS)
    void this.read(installationIds)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      for (const id of installationIds) {
        const count = (this.watched.get(id) ?? 0) - 1
        if (count > 0) this.watched.set(id, count)
        else this.watched.delete(id)
      }
      if (this.watched.size === 0 && this.timer !== null) {
        (this.deps.clearIntervalFn ?? clearInterval)(this.timer)
        this.timer = null
      }
    }
  }

  async read(installationIds: readonly string[] = [...this.watched.keys()]): Promise<void> {
    const machines = this.deps.machines()
    await Promise.all(installationIds.map(async (id) => {
      const machine = machines.find(({ info }) => info.installationId === id)
      if (!machine) return this.set(id, undefined)
      if (this.reading.has(id) || !machine.isCurrent()) return
      this.reading.add(id)
      let read: LinkHealthRead
      try {
        read = await machine.api.hostsLinkHealth()
      } catch {
        read = 'unavailable'
      } finally {
        this.reading.delete(id)
      }
      // A read from a connection that changed while it ran belongs to no screen.
      this.set(id, machine.isCurrent() ? read : undefined)
    }))
  }

  private set(id: string, read: LinkHealthRead | undefined): void {
    if (this.health.get(id) === read) return
    const next = new Map(this.health)
    if (read === undefined) next.delete(id)
    else next.set(id, read)
    this.health = next
    this.changes.notify()
  }
}
