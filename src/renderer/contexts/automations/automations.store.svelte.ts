import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationsChangedEvent, AutomationTrigger } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import type { HostApi } from '@client-core/host-api'

// Renderer-side cache + RPC wrapper for automations. Mirrors WorksStore: the UI
// reads reactive state here and calls these methods, which forward to the same
// main-process automation service the agent tools use. A human-made and an
// agent-made automation are therefore indistinguishable downstream.
export class AutomationsStore {
  items = $state<Automation[]>([])
  /** Run history per automation id, loaded lazily when a row is expanded. */
  runs = new SvelteMap<string, AutomationRun[]>()
  loading = $state(false)
  loaded = $state(false)
  /** Which host stores, schedules, and runs each known automation. */
  private hostByAutomationId = new SvelteMap<string, string>()
  private loadedServerIds = new SvelteSet<string>()
  private loadingServerIds = new SvelteSet<string>()
  private loadingCountByServerId = new Map<string, number>()
  private listLoads = new Map<string, Promise<void>>()

  /** A soft-deleted row awaiting its undo window. Hidden from `items` but not yet
   *  deleted on disk; filtered out of `loadAll` so a refresh can't resurrect it. */
  private pendingDelete: { automation: Automation; index: number } | null = null

  itemsForHost(serverId: string): Automation[] {
    const resolvedServerId = serverConnections.resolveId(serverId)
    return this.items.filter((automation) => this.hostByAutomationId.get(automation.id) === resolvedServerId)
  }

  hasLoadedHost(serverId: string): boolean {
    return this.loadedServerIds.has(serverConnections.resolveId(serverId))
  }

  isLoadingHost(serverId: string): boolean {
    return this.loadingServerIds.has(serverConnections.resolveId(serverId))
  }

  loadAll(serverId?: string): Promise<void> {
    const serverIds = serverId
      ? [serverConnections.resolveId(serverId)]
      : serverConnections.connectedServerIds()
    const loadKey = serverId ? serverIds[0] : '*'
    const existingLoad = this.listLoads.get(loadKey)
    if (existingLoad) return existingLoad
    for (const targetServerId of serverIds) {
      this.loadingCountByServerId.set(targetServerId, (this.loadingCountByServerId.get(targetServerId) ?? 0) + 1)
      this.loadingServerIds.add(targetServerId)
    }
    this.loading = this.loadingServerIds.size > 0
    const listLoad = (async () => {
      try {
        const results = await Promise.all(serverIds.map(async (serverId) => {
          try {
            const capabilities = await serverConnections.capabilitiesFor(serverId)
            if (capabilities.automations !== true) return { serverId }
            return { serverId, list: await serverConnections.apiFor(serverId).automationList() }
          } catch (error) {
            console.error('automation list host load failed', serverId, error)
            return { serverId, error }
          }
        }))
        const pendingId = this.pendingDelete?.automation.id
        for (const result of results) {
          if (!result.list) continue
          const liveIds = new Set<string>()
          for (const automation of result.list) {
            liveIds.add(automation.id)
            this.hostByAutomationId.set(automation.id, result.serverId)
            if (automation.id !== pendingId) this.upsert(automation)
          }
          // Only a host that answered can confirm deletion of its own rows. A
          // failed host cannot evict another host's automations from the union.
          for (let index = this.items.length - 1; index >= 0; index--) {
            const automation = this.items[index]
            if (this.hostByAutomationId.get(automation.id) !== result.serverId) continue
            if (liveIds.has(automation.id) || automation.id === pendingId) continue
            this.items.splice(index, 1)
            this.runs.delete(automation.id)
            this.hostByAutomationId.delete(automation.id)
          }
        }
        this.loaded = true
      } catch (err) {
        console.error('automation list load failed', err)
      } finally {
        for (const targetServerId of serverIds) {
          const remainingLoads = (this.loadingCountByServerId.get(targetServerId) ?? 1) - 1
          if (remainingLoads === 0) {
            this.loadingCountByServerId.delete(targetServerId)
            this.loadingServerIds.delete(targetServerId)
          } else {
            this.loadingCountByServerId.set(targetServerId, remainingLoads)
          }
          this.loadedServerIds.add(targetServerId)
        }
        this.loading = this.loadingServerIds.size > 0
        this.listLoads.delete(loadKey)
      }
    })()
    this.listLoads.set(loadKey, listLoad)
    return listLoad
  }

  get(id: string): Automation | undefined {
    return this.items.find((a) => a.id === id)
  }

  hostFor(id: string | null | undefined): string | null {
    return id ? this.hostByAutomationId.get(id) ?? null : null
  }

  /** An automation the store has not placed yet falls back to the default host. */
  private apiForAutomation(id: string): HostApi {
    const serverId = this.hostByAutomationId.get(id) ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return serverConnections.apiFor(serverId)
  }

