import { isServerUpdateActive, type ServerUpdateOperation } from '@solus/contracts/server-update'
import type { SetupAgent } from '@solus/contracts/types'
import { hostSetupStore } from '../../components/servers/host-setup.store.svelte'
import { hostUpdatesStore, type HostUpdateItem } from './host-updates.store.svelte'

/**
 * `started`: the host accepted a Solus update; its operation answers how it ends,
 * after the restart, so the updater follows the operation rather than the request.
 */
export interface HostUpdateRunItem extends HostUpdateItem {
  state: 'queued' | 'running' | 'started' | 'succeeded' | 'failed'
  error: string | null
  operationId: string | null
}
export type HostUpdateOutcome = { phase: 'running'; operation: ServerUpdateOperation | null } | { phase: 'succeeded' } | { phase: 'failed'; error: string }

interface HostUpdateInstallers {
  /** Answers the failure, or null. */
  installProvider(serverId: string, agent: SetupAgent): Promise<string | null>
  /** Answers why the update did not start, or null. */
  installSolus(serverId: string): Promise<string | null>
  /** Answers why the update was not cancelled, or null. */
  cancelSolus(serverId: string): Promise<string | null>
  operationFor(serverId: string): ServerUpdateOperation | undefined
}

const hostInstallers: HostUpdateInstallers = {
  installProvider: (serverId, agent) => hostSetupStore.sessionFor(serverId).installProviderUpdate(agent),
  installSolus: (serverId) => hostUpdatesStore.install(serverId),
  cancelSolus: (serverId) => hostUpdatesStore.cancelUpdate(serverId),
  operationFor: (serverId) => hostUpdatesStore.operations.get(serverId),
}

/**
 * The one way this client updates software on its hosts: a Settings row, the
 * notice, the palette, and the header button all call `update`. Every update
 * started before the last result was reported belongs to one batch, which the
 * notice shows as one toast.
 *
 * Each host has a lock: its updates run one at a time, in the order they were
 * asked for, and an update already queued or running is not asked for again.
 * While Solus updates a host, nothing more starts there: the host restarts.
 */
export class HostUpdater {
  constructor(private readonly installers: HostUpdateInstallers = hostInstallers) {}
  readonly items = $state<HostUpdateRunItem[]>([])
  private readonly hostLocks = new Map<string, Promise<void>>()

  get isRunning(): boolean { return this.items.some((item) => this.outcomeOf(item).phase === 'running') }
  /** True once every update in the batch has an end, and until the notice reports it. */
  get isSettled(): boolean { return this.items.length > 0 && !this.isRunning }

  isUpdating(serverId: string, target: HostUpdateItem['target']): boolean {
    return this.items.some((item) => item.serverId === serverId && item.target === target && this.outcomeOf(item).phase === 'running')
  }

  outcomeOf(item: HostUpdateRunItem): HostUpdateOutcome {
    if (item.state === 'succeeded') return { phase: 'succeeded' }
    if (item.state === 'failed') return { phase: 'failed', error: item.error ?? 'The update failed.' }
    if (item.state !== 'started') return { phase: 'running', operation: null }
    const operation = this.installers.operationFor(item.serverId)
    if (operation?.operationId !== item.operationId) return { phase: 'running', operation: null }
    if (isServerUpdateActive(operation)) return { phase: 'running', operation }
    if (operation.phase === 'succeeded') return { phase: 'succeeded' }
    return { phase: 'failed', error: operation.phase === 'cancelled' ? 'Cancelled.' : operation.message ?? 'The update failed.' }
  }

  update(updates: HostUpdateItem[]): Promise<void> {
    const hosts = new Map<string, HostUpdateRunItem[]>()
    // Only a Solus update asked for earlier closes the host: one in this request runs after its providers.
    const restartingHosts = new Set(updates.filter((update) => this.isUpdating(update.serverId, 'solus')
      || isServerUpdateActive(this.installers.operationFor(update.serverId))).map((update) => update.serverId))
    for (const update of updates) {
      if (restartingHosts.has(update.serverId) || this.isUpdating(update.serverId, update.target)) continue
      this.items.push({ ...update, state: 'queued', error: null, operationId: null })
      // The proxy `$state` made, not the object pushed: only its writes are seen.
      hosts.set(update.serverId, [...(hosts.get(update.serverId) ?? []), this.items[this.items.length - 1]])
    }
    return Promise.all([...hosts].map(([serverId, items]) => {
      const run = (this.hostLocks.get(serverId) ?? Promise.resolve()).then(() => this.runHost(items))
      this.hostLocks.set(serverId, run)
      return run.finally(() => { if (this.hostLocks.get(serverId) === run) this.hostLocks.delete(serverId) })
    })).then(() => {})
  }

  /** Updates one thing on one host, as a Settings row asks; nothing happens if it has no release to install. */
  updateTarget(serverId: string, target: HostUpdateItem['target']): Promise<void> {
    return this.update(hostUpdatesStore.installableUpdatesFor(serverId).filter((item) => item.target === target))
  }

  /** Stops each Solus update in the batch that still waits for work to finish. Answers the failures. */
  async cancelWaiting(): Promise<string[]> {
    const waiting = this.items.filter((item) => item.target === 'solus' && this.outcomeOf(item).phase === 'running' && this.installers.operationFor(item.serverId)?.phase === 'waiting')
    const failures = await Promise.all(waiting.map((item) => this.installers.cancelSolus(item.serverId)))
    return failures.filter((failure) => failure !== null)
  }

  /** Called once the result is reported, so the next update starts a new batch. */
  finish(): void { this.items.splice(0) }

  private async runHost(items: HostUpdateRunItem[]): Promise<void> {
    // Providers first: the Solus update restarts the host, which would cut a
    // provider update short.
    for (const item of items) {
      if (item.target === 'solus') continue
      item.state = 'running'
      this.settle(item, await this.installers.installProvider(item.serverId, item.target))
    }
    const solus = items.find((item) => item.target === 'solus')
    if (!solus) return
    solus.state = 'running'
    const failure = await this.installers.installSolus(solus.serverId)
    const operation = this.installers.operationFor(solus.serverId)
    if (failure !== null || !operation) return this.settle(solus, failure ?? 'The host did not start the update.')
    solus.operationId = operation.operationId
    solus.state = 'started'
  }

  private settle(item: HostUpdateRunItem, failure: string | null): void {
    item.state = failure === null ? 'succeeded' : 'failed'
    item.error = failure
  }
}

export const hostUpdater = new HostUpdater()
