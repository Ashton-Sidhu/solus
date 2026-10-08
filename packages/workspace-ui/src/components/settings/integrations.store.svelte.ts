import type { CatalogEntry, Integration, IntegrationChangedEvent, IntegrationProbeResult, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'

interface IntegrationsState {
  /** Null until the first list arrives. */
  integrations: Integration[] | null
  /** The tools of each integration whose tools were asked for. */
  tools: SvelteMap<string, IntegrationToolSummary[]>
  /** Why one integration's tools could not load. */
  toolErrors: SvelteMap<string, string>
  loading: boolean
  /** Why the list could not load. */
  error: string
  saving: boolean
  /** Why the last create, update, or remove failed. */
  writeError: string
  /** The host is older than integrations: it has no `integrationList`. */
  isUnsupported: boolean
  isDisconnected: boolean
  /** Bumped by every list load; an older load does not land. */
  revision: number
}

export type ProbeAttempt = { result: IntegrationProbeResult } | { error: string }

/** An older host answers an unknown RPC with one of these messages. */
export function isUnsupportedHostError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /no handler for|unknown method|unknown rpc|not registered|not a function/i.test(message)
}

function errorText(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : ''
  return message || fallback
}

function emptyState(): IntegrationsState {
  return { integrations: null, tools: new SvelteMap(), toolErrors: new SvelteMap(), loading: false, error: '', saving: false, writeError: '', isUnsupported: false, isDisconnected: false, revision: 0 }
}

/**
 * The integrations of each host (docs/plans/mcp-integrations.md §7). The list
 * follows `integration.changed` and reloads on reconnect. Catalog results and
 * probe results are not kept here: they belong to the Add flow that asked.
 */
