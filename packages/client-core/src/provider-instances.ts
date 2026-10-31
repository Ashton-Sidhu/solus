import { providerInstancesSnapshotSchema } from '@solus/contracts/provider-instances'
import type { ProviderInstancesSnapshot, ProviderInstancesWrite, ProviderInstanceStatus } from '@solus/contracts/provider-instances'
import type { SeatConnectStartResult } from '@solus/contracts/seats'
import type { HostApi } from './host-api'

export interface ProviderInstancesView {
  snapshot: ProviderInstancesSnapshot | null
  loading: boolean
  saving: boolean
  error: string
  statuses: ReadonlyMap<string, ProviderInstanceStatus>
  verification: { instanceId: string; result: SeatConnectStartResult } | null
  action: string | null
}

/** One caller's private settings on one host; late reads cannot replace a completed write. */
type ProviderInstancesApi = Pick<HostApi, 'providerInstancesGet' | 'providerInstancesWrite' | 'providerInstanceStatus' | 'providerInstanceSignIn' | 'providerInstanceSubmitCode' | 'providerInstanceCancelSignIn' | 'providerInstanceSignOut'>

export class ProviderInstancesClient {
  private view: ProviderInstancesView = { snapshot: null, loading: false, saving: false, error: '', statuses: new Map(), verification: null, action: null }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private scopeGeneration = 0
  private readonly inspections = new Map<string, symbol>()
  private readonly pendingInspections = new Map<string, Promise<void>>()
  private reloadAfterWrite = false
  constructor(private readonly api: () => ProviderInstancesApi) {}
  current = (): ProviderInstancesView => this.view
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<ProviderInstancesView>) {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }
  async load(): Promise<void> {
    if (this.view.saving) { this.reloadAfterWrite = true; return }
    const generation = ++this.generation
    this.publish({ loading: !this.view.snapshot, error: '' })
    try {
      const snapshot = providerInstancesSnapshotSchema.parse(await this.api().providerInstancesGet())
      if (generation === this.generation) this.publish({ snapshot, loading: false })
    } catch (error) {
      if (generation === this.generation) this.publish({ loading: false, error: error instanceof Error ? error.message : 'Could not read provider instances.' })
    }
  }
  async write(request: ProviderInstancesWrite): Promise<ProviderInstancesSnapshot | null> {
    if (this.view.saving) return null
    const generation = ++this.generation
    this.publish({ saving: true, error: '' })
    try {
      let command = request
      if (this.view.snapshot?.configurationVersion !== 2) {
        if (request.change.kind === 'project') throw new Error('Update this host to use project provider overrides.')
        if (request.change.kind === 'save') {
          const { defaultModel: _legacyModel, ...instance } = request.change.instance
          command = { ...request, change: { kind: 'save', instance } }
        }
      }
      const snapshot = providerInstancesSnapshotSchema.parse(await this.api().providerInstancesWrite(command))
      if (generation !== this.generation) return null
      this.publish({ snapshot, saving: false })
      if (this.reloadAfterWrite) { this.reloadAfterWrite = false; void this.load() }
      return snapshot
    } catch (error) {
      if (generation === this.generation) this.publish({ saving: false, error: error instanceof Error ? error.message : 'Could not save provider instances.' })
      return null
    }
  }
  inspect(instanceId: string): Promise<void> {
    const pending = this.pendingInspections.get(instanceId)
    if (pending) return pending
    const result = this.readStatus(instanceId)
    this.pendingInspections.set(instanceId, result)
    void result.finally(() => { if (this.pendingInspections.get(instanceId) === result) this.pendingInspections.delete(instanceId) })
    return result
  }
  /** Check while the detail page is open. A zero interval disables repeated checks. */
  watchStatus(instanceId: string, seconds: number, schedule: (callback: () => void, delay: number) => () => void = scheduleStatus): () => void {
    let stopped = false
    let cancel: (() => void) | undefined
    const check = async () => {
      await this.inspect(instanceId)
      if (!stopped && seconds > 0) cancel = schedule(() => { void check() }, seconds * 1000)
    }
    void check()
    return () => { stopped = true; cancel?.() }
  }
  private async readStatus(instanceId: string): Promise<void> {
    const request = Symbol()
    this.inspections.set(instanceId, request)
    try {
      const status = await this.api().providerInstanceStatus({ instanceId })
      if (this.inspections.get(instanceId) !== request) return
      const statuses = new Map(this.view.statuses)
      statuses.set(instanceId, status)
      const verification = this.view.verification?.instanceId === instanceId && status.phase !== 'connecting' ? null : this.view.verification
      this.publish({ statuses, verification })
    } catch (error) {
      if (this.inspections.get(instanceId) === request) this.publish({ error: error instanceof Error ? error.message : 'Could not read provider status.' })
    }
  }
  async signIn(instanceId: string): Promise<void> {
    if (this.view.action) return
    const scopeGeneration = this.scopeGeneration
    this.publish({ action: instanceId, error: '' })
    try {
      const result = await this.api().providerInstanceSignIn({ instanceId })
      if (scopeGeneration !== this.scopeGeneration) return
      this.publish({ verification: { instanceId, result } })
      await this.inspect(instanceId)
    } catch (error) { if (scopeGeneration === this.scopeGeneration) this.publish({ error: error instanceof Error ? error.message : 'Sign-in failed.' }) }
    finally { if (scopeGeneration === this.scopeGeneration) this.publish({ action: null }) }
  }
  async submitCode(instanceId: string, code: string): Promise<void> {
    const scopeGeneration = this.scopeGeneration
    try { await this.api().providerInstanceSubmitCode({ instanceId, code }) }
    catch (error) { if (scopeGeneration === this.scopeGeneration) this.publish({ error: error instanceof Error ? error.message : 'Could not submit sign-in code.' }) }
  }
  async cancelSignIn(instanceId: string): Promise<void> {
    const scopeGeneration = this.scopeGeneration
    try {
      await this.api().providerInstanceCancelSignIn({ instanceId })
      if (scopeGeneration !== this.scopeGeneration) return
      this.publish({ verification: null })
      await this.inspect(instanceId)
    } catch (error) { if (scopeGeneration === this.scopeGeneration) this.publish({ error: error instanceof Error ? error.message : 'Could not cancel sign-in.' }) }
  }
  async signOut(instanceId: string): Promise<void> {
    if (this.view.action) return
    const scopeGeneration = this.scopeGeneration
    this.publish({ action: instanceId, error: '' })
    try {
      await this.api().providerInstanceSignOut({ instanceId })
      if (scopeGeneration !== this.scopeGeneration) return
      await this.inspect(instanceId)
      await this.load()
    } catch (error) { if (scopeGeneration === this.scopeGeneration) this.publish({ error: error instanceof Error ? error.message : 'Could not sign out.' }) }
    finally { if (scopeGeneration === this.scopeGeneration) this.publish({ action: null }) }
  }
  clear(): void {
    ++this.generation
    ++this.scopeGeneration
    this.reloadAfterWrite = false
    this.inspections.clear()
    this.pendingInspections.clear()
    this.publish({ statuses: new Map(), verification: null, action: null, snapshot: null, loading: false, saving: false, error: '' })
  }
}

function scheduleStatus(callback: () => void, delay: number): () => void {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

export function providerStatusCheckedLabel(checkedAt: number): string {
  return `Checked ${new Date(checkedAt).toLocaleTimeString()}`
}

export function providerStatusLabel(status?: ProviderInstanceStatus): string {
  if (!status) return 'Checking provider status…'
  if (status.phase === 'connecting') return 'Sign-in is in progress.'
  return status.authenticated ? 'Authenticated' : 'Not authenticated'
}