  /** Replace one automation in-place (or append) without reassigning the array,
   *  so only the changed row's derived state invalidates. */
  private upsert(a: Automation): void {
    const i = this.items.findIndex((x) => x.id === a.id)
    if (i === -1) this.items.unshift(a)
    else this.items[i] = a
  }

  /** Apply a pushed `automation.changed` event from the host. This is how the UI
   *  learns about background activity (scheduler fires, run transitions, agent
   *  tool saves) without polling; RPC-initiated mutations also echo here, which
   *  the upsert absorbs idempotently. */
  applyChange(serverId: string, event: AutomationsChangedEvent): void {
    if (event.kind === 'deleted') {
      if (this.hostByAutomationId.get(event.automationId) !== serverId) return
      const i = this.items.findIndex((a) => a.id === event.automationId)
      if (i !== -1) this.items.splice(i, 1)
      this.runs.delete(event.automationId)
      this.hostByAutomationId.delete(event.automationId)
      return
    }
    // Don't resurrect a row the user just soft-deleted (its undo window is
    // still open; commit/restore owns its fate).
    if (this.pendingDelete?.automation.id === event.automation.id) return
    this.hostByAutomationId.set(event.automation.id, serverId)
    this.upsert(event.automation)
    if (event.kind === 'run-started' || event.kind === 'run-updated' || event.kind === 'run-finished') {
      const existing = this.runs.get(event.automation.id)
      if (!existing) return // history not loaded for this row; loaded lazily on demand
      const i = existing.findIndex((r) => r.id === event.run.id)
      if (i === -1) this.runs.set(event.automation.id, [event.run, ...existing])
      else {
        const next = existing.slice()
        next[i] = event.run
        this.runs.set(event.automation.id, next)
      }
    }
  }

  async create(
    serverId: string,
    name: string,
    action: AutomationAction,
    trigger: AutomationTrigger,
    enabled = true,
  ): Promise<Automation> {
    if ((await serverConnections.capabilitiesFor(serverId)).automations !== true) {
      throw new Error('Automations are not supported on this host')
    }
    const createdBy: AutomationCreator = { kind: 'user' }
    const created = await serverConnections.apiFor(serverId).automationCreate(name, action, createdBy, enabled, trigger)
    this.hostByAutomationId.set(created.id, serverId)
    this.upsert(created)
    return created
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger },
  ): Promise<void> {
    const updated = await this.apiForAutomation(id).automationUpdate(id, patch)
    if (updated) this.upsert(updated)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const updated = await this.apiForAutomation(id).automationSetEnabled(id, enabled)
    if (updated) this.upsert(updated)
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    const updated = await this.apiForAutomation(id).automationUpdate(id, { favorite })
    if (updated) this.upsert(updated)
  }

  /** Soft-delete: hide the row immediately but defer the on-disk delete until the
   *  undo toast commits. Captures the row + index so undo can restore it in place. */
  softRemove(id: string): boolean {
    const index = this.items.findIndex((a) => a.id === id)
    if (index === -1) return false
    const [automation] = this.items.splice(index, 1)
    this.pendingDelete = { automation, index }
    return true
  }

  /** Undo a soft-delete: re-insert the captured row at its original position. */
  restorePending(): void {
    const p = this.pendingDelete
    if (!p) return
    this.pendingDelete = null
    this.items.splice(Math.min(p.index, this.items.length), 0, p.automation)
  }

  /** Commit a soft-delete: permanently delete from disk and drop run history. */
  async commitPending(): Promise<void> {
    const p = this.pendingDelete
    if (!p) return
    this.pendingDelete = null
    await this.apiForAutomation(p.automation.id).automationDelete(p.automation.id)
    this.runs.delete(p.automation.id)
    this.hostByAutomationId.delete(p.automation.id)
  }

  /** Trigger a run now and refresh the row + its run history. */
  async runNow(id: string): Promise<void> {
    await this.apiForAutomation(id).automationRun(id)
    await Promise.all([this.refreshOne(id), this.loadRuns(id)])
  }

  /** Cancel the in-flight run for an automation, then refresh so the row reflects
   *  the terminal 'cancelled' status (the cancel resolves once the run settles). */
  async cancel(id: string): Promise<void> {
    await this.apiForAutomation(id).automationCancel(id)
    await Promise.all([this.refreshOne(id), this.loadRuns(id)])
  }

  async refreshOne(id: string): Promise<void> {
    const fresh = await this.apiForAutomation(id).automationRead(id)
    if (fresh) this.upsert(fresh)
  }

  async loadRuns(id: string): Promise<void> {
    this.runs.set(id, await this.apiForAutomation(id).automationListRuns(id))
  }
}
