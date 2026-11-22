import type { CommandProcesses } from '@solus/client-core/command-processes'
import { DEFAULT_INTEGRATION_ACCOUNT, isFirstIntegrationAccount, type Integration, type IntegrationAuthFinishedEvent, type IntegrationConnection, type IntegrationConnectionChangedEvent, type IntegrationEnvValue, type IntegrationFacts, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { VaultSaveKeyRequest } from '@solus/contracts/vault'

/**
 * The caller's sign-in to one integration while it runs (§4.3). Absent when no
 * sign-in runs. `waiting` and `token` carry `error` after a rejected submit, so
 * the person can correct what they pasted. `submitting` keeps the flow ID of a
 * waiting flow: its end arrives as `host.integrationAuthFinished`. A flow
 * `through: 'cloud'` runs at Solus Cloud, not on the host (plans/020 §5.3):
 * its end is read by polling the account, and no host flow exists to cancel.
 * `values` asks for the environment values of a command (mcp-first-class.md
 * §7.7): the names only; the values stay in the form until the submit.
 */
export type IntegrationConnectFlow =
  | { kind: 'starting' }
  | { kind: 'waiting'; flowId: string; url: string; input: 'callback' | 'redirect-url'; expiresAt: string; error?: string; through?: 'cloud' }
  | { kind: 'token'; error?: string; through?: 'cloud' }
  | { kind: 'values'; names: string[]; error?: string }
  | { kind: 'submitting'; flowId?: string; through?: 'cloud' }
  | { kind: 'disconnecting' }
  | { kind: 'failed'; message: string }

/**
 * Where a signed-in person's sign-in runs (plans/020-agent-profile.md §5.3): at
 * the cloud, which is the OAuth client and the only refresher, for every server
 * the host shows them. Installed by the app core, so this store imports no
 * account state; tests install a fake.
 */
export interface CloudSignInPort {
  /** The account calls, or null when this client has no account to call. */
  requests(): AgentProfileCloudRequests | null
  /** The signed-in person's id, or null. */
  accountUserId(): string | null
  /** A connection moved in the account: this host reads it before the promise settles, and every other host the profile applies to pulls too. */
  pullHosts(serverId: string): Promise<void>
  /** Calls `callback` once after `ms`; the returned function cancels it. */
  setTimer(callback: () => void, ms: number): () => void
}

/** How often a cloud sign-in is read back, and for how long, before it is given up. */
export const CLOUD_SIGN_IN_POLL_MS = 3_000
export const CLOUD_SIGN_IN_TIMEOUT_MS = 10 * 60_000

export type ConnectionsStatus = 'loading' | 'loaded' | 'unsupported' | 'error'
export interface IntegrationsState {
  /** Null until the first list arrives. */
  integrations: Integration[] | null
  /** The tools of each integration whose tools were asked for. */
  tools: SvelteMap<string, IntegrationToolSummary[]>
  facts: SvelteMap<string, IntegrationFacts>
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
  /** The person's processes of the commands, with the facts above (mcp-first-class.md §7.7). */
  processes: CommandProcesses
}

/** An older host answers an unknown RPC with one of these messages. */
export function isUnsupportedHostError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /no handler for|unknown method|unknown rpc|not registered|not a function/i.test(message)
}

export function errorText(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : ''
  return message || fallback
}

/** The key of one integration on one host, for the maps of its sign-ins and accounts. */
function integrationKey(serverId: string, integrationId: string): string {
  return `${serverId}\u0000${integrationId}`
}

/** One "Add another account" that runs: its sign-in on the host and the page to reopen, or why it stopped. */
interface AddingAccount {
  flowId: string | null
  url: string | null
  error: string
}

const STARTING: AddingAccount = { flowId: null, url: null, error: '' }

function stopped(error: string): AddingAccount {
  return { flowId: null, url: null, error }
}

/**
 * The caller's accounts after the first on each integration
 * (docs/plans/mcp-integrations.md §13.3), beside the integrations store, which
 * keeps the first account and its sign-in flows. An added account lives on the
 * host it was connected on. Its sign-in ends on the host, and the new account
 * arrives as `integration.connectionChanged`.
 */
class IntegrationAccounts {
  /** By server and integration: the accounts after the first, oldest first. */
  private readonly extra = new SvelteMap<string, IntegrationConnection[]>()
  /** By server and integration: an add that runs or stopped. */
  private readonly adding = new SvelteMap<string, AddingAccount>()