class IntegrationsStore {
  states = new SvelteMap<string, IntegrationsState>()
  private watches = new Map<string, { count: number; stop: () => void }>()
  /** Per host and integration: bumped by every event, so an older read for that id does not land. */
  private eventSequence = new Map<string, number>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopChanged = serverConnections.eventsFor(serverId).subscribe('integration.changed', (event) => {
        void this.applyChange(serverId, event)
      })
      const stopStatus = serverConnections.onStatusChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'connected') void this.load(serverId)
        else {
          const state = this.states.get(serverId)
          // A load in flight answers from a host that is gone; drop it.
          if (state) this.states.set(serverId, { ...state, isDisconnected: true, loading: false, revision: state.revision + 1 })
        }
      })
      watch = { count: 0, stop: () => { stopChanged(); stopStatus() } }
      this.watches.set(serverId, watch)
      void this.load(serverId)
    }
    watch.count++
    return () => { if (--watch.count === 0) { watch.stop(); this.watches.delete(serverId) } }
  }

  /** Every loaded integration name, on every host: what settings search matches. */
  names(): string[] {
    return [...this.states.values()].flatMap((state) => state.integrations?.map((integration) => integration.name) ?? [])
  }

  async load(serverId: string): Promise<void> {
    const state = this.states.get(serverId) ?? emptyState()
    const revision = state.revision + 1
    this.states.set(serverId, { ...state, loading: true, revision })
    try {
      const integrations = await serverConnections.apiFor(serverId).integrationList()
      const current = this.states.get(serverId)
      if (current?.revision !== revision) return
      this.states.set(serverId, { ...current, integrations, loading: false, error: '', isUnsupported: false, isDisconnected: false })
      for (const id of current.tools.keys()) {
        if (!integrations.some((integration) => integration.id === id)) current.tools.delete(id)
      }
    } catch (cause) {
      const current = this.states.get(serverId)
      if (current?.revision !== revision) return
      const isUnsupported = isUnsupportedHostError(cause)
      const isDisconnected = serverConnections.statusFor(serverId) !== 'connected'
      this.states.set(serverId, { ...current, loading: false, isUnsupported, isDisconnected, error: isUnsupported ? '' : 'Could not load integrations.' })
    }
  }

  async loadTools(serverId: string, integrationId: string): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    state.toolErrors.delete(integrationId)
    try {
      const tools = await serverConnections.apiFor(serverId).integrationTools({ id: integrationId })
      this.states.get(serverId)?.tools.set(integrationId, tools)
    } catch (cause) {
      this.states.get(serverId)?.toolErrors.set(integrationId, errorText(cause, 'Could not load the tools.'))
    }
  }

  async create(serverId: string, request: { name: string; url: string }): Promise<Integration | null> {
    return this.write(serverId, 'Could not add the integration.', async () => {
      const integration = await serverConnections.apiFor(serverId).integrationCreate(request)
      this.upsert(serverId, integration)
      return integration
    })
  }

  async update(serverId: string, request: { id: string; name?: string; url?: string }): Promise<Integration | null> {
    return this.write(serverId, 'Could not save the integration.', async () => {
      const integration = await serverConnections.apiFor(serverId).integrationUpdate(request)
      this.upsert(serverId, integration)
      return integration
    })
  }

  async remove(serverId: string, integrationId: string): Promise<boolean> {
    const removed = await this.write(serverId, 'Could not remove the integration.', async () => {
      await serverConnections.apiFor(serverId).integrationRemove({ id: integrationId })
      this.drop(serverId, integrationId)
      return true
    })
    return removed === true
  }

  /** Probes an address from the host. The result is the caller's to show; it is not kept. */
  async probe(serverId: string, url: string): Promise<ProbeAttempt> {
    try {
      return { result: await serverConnections.apiFor(serverId).integrationProbe({ url }) }
    } catch (cause) {
      return { error: errorText(cause, 'Could not check this address.') }
    }
  }

  /** Searches the catalog. Throws when the catalog is unavailable. */
  searchCatalog(serverId: string, query: string): Promise<CatalogEntry[]> {
    return serverConnections.apiFor(serverId).integrationCatalogList({ query, limit: 20 })
  }

  clearWriteError(serverId: string): void {
    const state = this.states.get(serverId)
    if (state?.writeError) this.states.set(serverId, { ...state, writeError: '' })
  }

  private async write<T>(serverId: string, fallback: string, run: () => Promise<T>): Promise<T | null> {
    const state = this.states.get(serverId)
    if (!state || state.saving) return null
    this.states.set(serverId, { ...state, saving: true, writeError: '' })
    try {
      const value = await run()
      const current = this.states.get(serverId)
      if (current) this.states.set(serverId, { ...current, saving: false })
      return value
    } catch (cause) {
      const current = this.states.get(serverId)
      if (current) this.states.set(serverId, { ...current, saving: false, writeError: errorText(cause, fallback) })
      return null
    }
  }

  private async applyChange(serverId: string, { integrationId, change }: IntegrationChangedEvent): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    if (change === 'tools') {
      if (state.tools.has(integrationId)) void this.loadTools(serverId, integrationId)
      return
    }
    // A list read in flight, or none yet: read the whole list again instead.
    if (state.integrations === null || state.loading) {
      void this.load(serverId)
      return
    }
    const key = `${serverId}\u0000${integrationId}`
    const sequence = (this.eventSequence.get(key) ?? 0) + 1
    this.eventSequence.set(key, sequence)
    if (change === 'removed') {
      this.drop(serverId, integrationId)
      return
    }
    try {
      const integration = await serverConnections.apiFor(serverId).integrationGet({ id: integrationId })
      if (this.eventSequence.get(key) !== sequence || this.states.get(serverId)?.loading) return
      if (integration) this.upsert(serverId, integration)
      else this.drop(serverId, integrationId)
    } catch {
      if (this.eventSequence.get(key) === sequence) void this.load(serverId)
    }
  }

  private upsert(serverId: string, integration: Integration): void {
    const state = this.states.get(serverId)
    if (!state?.integrations) return
    const index = state.integrations.findIndex((item) => item.id === integration.id)
    const integrations = index === -1
      ? [...state.integrations, integration]
      : state.integrations.map((item, i) => (i === index ? integration : item))
    this.states.set(serverId, { ...state, integrations })
  }

  private drop(serverId: string, integrationId: string): void {
    const state = this.states.get(serverId)
    if (!state) return
    state.tools.delete(integrationId)
    state.toolErrors.delete(integrationId)
    if (state.integrations?.some((item) => item.id === integrationId)) {
      this.states.set(serverId, { ...state, integrations: state.integrations.filter((item) => item.id !== integrationId) })
    }
  }
}

export const integrationsStore = new IntegrationsStore()
