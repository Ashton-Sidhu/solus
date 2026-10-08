import type { CatalogPage, Integration, IntegrationAuthFinishedEvent, IntegrationChangedEvent, IntegrationConnection, IntegrationConnectionChangedEvent, IntegrationOAuthClientInput, IntegrationProbeResult, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { oauthRedirectUrl } from './lib/integration-labels'

/**
 * The caller's sign-in to one integration while it runs (§4.3). Absent when no
 * sign-in runs. `waiting` and `token` carry `error` after a rejected submit, so
 * the person can correct what they pasted. `submitting` keeps the flow ID of a
 * waiting flow: its end arrives as `host.integrationAuthFinished`.
 */
export type IntegrationConnectFlow =
  | { kind: 'starting' }
  | { kind: 'waiting'; flowId: string; url: string; input: 'callback' | 'redirect-url'; expiresAt: string; error?: string }
  | { kind: 'token'; error?: string }
  | { kind: 'submitting'; flowId?: string }
  | { kind: 'disconnecting' }
  | { kind: 'failed'; message: string }

export type ConnectionsStatus = 'loading' | 'loaded' | 'unsupported' | 'error'

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
  /** The caller's own connections, by integration ID. */
  connections: SvelteMap<string, IntegrationConnection>
  /** `unsupported`: the host is older than per-person sign-in. */
  connectionsStatus: ConnectionsStatus
  /** The sign-in that runs for each integration, by integration ID. */
  connectFlows: SvelteMap<string, IntegrationConnectFlow>
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
  return {
    integrations: null, tools: new SvelteMap(), toolErrors: new SvelteMap(), loading: false, error: '', saving: false, writeError: '', isUnsupported: false, isDisconnected: false, revision: 0,
    connections: new SvelteMap(), connectionsStatus: 'loading', connectFlows: new SvelteMap(),
  }
}

/** The flow ID the host knows a flow by, when the flow waits on the host. */
function hostFlowId(flow: IntegrationConnectFlow | undefined): string | undefined {
  if (flow?.kind === 'waiting') return flow.flowId
  if (flow?.kind === 'submitting') return flow.flowId
  return undefined
}

/** setTimeout's largest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The integrations of each host (docs/plans/mcp-integrations.md §7). The list
 * follows `integration.changed` and reloads on reconnect. Catalog results and
 * probe results are not kept here: they belong to the Add flow that asked.
 *
 * The caller's own connections (§4) load beside the list and follow
 * `integration.connectionChanged`. A sign-in runs here, not in a component, so
 * the Settings row and the conversation card show the same flow.
 */