  /** The accounts after the first, as the integration row lists them. */
  accounts(serverId: string, integrationId: string): IntegrationConnection[] {
    return this.extra.get(integrationKey(serverId, integrationId)) ?? []
  }

  /** Every account after the first, on every host, that matches `test`. */
  count(test: (connection: IntegrationConnection) => boolean): number {
    let count = 0
    for (const connections of this.extra.values()) count += connections.filter(test).length
    return count
  }

  /** Forgets the accounts of a host that was removed. */
  forget(serverId: string): void {
    for (const key of [...this.extra.keys()]) {
      if (key.startsWith(`${serverId}\u0000`)) this.extra.delete(key)
    }
  }

  addState(serverId: string, integrationId: string): AddingAccount | null {
    return this.adding.get(integrationKey(serverId, integrationId)) ?? null
  }

  /** A full connection list from the host: every account after the first, by integration. */
  load(serverId: string, list: readonly IntegrationConnection[]): void {
    const byIntegration = new Map<string, IntegrationConnection[]>()
    for (const connection of list) {
      if (isFirstIntegrationAccount(connection)) continue
      byIntegration.set(connection.integrationId, [...(byIntegration.get(connection.integrationId) ?? []), connection])
    }
    this.forget(serverId)
    for (const [integrationId, connections] of byIntegration) this.extra.set(integrationKey(serverId, integrationId), connections)
  }

  /** Applies a change to an account after the first; false for the first account, which the store keeps. */
  apply(serverId: string, event: IntegrationConnectionChangedEvent): boolean {
    const accountId = event.connection?.accountId ?? event.accountId ?? DEFAULT_INTEGRATION_ACCOUNT
    if (accountId === DEFAULT_INTEGRATION_ACCOUNT) return false
    const key = integrationKey(serverId, event.integrationId)
    const others = this.accounts(serverId, event.integrationId).filter((connection) => connection.accountId !== accountId)
    this.extra.set(key, event.connection ? [...others, event.connection] : others)
    // The add that waited for this account ended.
    if (event.connection?.status === 'connected') this.adding.delete(key)
    return true
  }

  /** Signs in one more account in the browser; `open` opens the sign-in page on this device. */
  async add(serverId: string, integrationId: string, open: (url: string) => Promise<void>): Promise<void> {
    const key = integrationKey(serverId, integrationId)
    this.adding.set(key, STARTING)
    try {
      const result = await serverConnections.apiFor(serverId).integrationConnectStart({
        id: integrationId,
        newAccount: true,
        callbackBaseUrl: serverConnections.httpOriginFor(serverId),
      })
      if (result.kind !== 'waiting') {
        this.adding.set(key, stopped('This server takes one API key per person.'))
        return
      }
      this.adding.set(key, { flowId: result.flowId, url: result.url, error: '' })
      await open(result.url)
    } catch (cause) {
      this.adding.set(key, stopped(errorText(cause, 'Could not start the sign-in.')))
    }
  }

  /**
   * A sign-in ended on the host. A failed or cancelled add stops here, with the
   * reason; a connected one ends when its account arrives. False when the
   * sign-in was not an add, so the store's own flows read it.
   */
  finished(serverId: string, event: IntegrationAuthFinishedEvent): boolean {
    const key = integrationKey(serverId, event.integrationId)
    if (!event.flowId || this.adding.get(key)?.flowId !== event.flowId) return false
    if (event.outcome === 'failed') this.adding.set(key, stopped(event.message?.trim() || 'The sign-in did not finish.'))
    else if (event.outcome === 'cancelled') this.adding.delete(key)
    return true
  }

  /** Stops the add here and its sign-in on the host. */
  cancelAdd(serverId: string, integrationId: string): void {
    const key = integrationKey(serverId, integrationId)
    const flowId = this.adding.get(key)?.flowId
    this.adding.delete(key)
    if (flowId) void serverConnections.apiFor(serverId).integrationConnectCancel({ flowId }).catch(() => undefined)
  }

  /** Disconnects one account after the first; the first is the store's. True when the host removed it. */
  async disconnect(serverId: string, integrationId: string, accountId: string): Promise<boolean> {
    try {
      const { disconnected } = await serverConnections.apiFor(serverId).integrationDisconnect({ id: integrationId, accountId })
      this.apply(serverId, { integrationId, accountId, connection: null })
      return disconnected
    } catch {
      return false
    }
  }
}

