import { SvelteMap } from 'svelte/reactivity'
import type { Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationsChangedEvent, AutomationTrigger } from '../../../shared/types'

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
  private listLoad: Promise<void> | null = null

  /** A soft-deleted row awaiting its undo window. Hidden from `items` but not yet
   *  deleted on disk; filtered out of `loadAll` so a refresh can't resurrect it. */
  private pendingDelete: { automation: Automation; index: number } | null = null

  loadAll(): Promise<void> {
    if (this.listLoad) return this.listLoad
    this.loading = true
    this.listLoad = (async () => {
      try {
        const list = await window.solus.automationList()
        const pendingId = this.pendingDelete?.automation.id
        this.items = pendingId ? list.filter((a) => a.id !== pendingId) : list
        this.loaded = true
      } catch (err) {
        console.error('automation list load failed', err)
      } finally {
        this.loading = false
        this.listLoad = null
      }
    })()
    return this.listLoad
  }

  get(id: string): Automation | undefined {
    return this.items.find((a) => a.id === id)
  }

  /** Replace one automation in-place (or append) without reassigning the array,
   *  so only the changed row's derived state invalidates. */
  private upsert(a: Automation): void {
    const i = this.items.findIndex((x) => x.id === a.id)
    if (i === -1) this.items.unshift(a)
    else this.items[i] = a
  }

  /** Apply a pushed `automations-changed` event from main. This is how the UI
   *  learns about background activity (scheduler fires, run transitions, agent
   *  tool saves) without polling; RPC-initiated mutations also echo here, which
   *  the upsert absorbs idempotently. */
  applyChange(event: AutomationsChangedEvent): void {
    if (event.kind === 'deleted') {
      const i = this.items.findIndex((a) => a.id === event.automationId)
      if (i !== -1) this.items.splice(i, 1)
      this.runs.delete(event.automationId)
      return
    }
    // Don't resurrect a row the user just soft-deleted (its undo window is
    // still open; commit/restore owns its fate).
    if (this.pendingDelete?.automation.id === event.automation.id) return
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
    name: string,
    action: AutomationAction,
    trigger: AutomationTrigger,
    enabled = true,
  ): Promise<Automation> {
    const createdBy: AutomationCreator = { kind: 'user' }
    const created = await window.solus.automationCreate(name, action, createdBy, enabled, trigger)
    this.upsert(created)
    return created
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger },
  ): Promise<void> {
    const updated = await window.solus.automationUpdate(id, patch)
    if (updated) this.upsert(updated)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const updated = await window.solus.automationSetEnabled(id, enabled)
    if (updated) this.upsert(updated)
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    const updated = await window.solus.automationUpdate(id, { favorite })
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
    await window.solus.automationDelete(p.automation.id)
    this.runs.delete(p.automation.id)
  }

  /** Trigger a run now and refresh the row + its run history. */
  async runNow(id: string): Promise<void> {
    await window.solus.automationRun(id)
    await Promise.all([this.refreshOne(id), this.loadRuns(id)])
  }

  /** Cancel the in-flight run for an automation, then refresh so the row reflects
   *  the terminal 'cancelled' status (the cancel resolves once the run settles). */
  async cancel(id: string): Promise<void> {
    await window.solus.automationCancel(id)
    await Promise.all([this.refreshOne(id), this.loadRuns(id)])
  }

  async refreshOne(id: string): Promise<void> {
    const fresh = await window.solus.automationRead(id)
    if (fresh) this.upsert(fresh)
  }

  async loadRuns(id: string): Promise<void> {
    this.runs.set(id, await window.solus.automationListRuns(id))
  }
}
