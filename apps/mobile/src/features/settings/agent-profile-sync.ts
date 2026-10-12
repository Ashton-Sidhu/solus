import {
  AgentProfileSync,
  type AgentProfileEnableOutcome,
  type AgentProfileSyncPorts,
  type AgentProfileSyncStatus,
} from '@solus/client-core/agent-profile-sync'
import type { HostApi } from '@solus/client-core/host-api'
import {
  syncAccountKey,
  type SyncAccount,
} from '@solus/client-core/document-sync'
import type { AgentProfileStatus } from '@solus/contracts/agent-profile'
import { Listeners } from '../../lib/listeners'
import type { AgentProfileLocalStore } from './agent-profile-local'
import type { EnableChoiceKind } from './personal-sync'

/**
 * Agent profile sync on this device (plans/020-agent-profile.md §3): the
 * shared client-core engine connected to the local copy and the account, and
 * the person's profile on each host. The engine keeps every conflict rule; this
 * owns the wiring, the nudge, and React's view. The nudge is decision 8: the
 * cloud cannot push, so after this device's own write is confirmed, and when
 * sync turns on, every connected host is asked to pull from the account.
 */

/** A host this device can reach now, with the API bound to it. */
export interface ReachableHost {
  hostId: string
  api: HostApi
}

export interface AgentProfileHostState {
  status: AgentProfileStatus | null
  error: string | null
  busy: boolean
}

const IDLE_HOST: AgentProfileHostState = { status: null, error: null, busy: false }

export class DeviceAgentProfileSync {
  readonly changes = new Listeners()
  readonly engine: AgentProfileSync
  status: AgentProfileSyncStatus
  private hosts = new Map<string, AgentProfileHostState>()
  private accountKey: string | null = null
  private readonly unsubscribes: Array<() => void> = []

  constructor(
    private readonly local: AgentProfileLocalStore,
    ports: Omit<AgentProfileSyncPorts, 'broadcast'>,
    /** Every host connected now; a host that is not cannot be asked to pull. */
    private readonly reachableHosts: () => ReachableHost[],
  ) {
    this.engine = new AgentProfileSync(ports)
    this.status = this.engine.current
    this.unsubscribes.push(
      this.engine.subscribe((status) => {
        const previous = this.status
        this.status = status
        this.changes.notify()
        // A confirmed write: what was pending is now the account's. Hosts read it from there.
        if (status.state === 'synced' && previous.pendingKeys.length > 0 && status.pendingKeys.length === 0) this.pullEverywhere()
      }),
      this.engine.onRemoteChange((change) => local.applyRemote(change)),
      // The engine ignores a change while sync is off, so a local edit stays local.
      local.onLocalChange((change) => { this.engine.recordLocalChange(change) }),
    )
  }

  current = (): AgentProfileSyncStatus => this.status

  /** Each host's copy of the profile, as it last answered. The same map until one changes. */
  hostStates = (): ReadonlyMap<string, AgentProfileHostState> => this.hosts

  hostState(hostId: string): AgentProfileHostState {
    return this.hosts.get(hostId) ?? IDLE_HOST
  }

  /**
   * Follows the account. Sign-out ends sync for that account on this device: its
   * consent, pending edits, and confirmed copy leave. The local store switches
   * first, so a cloud change lands in the copy of the account it belongs to.
   */
  followAccount(account: SyncAccount | null): void {
    const accountKey = account ? syncAccountKey(account) : null
    this.local.setAccount(account)
    if (accountKey === null && this.accountKey !== null) this.engine.signOut()
    else this.engine.setAccount(account)
    this.accountKey = accountKey
  }

  prepareEnable(): ReturnType<AgentProfileSync['prepareEnable']> {
    return this.engine.prepareEnable()
  }

  /** Turns sync on with the person's choice. Seed and replace send this device's copy; then every host pulls. */
  async enable(kind: EnableChoiceKind): Promise<AgentProfileEnableOutcome> {
    const outcome = kind === 'use-synced'
      ? await this.engine.enable({ kind })
      : await this.engine.enable({ kind, document: this.local.document() })
    if (outcome.kind === 'enabled') this.pullEverywhere()
    return outcome
  }

  turnOff(): void {
    this.engine.turnOff()
  }

  // ── Hosts ──

  /** Reads what a host holds for the person. An older host, or one that refuses, keeps its error. */
  async load(hostId: string): Promise<void> {
    await this.run(hostId, (api) => api.agentProfileStatus())
  }

  /** Asks a host to read the profile from the account now. */
  async pull(hostId: string): Promise<void> {
    await this.run(hostId, (api) => api.agentProfilePull())
  }

  /** Every connected host pulls; one that cannot keeps its last answer and its error. */
  pullEverywhere(): void {
    for (const host of this.reachableHosts()) void this.pull(host.hostId)
  }

  /** The way out: an empty profile removes what was copied to that host, and nothing else. */
  async remove(hostId: string): Promise<void> {
    await this.run(hostId, (api) => api.agentProfileApply({ profile: {}, skipped: [] }))
  }

  /** A host that left this device leaves this view. */
  forgetHost(hostId: string): void {
    if (!this.hosts.delete(hostId)) return
    this.hosts = new Map(this.hosts)
    this.changes.notify()
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.engine.dispose()
  }

  private async run(hostId: string, task: (api: HostApi) => Promise<AgentProfileStatus>): Promise<void> {
    const host = this.reachableHosts().find((candidate) => candidate.hostId === hostId)
    const current = this.hostState(hostId)
    if (current.busy) return
    if (!host) {
      this.setHost(hostId, { ...current, error: 'This host is not connected.' })
      return
    }
    this.setHost(hostId, { ...current, busy: true, error: null })
    try {
      const status = await task(host.api)
      this.setHost(hostId, { status, error: null, busy: false })
    } catch (cause) {
      this.setHost(hostId, { ...this.hostState(hostId), busy: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  private setHost(hostId: string, state: AgentProfileHostState): void {
    this.hosts = new Map(this.hosts).set(hostId, state)
    this.changes.notify()
  }
}
