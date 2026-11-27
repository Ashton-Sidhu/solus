import { connectionNeedsAttention, isFirstIntegrationAccount } from '@solus/contracts/integration-types'
import { showsFactsOnRow } from '@solus/contracts/integrations/command-server'
import { CommandProcesses } from '@solus/client-core/command-processes'
import type { CatalogCategoryId, CatalogPage, Integration, IntegrationCatalogListRequest, IntegrationChangedEvent, IntegrationConnectionChangedEvent, IntegrationCreateRequest, IntegrationFacts, IntegrationOAuthClientInput, IntegrationProbeResult, IntegrationUpdateRequest } from '@solus/contracts/integration-types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { upsertById } from '@solus/client-core/keep-equal'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { INTEGRATION_OAUTH_LOOPBACK_URL } from '@solus/contracts/integrations/oauth-callback'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import type { SetupHandoff } from '@solus/contracts/integrations/setup-handoff'
import { errorText, IntegrationSignIns, isUnsupportedHostError, type IntegrationsState } from './integration-sign-ins.svelte'

export type ProbeAttempt = { result: IntegrationProbeResult } | { error: string }

/**
 * The integrations of each host (docs/plans/mcp-integrations.md §7). The list
 * follows `integration.changed` and reloads on reconnect. Catalog results and
 * probe results are not kept here: they belong to the Add flow that asked.
 *
 * The caller's own connections (§4) load beside the list and follow
 * `integration.connectionChanged`. The sign-ins are `IntegrationSignIns`.
 */
export class IntegrationsStore extends IntegrationSignIns {
  private watches = new Map<string, { count: number; stop: () => void }>()
  /** Per host and integration: bumped by every event, so an older read for that id does not land. */
  private eventSequence = new Map<string, number>()
  /** Per host: bumped by every connection list load; an older load does not land. */
  private connectionRevisions = new Map<string, number>()
  /** Per host: the integrations whose connection changed while a list load ran. The event is newer. */
  private connectionEventsDuringLoad = new Map<string, Set<string>>()
  /** Set by `listen`: told when a working sign-in stops working while the app runs. */
  private onSignInExpired: ((serverId: string, integrationName: string) => void) | null = null

  /**
   * Called once at boot. A sign-in can expire while no surface that shows it
   * is open, so every connected host is watched for the life of the app. That
   * also keeps `attentionCount` true for the Settings nav.
   */
  listen(onSignInExpired: (serverId: string, integrationName: string) => void): () => void {
    this.onSignInExpired = onSignInExpired
    const releases = new Map<string, () => void>()
    const follow = (serverId: string) => { if (!releases.has(serverId)) releases.set(serverId, this.watch(serverId)) }
    for (const serverId of serverConnections.serverIds()) follow(serverId)
    const stopCreated = serverConnections.onConnectionCreated((connection) => follow(connection.serverId))
    const stopRemoving = hostCatalog.onForgotten((server) => {
      releases.get(server.id)?.()
      releases.delete(server.id)
      // A removed host's connections must not stay in the count.
      if (!this.watches.has(server.id)) {
        this.states.delete(server.id)
        this.accounts.forget(server.id)
      }
    })
    return () => {
      stopCreated()
      stopRemoving()
      for (const release of releases.values()) release()
      releases.clear()
      this.onSignInExpired = null
    }
  }

