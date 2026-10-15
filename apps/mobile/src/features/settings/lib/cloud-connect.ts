import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { DocumentSyncClock } from '@solus/client-core/document-sync'
import type { AccountVaultConnectResult, AccountVaultResult } from '@solus/contracts/host-api'
import type { IntegrationAuth } from '@solus/contracts/integration-types'
import type { VaultSaveKeyRequest } from '@solus/contracts/vault'
import { cloudConnectStarted, connectFailed, connectRefused, connectSubmitting, errorMessage, type ConnectFlowState } from '../integrations'

/**
 * A signed-in person's sign-in to an MCP server, run at Solus Cloud
 * (plans/020-agent-profile.md §5.3). The request carries the auth the host
 * probed, since the server need not be in the person's profile. The cloud is the OAuth client and the one
 * refresher: a browser sign-in lands its callback on the cloud, and this reads
 * the account's connections until the server reports connected; a pasted key
 * goes to the cloud, which checks it against the server. Either end asks every
 * host to pull, so their rows move to the cloud path. Flows are keyed by the
 * caller's own key (an integration id); one key holds one flow at a time.
 */

export const CLOUD_CONNECT_POLL_MS = 3_000
export const CLOUD_CONNECT_TIMEOUT_MS = 10 * 60_000

export type CloudConnectRequests = Pick<AgentProfileCloudRequests, 'accountVault' | 'accountVaultConnect' | 'accountVaultSaveKey' | 'accountVaultDisconnect'>

export interface CloudConnectDeps {
  requests: CloudConnectRequests
  openBrowser(url: string): Promise<void>
  /** A connection landed in the account or left it: every host reads it on its next pull. */
  pullEverywhere(): void
  clock: DocumentSyncClock
}

interface Flow {
  serverUrl: string
  name: string
  auth: IntegrationAuth
  state: ConnectFlowState
  cancelPoll: (() => void) | null
}

export class CloudConnect {
  private readonly flows = new Map<string, Flow>()

  constructor(private readonly deps: CloudConnectDeps, private readonly onChange: (key: string, state: ConnectFlowState | null) => void) {}

  /** True while a flow of this key runs here, so the caller routes its open, submit, and cancel here. */
  has(key: string): boolean {
    return this.flows.has(key)
  }

  /** Starts the sign-in; a browser page opens at once. Any earlier flow of the key ends. */
  async start(key: string, serverUrl: string, name: string, auth: IntegrationAuth): Promise<void> {
    this.stop(key)
    const flow: Flow = { serverUrl, name, auth, state: { step: 'starting' }, cancelPoll: null }
    this.flows.set(key, flow)
    this.onChange(key, flow.state)
    const result = await this.deps.requests.accountVaultConnect({ ref: { kind: 'mcp', serverUrl }, auth })
    if (this.flows.get(key) !== flow) return
    if (result.kind !== 'ok') return this.finish(key, flow, connectRefused(unavailableMessage(result)))
    const state = cloudConnectStarted(result.start, serverUrl, name)
    if (state.step === 'finished') return this.finish(key, flow, state)
    this.set(key, flow, state)
    if (state.step === 'waiting') {
      this.open(key)
      this.poll(key, flow, this.deps.clock.now() + CLOUD_CONNECT_TIMEOUT_MS)
    }
  }

  /** Opens the sign-in page of a waiting flow again. */
  open(key: string): void {
    const flow = this.flows.get(key)
    if (flow?.state.step !== 'waiting') return
    this.deps.openBrowser(flow.state.url).catch((cause: unknown) => {
      if (this.flows.get(key) === flow) this.set(key, flow, connectFailed(flow.state, errorMessage(cause)))
    })
  }

  /** Sends a pasted key to the cloud, which checks it against the server before it keeps it. */
  async submitKey(key: string, value: string): Promise<void> {
    const flow = this.flows.get(key)
    const trimmed = value.trim()
    if (flow?.state.step !== 'token' || flow.state.busy || !trimmed) return
    this.set(key, flow, connectSubmitting(flow.state))
    const request: VaultSaveKeyRequest = { ref: { kind: 'mcp', serverUrl: flow.serverUrl }, key: trimmed }
    if (flow.auth.kind === 'bearer') request.scheme = flow.auth.scheme
    const result = await this.deps.requests.accountVaultSaveKey(request)
    if (this.flows.get(key) !== flow) return
    if (isConnected(result, flow.serverUrl)) return this.connected(key, flow)
    this.set(key, flow, connectFailed(flow.state, result.kind === 'ok' ? 'The server did not accept the key.' : unavailableMessage(result)))
  }

  /** Ends a flow here; the page the person may still have open is simply left. */
  cancel(key: string): void {
    if (!this.stop(key)) return
    this.onChange(key, null)
  }

  /** Removes the person's credential from their account; hosts stop using it on their next pull. */
  async disconnect(serverUrl: string): Promise<void> {
    const result = await this.deps.requests.accountVaultDisconnect({ ref: { kind: 'mcp', serverUrl } })
    if (result.kind !== 'ok') throw new Error(unavailableMessage(result))
    this.deps.pullEverywhere()
  }

  dispose(): void {
    for (const key of Array.from(this.flows.keys())) this.stop(key)
  }

  private poll(key: string, flow: Flow, deadline: number): void {
    flow.cancelPoll = this.deps.clock.setTimer(() => {
      flow.cancelPoll = null
      void this.deps.requests.accountVault().then((result) => {
        if (this.flows.get(key) !== flow) return
        if (isConnected(result, flow.serverUrl)) return this.connected(key, flow)
        if (this.deps.clock.now() >= deadline) return this.finish(key, flow, connectRefused('The sign-in did not finish in time. Connect again.'))
        this.poll(key, flow, deadline)
      })
    }, CLOUD_CONNECT_POLL_MS)
  }

  private connected(key: string, flow: Flow): void {
    this.finish(key, flow, { step: 'finished', ok: true, message: `Connected to ${flow.name} through Solus Cloud.` })
    this.deps.pullEverywhere()
  }

  /** The flow's last state: it stays on screen until the caller closes it. */
  private finish(key: string, flow: Flow, state: ConnectFlowState): void {
    if (this.flows.get(key) !== flow) return
    this.stop(key)
    this.onChange(key, state)
  }

  private set(key: string, flow: Flow, state: ConnectFlowState): void {
    flow.state = state
    this.onChange(key, state)
  }

  private stop(key: string): boolean {
    const flow = this.flows.get(key)
    if (!flow) return false
    flow.cancelPoll?.()
    this.flows.delete(key)
    return true
  }
}

function isConnected(result: AccountVaultResult, serverUrl: string): boolean {
  return result.kind === 'ok' && result.connections.some((connection) => connection.ref.kind === 'mcp' && connection.ref.serverUrl === serverUrl && connection.status === 'connected')
}

function unavailableMessage(result: Exclude<AccountVaultConnectResult | AccountVaultResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'refused': return result.message
    case 'signed-out': return 'Sign in to Solus Cloud again to connect.'
    case 'offline': return 'Solus Cloud did not answer. Check your connection and try again.'
    case 'error': return `Solus Cloud refused: ${result.message ?? result.code}.`
  }
}
