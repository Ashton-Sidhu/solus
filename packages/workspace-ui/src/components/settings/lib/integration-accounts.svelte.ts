import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { DEFAULT_INTEGRATION_ACCOUNT, isFirstIntegrationAccount, type IntegrationAuthFinishedEvent, type IntegrationConnection, type IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'

/** One "Add another account" that runs: its sign-in on the host and the page to reopen, or why it stopped. */
export interface AddingAccount {
  flowId: string | null
  url: string | null
  error: string
}

const STARTING: AddingAccount = { flowId: null, url: null, error: '' }

function stopped(error: string): AddingAccount {
  return { flowId: null, url: null, error }
}

function accountsKey(serverId: string, integrationId: string): string {
  return `${serverId}\u0000${integrationId}`
}

function errorText(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : ''
  return message || fallback
}

/**
 * The caller's accounts after the first on each integration
 * (docs/plans/mcp-integrations.md §13.3), beside the integrations store, which
 * keeps the first account and its sign-in flows. An added account lives on the
 * host it was connected on. Its sign-in ends on the host, and the new account
 * arrives as `integration.connectionChanged`.
 */
export class IntegrationAccounts {
  /** By server and integration: the accounts after the first, oldest first. */
  private readonly extra = new SvelteMap<string, IntegrationConnection[]>()
  /** By server and integration: an add that runs or stopped. */
  private readonly adding = new SvelteMap<string, AddingAccount>()

  /** The accounts after the first, as the integration row lists them. */
  accounts(serverId: string, integrationId: string): IntegrationConnection[] {
    return this.extra.get(accountsKey(serverId, integrationId)) ?? []
  }

  addState(serverId: string, integrationId: string): AddingAccount | null {
    return this.adding.get(accountsKey(serverId, integrationId)) ?? null
  }

  /** A full connection list from the host: every account after the first, by integration. */
  load(serverId: string, list: readonly IntegrationConnection[]): void {
    const byIntegration = new Map<string, IntegrationConnection[]>()
    for (const connection of list) {
      if (isFirstIntegrationAccount(connection)) continue
      byIntegration.set(connection.integrationId, [...(byIntegration.get(connection.integrationId) ?? []), connection])
    }
    for (const key of [...this.extra.keys()]) {
      if (key.startsWith(`${serverId}\u0000`)) this.extra.delete(key)
    }
    for (const [integrationId, connections] of byIntegration) this.extra.set(accountsKey(serverId, integrationId), connections)
  }

  /** Applies a change to an account after the first; false for the first account, which the store keeps. */
  apply(serverId: string, event: IntegrationConnectionChangedEvent): boolean {
    const accountId = event.connection?.accountId ?? event.accountId ?? DEFAULT_INTEGRATION_ACCOUNT
    if (accountId === DEFAULT_INTEGRATION_ACCOUNT) return false
    const key = accountsKey(serverId, event.integrationId)
    const others = this.accounts(serverId, event.integrationId).filter((connection) => connection.accountId !== accountId)
    this.extra.set(key, event.connection ? [...others, event.connection] : others)
    // The add that waited for this account ended.
    if (event.connection?.status === 'connected') this.adding.delete(key)
    return true
  }

  /** Signs in one more account in the browser; `open` opens the sign-in page on this device. */
  async add(serverId: string, integrationId: string, open: (url: string) => Promise<void>): Promise<void> {
    const key = accountsKey(serverId, integrationId)
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
    const key = accountsKey(serverId, event.integrationId)
    if (!event.flowId || this.adding.get(key)?.flowId !== event.flowId) return false
    if (event.outcome === 'failed') this.adding.set(key, stopped(event.message?.trim() || 'The sign-in did not finish.'))
    else if (event.outcome === 'cancelled') this.adding.delete(key)
    return true
  }

  /** Stops the add here and its sign-in on the host. */
  cancelAdd(serverId: string, integrationId: string): void {
    const key = accountsKey(serverId, integrationId)
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