/** The flow ID the host knows a flow by, when the flow waits on the host. A cloud flow has none. */
function hostFlowId(flow: IntegrationConnectFlow | undefined): string | undefined {
  if (flow?.kind !== 'waiting' && flow?.kind !== 'submitting') return undefined
  return flow.through === 'cloud' ? undefined : flow.flowId
}

function isCloudFlow(flow: IntegrationConnectFlow | undefined): boolean {
  return (flow?.kind === 'waiting' || flow?.kind === 'token' || flow?.kind === 'submitting') && flow.through === 'cloud'
}

/** The words for a refused or unanswered account call. */
function cloudFailureText(result: { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'error'; code: string; message: string | null } | { kind: 'refused'; message: string }): string {
  switch (result.kind) {
    case 'refused': return result.message
    case 'signed-out': return 'Sign in to Solus again to connect through your account.'
    case 'offline': return 'You are offline. Try again when you reconnect.'
    case 'error': return result.message ?? `Solus could not reach your account (${result.code}).`
  }
}

/** setTimeout's largest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The caller's sign-ins to the integrations of each host while they run (§4.3),
 * over the per-host state they share with the list. A sign-in runs here, not
 * in a component, so the Settings row and the conversation card show the same
 * flow. `IntegrationsStore` extends it with the list, the tools, and the
 * connections; it reads the connections again when a sign-in ends.
 */
export abstract class IntegrationSignIns {
  states = new SvelteMap<string, IntegrationsState>()
  /** The caller's accounts after the first (§13.3); `connections` keeps the first. */
  readonly accounts = new IntegrationAccounts()
  /** Per host and integration: bumped by every flow command, so an older answer does not land. */
  private flowAttempts = new Map<string, number>()
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per host and integration: stops the read-back of a cloud sign-in. */
  private cloudPolls = new Map<string, () => void>()
  private cloud: CloudSignInPort | null = null

  /** Installs where a synced person's own sign-ins run. Until then every sign-in runs on the host. */
  useCloudSignIn(port: CloudSignInPort | null): void {
    this.cloud = port
  }

  /** A server the person owns, while their profile syncs: its sign-in runs at the cloud, not on the host. */
  /**
   * The cloud, when this person's sign-in runs there: they are signed in, and the
   * server's sign-in does not have to run on the host (`signsInOnHost`).
   */
  private cloudFor(integration: Integration | undefined): CloudSignInPort | null {
    const cloud = this.cloud
    if (!cloud || !integration || cloud.accountUserId() === null) return null
    return new IntegrationSignIn(integration).signsInOnHost ? null : cloud
  }

  /** Reads the caller's connections on one host again. */
  abstract loadConnections(serverId: string): Promise<void>

  /** The caller's connection to one integration, or null when they have none. */
  connection(serverId: string, integrationId: string): IntegrationConnection | null {
    return this.states.get(serverId)?.connections.get(integrationId) ?? null
  }