  /** The caller's connections, on every host, that need them to act: the number beside MCP in Settings. */
  get attentionCount(): number {
    let count = this.accounts.count(connectionNeedsAttention)
    for (const state of this.states.values()) {
      for (const connection of state.connections.values()) if (connectionNeedsAttention(connection)) count++
    }
    return count
  }

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopChanged = serverConnections.eventsFor(serverId).subscribe('integration.changed', (event) => {
        void this.applyChange(serverId, event)
      })
      const events = serverConnections.eventsFor(serverId)
      const stopConnection = events.subscribe('integration.connectionChanged', (event) => this.applyConnectionChange(serverId, event))
      const stopAuth = events.subscribe('host.integrationAuthFinished', (event) => this.applyAuthFinished(serverId, event))
      const stopStatus = serverConnections.onReadinessChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'ready') void this.load(serverId)
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
    const state = this.states.get(serverId) ?? this.emptyState(serverId)
    const revision = state.revision + 1
    this.states.set(serverId, { ...state, loading: true, revision })
    void this.loadConnections(serverId)
    try {
      const integrations = await serverConnections.apiFor(serverId).integrationList()
      const current = this.states.get(serverId)
      if (current?.revision !== revision) return
      this.states.set(serverId, { ...current, integrations, loading: false, error: '', isUnsupported: false, isDisconnected: false })
      for (const id of current.tools.keys()) {
        if (!integrations.some((integration) => integration.id === id)) { current.tools.delete(id); current.processes.forget(id) }
      }
      for (const integration of integrations) if (showsFactsOnRow(integration)) void current.processes.load(integration.id)
    } catch (cause) {
      const current = this.states.get(serverId)
      if (current?.revision !== revision) return
      const isUnsupported = isUnsupportedHostError(cause)
      const isDisconnected = serverConnections.readinessFor(serverId).readiness !== 'ready'
      this.states.set(serverId, { ...current, loading: false, isUnsupported, isDisconnected, error: isUnsupported ? '' : 'Could not load integrations.' })
    }
  }

  async loadTools(serverId: string, integrationId: string): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    state.toolErrors.delete(integrationId)
    // The facts only add the instructions section: a facts read that fails, or an
    // older host without it, keeps what the row had and keeps the tools.
    void state.processes.load(integrationId)
    try {
      const tools = await serverConnections.apiFor(serverId).integrationTools({ id: integrationId })
      this.states.get(serverId)?.tools.set(integrationId, tools)
    } catch (cause) {
      this.states.get(serverId)?.toolErrors.set(integrationId, errorText(cause, 'Could not load the tools.'))
    }
  }

  private emptyState(serverId: string): IntegrationsState {
    const facts = new SvelteMap<string, IntegrationFacts>()
    const toolErrors = new SvelteMap<string, string>()
    const processes = new CommandProcesses({
      api: () => serverConnections.apiFor(serverId),
      facts,
      starting: new SvelteSet(),
      errors: new SvelteMap(),
      // A loopback server that runs again lists its tools in an open row, not the error of when it stopped (§9.3).
      onFacts: (integrationId, answer) => { if (answer.reachable === 'running') toolErrors.delete(integrationId) },
      // A started command lists its tools for its open row (§7.7).
      onStarted: (integrationId) => { void this.loadTools(serverId, integrationId) },
    })
    return {
      integrations: null, tools: new SvelteMap(), facts, toolErrors, loading: false, error: '', saving: false, writeError: '', isUnsupported: false, isDisconnected: false, revision: 0,
      connections: new SvelteMap(), connectionsStatus: 'loading', connectFlows: new SvelteMap(), processes,
    }
  }

  async create(serverId: string, request: IntegrationCreateRequest): Promise<Integration | null> {
    return this.write(serverId, 'Could not add the integration.', async () => {
      const integration = await serverConnections.apiFor(serverId).integrationCreate(request)
      this.upsert(serverId, integration)
      return integration
    })
  }

  async update(serverId: string, request: IntegrationUpdateRequest): Promise<Integration | null> {
    return this.write(serverId, 'Could not save the integration.', async () => {
      const integration = await serverConnections.apiFor(serverId).integrationUpdate(request)
      this.upsert(serverId, integration)
      return integration
    })
  }

  /**
   * Saves or, with null, removes the owner's custom OAuth client. A custom
   * client selects host sign-in. The secret goes to the host in this one
   * call and is not kept: the record that comes back says only whether it has one.
   */
  async setOAuthClient(serverId: string, integrationId: string, oauthClient: IntegrationOAuthClientInput | null): Promise<Integration | null> {
    return this.write(serverId, oauthClient ? 'Could not save the OAuth client.' : 'Could not remove the OAuth client.', async () => {
      await this.cancel(serverId, integrationId)
      const integration = await serverConnections.apiFor(serverId).integrationUpdate({ id: integrationId, oauthClient })
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

  /** One page of the catalog. Throws when the catalog is unavailable. */
  catalogPage(serverId: string, query: string, category: CatalogCategoryId | null, offset: number, limit: number): Promise<CatalogPage> {
    const request: IntegrationCatalogListRequest = { query: query || undefined, offset, limit }
    // A host from before categories refuses the field, so it is sent only when set.
    if (category) request.category = category
    return serverConnections.apiFor(serverId).integrationCatalogList(request)
  }

  /**
   * The caller's own integration that cannot start a sign-in until its owner
   * enters an OAuth client (§13.2), or null. Integrations are personal, so only
   * the owner's list holds it and only the owner gets the form.
   */
  /** What the caller must set up at the vendor before their own integration can connect (§13.4), as its hand-off; null when nothing. */
  setupHandoff(serverId: string, integrationId: string): SetupHandoff | null {
    const integration = this.states.get(serverId)?.integrations?.find((item) => item.id === integrationId)
    if (!integration) return null
    return new IntegrationSignIn(integration).setupHandoffFor(this.connection(serverId, integrationId), { name: integration.name, callbackUrl: INTEGRATION_OAUTH_LOOPBACK_URL })
  }

  integrationNeedingClient(serverId: string, integrationId: string): Integration | null {
    const integration = this.states.get(serverId)?.integrations?.find((item) => item.id === integrationId)
    return integration && new IntegrationSignIn(integration).needsOwnerClient ? integration : null
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
      const all = await serverConnections.apiFor(serverId).integrationConnectionList()
      const current = this.states.get(serverId)
      if (!current || this.connectionRevisions.get(serverId) !== revision) return
      this.accounts.load(serverId, all)
      const list = all.filter(isFirstIntegrationAccount)
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
    if (change === 'tools' || change === 'facts') {
      if (state.tools.has(integrationId)) void this.loadTools(serverId, integrationId)
      // A command's process state, and whether a loopback server runs, show on its row, open or not.
      else if (showsFactsOnRow(state.integrations?.find((item) => item.id === integrationId))) void state.processes.load(integrationId)
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
      // A changed command stopped and lost its facts (§7.6).
      if (integration?.kind === 'stdio') void state.processes.load(integrationId)
    } catch {
      if (this.eventSequence.get(key) === sequence) void this.load(serverId)
    }
  }

  private applyConnectionChange(serverId: string, event: IntegrationConnectionChangedEvent): void {
    const state = this.states.get(serverId)
    if (!state) return
    const { integrationId, connection } = event
    const accountId = connection?.accountId ?? event.accountId
    const previous = accountId && !isFirstIntegrationAccount({ accountId })
      ? this.accounts.accounts(serverId, integrationId).find((account) => account.accountId === accountId)
      : state.connections.get(integrationId)
    if (previous?.status === 'connected' && connection?.status === 'needs-sign-in') {
      const name = state.integrations?.find((integration) => integration.id === integrationId)?.name ?? 'An MCP server'
      this.onSignInExpired?.(serverId, name)
    }
    if (this.accounts.apply(serverId, event)) return
    this.connectionEventsDuringLoad.get(serverId)?.add(integrationId)
    if (connection) state.connections.set(integrationId, connection)
    else state.connections.delete(integrationId)
  }

  private upsert(serverId: string, integration: Integration): void {
    const state = this.states.get(serverId)
    if (!state?.integrations) return
    this.states.set(serverId, { ...state, integrations: upsertById(state.integrations, integration) })
  }

  private drop(serverId: string, integrationId: string): void {
    const state = this.states.get(serverId)
    if (!state) return
    state.tools.delete(integrationId)
    state.processes.forget(integrationId)
    state.toolErrors.delete(integrationId)
    state.connections.delete(integrationId)
    this.nextAttempt(serverId, integrationId)
    this.clearFlow(serverId, integrationId)
    if (state.integrations?.some((item) => item.id === integrationId)) {
      this.states.set(serverId, { ...state, integrations: state.integrations.filter((item) => item.id !== integrationId) })
    }
  }
}
