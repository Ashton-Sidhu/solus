import { isServerUpdateActive, type ServerUpdateOperation } from '@solus/contracts/server-update'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { onServerRemoving } from '@solus/client-core/server-registry'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { SetupAgent } from '@solus/contracts/types'

export interface HostUpdateNotice { target: 'solus' | SetupAgent; version: string }
type ManualOutcome = 'up-to-date' | 'error'

type UpdateConnections = Pick<typeof serverConnections, 'resolveId' | 'statusFor' | 'capabilitiesFor' | 'connectedServerIds' | 'onConnectionCreated' | 'onStatusChange'> & {
  apiFor(serverId: string): Pick<SolusAPI, 'hostUpdateStatus' | 'hostCheckForUpdates' | 'hostInstallUpdate' | 'hostCancelUpdate'>
}

export class HostUpdatesStore {
  constructor(private readonly connections: UpdateConnections = serverConnections) {}
  readonly statuses = new SvelteMap<string, HostUpdateStatus>()
  readonly operations = new SvelteMap<string, ServerUpdateOperation>()
  readonly updateErrors = new SvelteMap<string, string>()
  readonly updateRequests = new SvelteSet<string>()
  readonly errors = new SvelteMap<string, string>()
  private readonly epochs = new Map<string, number>()
  private readonly generations = new Map<string, number>()
  private readonly notices = new SvelteMap<string, string>()
  private readonly outcomes = new SvelteMap<string, ManualOutcome>()
  private readonly loading = new Map<string, Promise<void>>()
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    subscribeAllHosts('host.updateStatusChanged', (serverId, status) => this.applyStatus(serverId, status))
    this.connections.onConnectionCreated((connection) => { if (connection.status === 'connected') void this.load(connection.serverId) })
    this.connections.onStatusChange((serverId, status) => {
      if (status === 'connected') void this.load(serverId)
      else this.clear(serverId)
    })
    onServerRemoving((server) => {
      const serverId = server.id
      this.clear(serverId)
      this.operations.delete(serverId)
      for (const key of this.notices.keys()) if (key.startsWith(`${serverId}:`)) this.notices.delete(key)
    })
    for (const serverId of this.connections.connectedServerIds()) void this.load(serverId)
  }

  applyStatus(serverId: string, status: HostUpdateStatus): void {
    if (this.connections.statusFor(serverId) !== 'connected') return
    this.invalidate(serverId)
    this.saveStatus(serverId, status)
    this.errors.delete(serverId)
  }

  private saveStatus(serverId: string, status: HostUpdateStatus): void {
    this.statuses.set(serverId, status)
    const operation = status.serverUpdate?.operation
    if (operation) this.operations.set(serverId, operation)
    else this.operations.delete(serverId)
  }

  async install(serverId: string): Promise<void> { await this.update(serverId, 'hostInstallUpdate') }
  async cancelUpdate(serverId: string): Promise<void> { await this.update(serverId, 'hostCancelUpdate') }

  private async update(serverId: string, method: 'hostInstallUpdate' | 'hostCancelUpdate'): Promise<void> {
    serverId = this.connections.resolveId(serverId)
    if (this.updateRequests.has(serverId) || this.connections.statusFor(serverId) !== 'connected') return
    if (!this.hostUpdateFor(serverId)?.serverUpdate?.supported) return
    this.updateErrors.delete(serverId)
    this.updateRequests.add(serverId)
    this.errors.delete(serverId)
    const epoch = this.epochs.get(serverId) ?? 0
    const generation = this.generations.get(serverId)
    try {
      const status = await this.connections.apiFor(serverId)[method]()
      if ((this.epochs.get(serverId) ?? 0) === epoch && this.connections.statusFor(serverId) === 'connected'
        && this.generations.get(serverId) === generation) this.saveStatus(serverId, status)
    } catch (error) {
      if ((this.epochs.get(serverId) ?? 0) === epoch) {
        const message = error instanceof Error ? error.message : String(error)
        this.errors.set(serverId, message)
        this.updateErrors.set(serverId, message)
      }
    } finally { this.updateRequests.delete(serverId) }
  }

  private invalidate(serverId: string): number {
    const generation = (this.generations.get(serverId) ?? 0) + 1
    this.generations.set(serverId, generation)
    return generation
  }

  private clear(serverId: string): void {
    this.invalidate(serverId)
    this.epochs.set(serverId, (this.epochs.get(serverId) ?? 0) + 1)
    this.statuses.delete(serverId)
    this.errors.delete(serverId)
    this.outcomes.delete(serverId)
    this.loading.delete(serverId)
  }

  async load(serverId: string): Promise<void> {
    if (this.loading.has(serverId)) return this.loading.get(serverId)
    const generation = this.invalidate(serverId)
    const promise = (async () => {
      try {
        const capabilities = await this.connections.capabilitiesFor(serverId)
        if (!capabilities.hostUpdates) return
        const status = await this.connections.apiFor(serverId).hostUpdateStatus()
        if (this.generations.get(serverId) === generation && this.connections.statusFor(serverId) === 'connected') {
          this.saveStatus(serverId, status)
          this.errors.delete(serverId)
        }
      } catch (error) {
        if (this.generations.get(serverId) === generation) this.errors.set(serverId, error instanceof Error ? error.message : String(error))
      }
    })().finally(() => { if (this.loading.get(serverId) === promise) this.loading.delete(serverId) })
    this.loading.set(serverId, promise)
    return promise
  }

  hostUpdateFor(serverId: string): HostUpdateStatus | undefined {
    return this.statuses.get(this.connections.resolveId(serverId))
  }

  providerUpdatesFor(serverId: string) { return this.hostUpdateFor(serverId)?.providers ?? [] }

  pendingCountFor(serverId: string): number {
    const status = this.hostUpdateFor(serverId)
    return status ? Number(status.check.kind === 'available') + status.providers.filter((p) => p.check.kind === 'available').length : 0
  }

  get anyUpdateAvailable(): boolean {
    return [...this.statuses.keys()].some((serverId) => this.pendingCountFor(serverId) > 0)
  }

  pendingNoticeFor(serverId: string): HostUpdateNotice | null {
    const status = this.hostUpdateFor(serverId)
    if (!status || isServerUpdateActive(this.operations.get(serverId))) return null
    const targets = [{ target: 'solus' as const, check: status.check }, ...status.providers.map((p) => ({ target: p.agent, check: p.check }))]
    for (const { target, check } of targets) {
      if (check.kind === 'available' && this.notices.get(`${serverId}:${target}`) !== check.latestVersion) return { target, version: check.latestVersion }
    }
    return null
  }

  markNoticeShown(serverId: string, notice: HostUpdateNotice): void { this.notices.set(`${serverId}:${notice.target}`, notice.version) }
  manualCheckOutcomeFor(serverId: string): ManualOutcome | null { return this.outcomes.get(serverId) ?? null }
  markManualCheckReported(serverId: string): void { this.outcomes.delete(serverId) }

  async check(serverId: string): Promise<void> {
    serverId = this.connections.resolveId(serverId)
    if (this.connections.statusFor(serverId) !== 'connected') return
    this.outcomes.delete(serverId)
    // A reconnect invalidates this request; intermediate status events do not.
    const epoch = this.epochs.get(serverId) ?? 0
    try {
      if (!(await this.connections.capabilitiesFor(serverId)).hostUpdates) return
      const generation = this.generations.get(serverId)
      const status = await this.connections.apiFor(serverId).hostCheckForUpdates()
      if ((this.epochs.get(serverId) ?? 0) !== epoch || this.connections.statusFor(serverId) !== 'connected') return
      if (this.generations.get(serverId) === generation) this.saveStatus(serverId, status)
      this.errors.delete(serverId)
      const current = this.statuses.get(serverId) ?? status
      const checks = [current.check, ...current.providers.map((p) => p.check)]
      if (checks.some((check) => check.kind === 'error')) this.outcomes.set(serverId, 'error')
      else if (checks.some((check) => check.kind === 'up-to-date') && checks.every((check) => check.kind === 'up-to-date' || check.kind === 'idle')) this.outcomes.set(serverId, 'up-to-date')
    } catch (error) {
      if ((this.epochs.get(serverId) ?? 0) !== epoch || this.connections.statusFor(serverId) !== 'connected') return
      this.errors.set(serverId, error instanceof Error ? error.message : String(error))
      this.outcomes.set(serverId, 'error')
    }
  }

  async checkAll(): Promise<void> { await Promise.all(this.connections.connectedServerIds().map((id) => this.check(id))) }
}

export const hostUpdatesStore = new HostUpdatesStore()