  /** The sign-in that runs for one integration, or null when none runs. */
  connectFlow(serverId: string, integrationId: string): IntegrationConnectFlow | null {
    return this.states.get(serverId)?.connectFlows.get(integrationId) ?? null
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
    const integration = state.integrations?.find((item) => item.id === integrationId)
    const cloud = this.cloudFor(integration)
    if (integration && cloud) return this.connectThroughCloud(serverId, integration, cloud)
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
      } else if (result.kind === 'env') {
        this.setFlow(serverId, integrationId, { kind: 'values', names: result.names })
      } else {
        this.setFlow(serverId, integrationId, { kind: 'waiting', flowId: result.flowId, url: result.url, input: result.input, expiresAt: result.expiresAt })
        this.scheduleExpiry(serverId, integrationId, result.flowId, result.expiresAt)
        void this.openInBrowser(result.url)
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
    if (flow.kind === 'token' && flow.through === 'cloud') return this.submitKeyThroughCloud(serverId, integrationId, trimmed)
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

  /**
   * Hands over the environment values of a command (§7.7), one for each name.
   * They go to the host in this one call and are never kept here: not in the
   * flow, not in an error. True when the host saved them.
   */
  async submitValues(serverId: string, integrationId: string, values: IntegrationEnvValue[]): Promise<boolean> {
    const flow = this.states.get(serverId)?.connectFlows.get(integrationId)
    const names = flow?.kind === 'values' ? flow.names : values.map((value) => value.name)
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'submitting' })
    try {
      await serverConnections.apiFor(serverId).integrationConnectSubmit({ id: integrationId, values })
      await this.settleConnected(serverId, integrationId, attempt)
      return true
    } catch (cause) {
      if (this.isCurrent(serverId, integrationId, attempt)) {
        this.setFlow(serverId, integrationId, { kind: 'values', names, error: errorText(cause, 'The host did not save the values.') })
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
    const state = this.states.get(serverId)
    if (!state) return false
    const integration = state.integrations?.find((item) => item.id === integrationId)
    // A connection in the account is removed there; every host learns on its pull.
    const cloud = state.connections.get(integrationId)?.source === 'cloud' ? this.cloudFor(integration) ?? this.cloud : null
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'disconnecting' })
    try {
      if (cloud && integration) {
        const requests = cloud.requests()
        const result = requests ? await requests.accountVaultDisconnect({ ref: { kind: 'mcp', serverUrl: integration.url } }) : { kind: 'signed-out' as const }
        if (result.kind !== 'ok') throw new Error(cloudFailureText(result))
        await cloud.pullHosts(serverId)
      } else {
        await serverConnections.apiFor(serverId).integrationDisconnect({ id: integrationId })
      }
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

  /**
   * The sign-in runs at Solus Cloud (plans/020 §5.3): the cloud answers the
   * browser page or asks for a key, and holds what comes back. Its end is not
   * an event here: the account is read every few seconds until that server is
   * connected, then every host pulls and reads the credential from the cloud.
   */
  private async connectThroughCloud(serverId: string, integration: Integration, cloud: CloudSignInPort): Promise<void> {
    const integrationId = integration.id
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'starting' })
    const requests = cloud.requests()
    const result = requests ? await requests.accountVaultConnect({ ref: { kind: 'mcp', serverUrl: integration.url }, auth: integration.auth }) : { kind: 'signed-out' as const }
    if (!this.isCurrent(serverId, integrationId, attempt)) return
    if (result.kind !== 'ok') {
      this.setFlow(serverId, integrationId, { kind: 'failed', message: cloudFailureText(result) })
      return
    }
    const start = result.start
    if (start.kind === 'none') {
      this.clearFlow(serverId, integrationId)
    } else if (start.kind === 'key') {
      this.setFlow(serverId, integrationId, { kind: 'token', through: 'cloud' })
    } else {
      const expiresAt = new Date(Date.now() + CLOUD_SIGN_IN_TIMEOUT_MS).toISOString()
      this.setFlow(serverId, integrationId, { kind: 'waiting', flowId: `cloud:${integration.url}`, url: start.url, input: 'callback', expiresAt, through: 'cloud' })
      this.pollCloudSignIn(serverId, integration, cloud, attempt)
      void this.openInBrowser(start.url)
    }
  }

  /** Reads the account until the server is connected, or the sign-in is given up. */
  private pollCloudSignIn(serverId: string, integration: Integration, cloud: CloudSignInPort, attempt: number): void {
    const integrationId = integration.id
    const key = integrationKey(serverId, integrationId)
    const deadline = Date.now() + CLOUD_SIGN_IN_TIMEOUT_MS
    const read = async () => {
      this.cloudPolls.delete(key)
      if (!this.isCurrent(serverId, integrationId, attempt)) return
      const requests = cloud.requests()
      const result = requests ? await requests.accountVault() : null
      if (!this.isCurrent(serverId, integrationId, attempt)) return
      const connected = result?.kind === 'ok' && result.connections.some((connection) => connection.ref.kind === 'mcp' && connection.ref.serverUrl === integration.url && connection.status === 'connected')
      if (connected) {
        await this.settleCloudConnected(serverId, integrationId, cloud, attempt)
        return
      }
      if (Date.now() >= deadline) {
        this.setFlow(serverId, integrationId, { kind: 'failed', message: 'The sign-in expired. Connect again.' })
        return
      }
      this.cloudPolls.set(key, cloud.setTimer(() => void read(), CLOUD_SIGN_IN_POLL_MS))
    }
    this.cloudPolls.set(key, cloud.setTimer(() => void read(), CLOUD_SIGN_IN_POLL_MS))
  }

  /** A pasted key goes to the cloud, which checks it against the server before it seals it. */
  private async submitKeyThroughCloud(serverId: string, integrationId: string, key: string): Promise<boolean> {
    const integration = this.states.get(serverId)?.integrations?.find((item) => item.id === integrationId)
    const cloud = this.cloudFor(integration)
    if (!integration || !cloud) return false
    const attempt = this.nextAttempt(serverId, integrationId)
    this.setFlow(serverId, integrationId, { kind: 'submitting', through: 'cloud' })
    const requests = cloud.requests()
    const request: VaultSaveKeyRequest = { ref: { kind: 'mcp', serverUrl: integration.url }, key }
    if (integration.auth.kind === 'bearer') request.scheme = integration.auth.scheme
    const result = requests ? await requests.accountVaultSaveKey(request) : { kind: 'signed-out' as const }
    if (!this.isCurrent(serverId, integrationId, attempt)) return true
    const connected = result.kind === 'ok' && result.connections.some((connection) => connection.ref.kind === 'mcp' && connection.ref.serverUrl === integration.url && connection.status === 'connected')
    if (connected) {
      await this.settleCloudConnected(serverId, integrationId, cloud, attempt)
      return true
    }
    this.setFlow(serverId, integrationId, { kind: 'token', through: 'cloud', error: result.kind === 'ok' ? 'The server did not accept that key.' : cloudFailureText(result) })
    return false
  }

  /** The cloud holds the connection: this host pulls, and its row is read before the flow clears. */
  private async settleCloudConnected(serverId: string, integrationId: string, cloud: CloudSignInPort, attempt: number): Promise<void> {
    await cloud.pullHosts(serverId)
    await this.loadConnections(serverId)
    if (this.isCurrent(serverId, integrationId, attempt)) this.clearFlow(serverId, integrationId)
  }

  /** Opens a page, such as a sign-in or a vendor setup guide, on this device, never on the host, as the Google sign-in does. */
  async openInBrowser(url: string): Promise<void> {
    const opened = await localApi.openExternal?.(url).catch(() => false)
    if (!opened) globalThis.window?.open(url, '_blank', 'noopener,noreferrer')
  }

  protected applyAuthFinished(serverId: string, event: IntegrationAuthFinishedEvent): void {
    if (this.accounts.finished(serverId, event)) return
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
  protected dropHostFlows(serverId: string): void {
    const state = this.states.get(serverId)
    if (!state) return
    for (const [integrationId, flow] of state.connectFlows) {
      if (flow.kind === 'token' || flow.kind === 'values' || flow.kind === 'failed' || isCloudFlow(flow)) continue
      this.nextAttempt(serverId, integrationId)
      this.clearFlow(serverId, integrationId)
    }
  }

  private scheduleExpiry(serverId: string, integrationId: string, flowId: string, expiresAt: string): void {
    const delay = Date.parse(expiresAt) - Date.now()
    if (!Number.isFinite(delay)) return
    const key = integrationKey(serverId, integrationId)
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

  protected nextAttempt(serverId: string, integrationId: string): number {
    const key = integrationKey(serverId, integrationId)
    const attempt = (this.flowAttempts.get(key) ?? 0) + 1
    this.flowAttempts.set(key, attempt)
    return attempt
  }

  private isCurrent(serverId: string, integrationId: string, attempt: number): boolean {
    return this.flowAttempts.get(integrationKey(serverId, integrationId)) === attempt
  }

  private setFlow(serverId: string, integrationId: string, flow: IntegrationConnectFlow): void {
    if (flow.kind !== 'waiting' && flow.kind !== 'submitting') this.clearExpiry(serverId, integrationId)
    this.states.get(serverId)?.connectFlows.set(integrationId, flow)
  }

  protected clearFlow(serverId: string, integrationId: string): void {
    this.clearExpiry(serverId, integrationId)
    this.states.get(serverId)?.connectFlows.delete(integrationId)
  }

  private clearExpiry(serverId: string, integrationId: string): void {
    const key = integrationKey(serverId, integrationId)
    const timer = this.expiryTimers.get(key)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(key)
    this.cloudPolls.get(key)?.()
    this.cloudPolls.delete(key)
  }

}