class IntegrationsStore {
  states = new SvelteMap<string, IntegrationsState>()
  private watches = new Map<string, { count: number; stop: () => void }>()
  /** Per host and integration: bumped by every event, so an older read for that id does not land. */
  private eventSequence = new Map<string, number>()
  /** Per host: bumped by every connection list load; an older load does not land. */
  private connectionRevisions = new Map<string, number>()
  /** Per host: the integrations whose connection changed while a list load ran. The event is newer. */
  private connectionEventsDuringLoad = new Map<string, Set<string>>()
  /** Per host and integration: bumped by every flow command, so an older answer does not land. */
  private flowAttempts = new Map<string, number>()
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopChanged = serverConnections.eventsFor(serverId).subscribe('integration.changed', (event) => {
        void this.applyChange(serverId, event)
      })
      const events = serverConnections.eventsFor(serverId)
      const stopConnection = events.subscribe('integration.connectionChanged', (event) => this.applyConnectionChange(serverId, event))
      const stopAuth = events.subscribe('host.integrationAuthFinished', (event) => this.applyAuthFinished(serverId, event))
      const stopStatus = serverConnections.onStatusChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'connected') void this.load(serverId)
        else {
          const state = this.states.get(serverId)
          // A load in flight answers from a host that is gone; drop it.
          if (state) this.states.set(serverId, { ...state, isDisconnected: true, loading: false, revision: state.revision + 1 })
          this.connectionRevisions.set(serverId, (this.connectionRevisions.get(serverId) ?? 0) + 1)
          this.dropHostFlows(serverId)
        }
      })
      watch = { count: 0, stop: () => { stopChanged(); stopConnection(); stopAuth(); stopStatus() } }
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
    void this.loadConnections(serverId)
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

  /**
   * Saves or, with null, removes the administrator's OAuth client of a server
   * with no dynamic registration (§4.3). The secret goes to the host in this one
   * call and is not kept: the record that comes back says only whether it has one.
   */
  async setOAuthClient(serverId: string, integrationId: string, oauthClient: IntegrationOAuthClientInput | null): Promise<Integration | null> {
    return this.write(serverId, oauthClient ? 'Could not save the OAuth client.' : 'Could not remove the OAuth client.', async () => {
      const integration = await serverConnections.apiFor(serverId).integrationUpdate({ id: integrationId, oauthClient })
      this.upsert(serverId, integration)
      return integration
    })
  }

  /** The redirect URL the service's OAuth app must list: the host at the origin this client reaches it on. */
  oauthRedirectUrl(serverId: string): string {
    return oauthRedirectUrl(serverConnections.httpOriginFor(serverId))
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

  /** One page of the catalog. Throws when the catalog is unavailable. */
  catalogPage(serverId: string, query: string, offset: number, limit: number): Promise<CatalogPage> {
    return serverConnections.apiFor(serverId).integrationCatalogList({ query: query || undefined, offset, limit })
  }

  /** The caller's connection to one integration, or null when they have none. */
  connection(serverId: string, integrationId: string): IntegrationConnection | null {
    return this.states.get(serverId)?.connections.get(integrationId) ?? null
  }

  /** The sign-in that runs for one integration, or null when none runs. */
  connectFlow(serverId: string, integrationId: string): IntegrationConnectFlow | null {
    return this.states.get(serverId)?.connectFlows.get(integrationId) ?? null
  }

  async loadConnections(serverId: string): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    const revision = (this.connectionRevisions.get(serverId) ?? 0) + 1
    this.connectionRevisions.set(serverId, revision)
    const changed = new Set<string>()
    this.connectionEventsDuringLoad.set(serverId, changed)
    if (state.connectionsStatus !== 'loaded') this.states.set(serverId, { ...state, connectionsStatus: 'loading' })
    try {
      const list = await serverConnections.apiFor(serverId).integrationConnectionList()
      const current = this.states.get(serverId)
      if (!current || this.connectionRevisions.get(serverId) !== revision) return
      for (const id of current.connections.keys()) {
        if (!changed.has(id) && !list.some((connection) => connection.integrationId === id)) current.connections.delete(id)
      }
      for (const connection of list) {
        if (!changed.has(connection.integrationId)) current.connections.set(connection.integrationId, connection)
      }
      this.states.set(serverId, { ...current, connectionsStatus: 'loaded' })
    } catch (cause) {
      const current = this.states.get(serverId)
      if (!current || this.connectionRevisions.get(serverId) !== revision) return
      this.states.set(serverId, { ...current, connectionsStatus: isUnsupportedHostError(cause) ? 'unsupported' : 'error' })
    } finally {
      if (this.connectionEventsDuringLoad.get(serverId) === changed) this.connectionEventsDuringLoad.delete(serverId)
    }
  }

  /**
   * Starts the caller's sign-in. The browser returns to the host at the origin
   * this client reaches it on, as the Google sign-in does; a browser that cannot
   * reach that origin hands back the address it landed on instead (`redirect-url`).
   */
  async connect(serverId: string, integrationId: string): Promise<void> {
    const state = this.states.get(serverId)
    const running = state?.connectFlows.get(integrationId)
    if (!state || (running && running.kind !== 'failed')) return
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'starting' })
    try {
      const result = await serverConnections.apiFor(serverId).integrationConnectStart({
        id: integrationId,
        callbackBaseUrl: serverConnections.httpOriginFor(serverId),
      })
      if (!this.isCurrent(serverId, integrationId, attempt)) {
        // Cancelled while it started: end the host's flow too.
        if (result.kind === 'waiting') void this.cancelOnHost(serverId, result.flowId)
        return
      }
      if (result.kind === 'connected') {
        this.states.get(serverId)?.connections.set(integrationId, result.connection)
        this.clearFlow(serverId, integrationId)
      } else if (result.kind === 'token') {
        this.setFlow(serverId, integrationId, { kind: 'token' })
      } else {
        this.setFlow(serverId, integrationId, { kind: 'waiting', flowId: result.flowId, url: result.url, input: result.input, expiresAt: result.expiresAt })
        this.scheduleExpiry(serverId, integrationId, result.flowId, result.expiresAt)
        void this.openSignIn(result.url)
      }
    } catch (cause) {
      if (!this.isCurrent(serverId, integrationId, attempt)) return
      this.setFlow(serverId, integrationId, { kind: 'failed', message: errorText(cause, 'Could not start the sign-in.') })
    }
  }

  /**
   * Hands over what the person pasted: the address a `redirect-url` flow's
   * browser landed on, or the API key of a `token` flow. The key is passed
   * through for one call and is not kept. True when the host took it.
   */
  async submit(serverId: string, integrationId: string, value: string): Promise<boolean> {
    const flow = this.states.get(serverId)?.connectFlows.get(integrationId)
    const trimmed = value.trim()
    if (!flow || !trimmed) return false
    if (flow.kind !== 'token' && !(flow.kind === 'waiting' && flow.input === 'redirect-url')) return false
    const attempt = this.nextAttempt(serverId, integrationId)
    const flowId = flow.kind === 'waiting' ? flow.flowId : undefined
    this.setFlow(serverId, integrationId, { kind: 'submitting', flowId })
    try {
      await serverConnections.apiFor(serverId).integrationConnectSubmit(flowId ? { flowId, value: trimmed } : { id: integrationId, value: trimmed })
      // A pasted address finishes on the host, and its end arrives as `host.integrationAuthFinished`.
      // A stored key is the whole flow: read the connection before the row leaves `submitting`.
      if (!flowId) await this.settleConnected(serverId, integrationId, attempt)
      return true
    } catch (cause) {
      if (this.isCurrent(serverId, integrationId, attempt)) {
        this.setFlow(serverId, integrationId, { ...flow, error: errorText(cause, 'The sign-in did not accept that.') })
      }
      return false
    }
  }

  /** Ends the sign-in here and, when it waits on the host, there too. */
  async cancel(serverId: string, integrationId: string): Promise<void> {
    const flowId = hostFlowId(this.states.get(serverId)?.connectFlows.get(integrationId))
    this.nextAttempt(serverId, integrationId)
    this.clearFlow(serverId, integrationId)
    if (flowId) await this.cancelOnHost(serverId, flowId)
  }

  /** Removes the caller's token and connection. True when the host removed them. */
  async disconnect(serverId: string, integrationId: string): Promise<boolean> {
    if (!this.states.has(serverId)) return false
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'disconnecting' })
    try {
      await serverConnections.apiFor(serverId).integrationDisconnect({ id: integrationId })
      if (!this.isCurrent(serverId, integrationId, attempt)) return true
      this.states.get(serverId)?.connections.delete(integrationId)
      this.clearFlow(serverId, integrationId)
      return true
    } catch (cause) {
      if (this.isCurrent(serverId, integrationId, attempt)) {
        this.setFlow(serverId, integrationId, { kind: 'failed', message: errorText(cause, 'Could not disconnect.') })
      }
      return false
    }
  }

  /** Opens a sign-in page on this device, never on the host, as the Google sign-in does. */
  async openSignIn(url: string): Promise<void> {
    const opened = await localApi.openExternal?.(url).catch(() => false)
    if (!opened) globalThis.window?.open(url, '_blank', 'noopener,noreferrer')
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

  private applyConnectionChange(serverId: string, { integrationId, connection }: IntegrationConnectionChangedEvent): void {
    const state = this.states.get(serverId)
    if (!state) return
    this.connectionEventsDuringLoad.get(serverId)?.add(integrationId)
    if (connection) state.connections.set(integrationId, connection)
    else state.connections.delete(integrationId)
  }

  private applyAuthFinished(serverId: string, event: IntegrationAuthFinishedEvent): void {
    const flowId = hostFlowId(this.states.get(serverId)?.connectFlows.get(event.integrationId))
    if (!flowId || flowId !== event.flowId) return
    const attempt = this.nextAttempt(serverId, event.integrationId)
    if (event.outcome === 'failed') {
      this.setFlow(serverId, event.integrationId, { kind: 'failed', message: event.message?.trim() || 'The sign-in did not finish.' })
    } else if (event.outcome === 'cancelled') {
      this.clearFlow(serverId, event.integrationId)
    } else {
      this.setFlow(serverId, event.integrationId, { kind: 'submitting' })
      void this.settleConnected(serverId, event.integrationId, attempt)
    }
  }

  /**
   * The sign-in ended well. The connection also arrives as
   * `integration.connectionChanged`, but in no fixed order, so it is read here
   * before the flow clears: the row never shows "Not connected" in between.
   */
  private async settleConnected(serverId: string, integrationId: string, attempt: number): Promise<void> {
    if (this.connection(serverId, integrationId)?.status !== 'connected') await this.loadConnections(serverId)
    if (this.isCurrent(serverId, integrationId, attempt)) this.clearFlow(serverId, integrationId)
  }

  /** The host is gone: a flow that waits on it cannot report its end here. Reconnect reloads the connections. */
  private dropHostFlows(serverId: string): void {
    const state = this.states.get(serverId)
    if (!state) return
    for (const [integrationId, flow] of state.connectFlows) {
      if (flow.kind === 'token' || flow.kind === 'failed') continue
      this.nextAttempt(serverId, integrationId)
      this.clearFlow(serverId, integrationId)
    }
  }

  private scheduleExpiry(serverId: string, integrationId: string, flowId: string, expiresAt: string): void {
    const delay = Date.parse(expiresAt) - Date.now()
    if (!Number.isFinite(delay)) return
    const key = this.flowKey(serverId, integrationId)
    this.expiryTimers.set(key, setTimeout(() => {
      this.expiryTimers.delete(key)
      if (hostFlowId(this.states.get(serverId)?.connectFlows.get(integrationId)) !== flowId) return
      this.nextAttempt(serverId, integrationId)
      this.setFlow(serverId, integrationId, { kind: 'failed', message: 'The sign-in expired. Connect again.' })
    }, Math.min(Math.max(delay, 0), MAX_TIMER_MS)))
  }

  private async cancelOnHost(serverId: string, flowId: string): Promise<void> {
    await serverConnections.apiFor(serverId).integrationConnectCancel({ flowId }).catch(() => {})
  }

  private flowKey(serverId: string, integrationId: string): string {
    return `${serverId}\u0000${integrationId}`
  }

  private nextAttempt(serverId: string, integrationId: string): number {
    const key = this.flowKey(serverId, integrationId)
    const attempt = (this.flowAttempts.get(key) ?? 0) + 1
    this.flowAttempts.set(key, attempt)
    return attempt
  }

  private isCurrent(serverId: string, integrationId: string, attempt: number): boolean {
    return this.flowAttempts.get(this.flowKey(serverId, integrationId)) === attempt
  }

  private setFlow(serverId: string, integrationId: string, flow: IntegrationConnectFlow): void {
    if (flow.kind !== 'waiting' && flow.kind !== 'submitting') this.clearExpiry(serverId, integrationId)
    this.states.get(serverId)?.connectFlows.set(integrationId, flow)
  }

  private clearFlow(serverId: string, integrationId: string): void {
    this.clearExpiry(serverId, integrationId)
    this.states.get(serverId)?.connectFlows.delete(integrationId)
  }

  private clearExpiry(serverId: string, integrationId: string): void {
    const key = this.flowKey(serverId, integrationId)
    const timer = this.expiryTimers.get(key)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(key)
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
    state.connections.delete(integrationId)
    this.nextAttempt(serverId, integrationId)
    this.clearFlow(serverId, integrationId)
    if (state.integrations?.some((item) => item.id === integrationId)) {
      this.states.set(serverId, { ...state, integrations: state.integrations.filter((item) => item.id !== integrationId) })
    }
  }
}

export const integrationsStore = new IntegrationsStore()
