import {
  AgentProfileSync,
  type AgentProfileEnableChoice,
  type AgentProfileEnableOffer,
  type AgentProfileSyncPorts,
  type AgentProfileSyncStatus,
} from '@solus/client-core/agent-profile-sync'
import { webAgentProfileRequests, type AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import { syncAccountKey, type DocumentSyncState, type SyncAccount } from '@solus/client-core/document-sync'
import { localApi } from '@solus/client-core/local-api'
import { cloudAccount } from '@solus/client-core/cloud-account'
import type { AccountState } from '@solus/contracts/account-types'
import type { AgentProfileKey } from '@solus/contracts/agent-profile'
import { untrack } from 'svelte'
import { browserSyncBroadcast, browserSyncClock, browserSyncEnvironment, syncAccountOf } from '../app/settings-sync.store.svelte'
import type { AgentProfileLocalStore } from './agent-profile-local.store.svelte'
import { agentProfileStore, type AgentProfileStore } from './agent-profile.store.svelte'

/**
 * Agent profile sync on this client (plans/020-agent-profile.md §3): one
 * `AgentProfileSync` engine for the whole client, joined to the local copy.
 * It is the second synced document beside the personal settings, with its own
 * record, channel, and offer. Two rules are its own: while sync is on, a host
 * pulls the profile from the account instead of taking a push from this
 * computer, and after the account confirms a write, every host the profile
 * applies to is asked to pull (decision 8: there is no cloud-to-host push).
 */

/** The account-plane calls for whoever holds this client's account: the desktop main process, or the account cookie on the web. */
export function accountAgentProfileRequests(): AgentProfileCloudRequests | null {
  // The desktop preload bridge has the account methods; a browser has no bridge.
  if (localApi.accountAgentProfileGet !== undefined) return localApi
  const account = cloudAccount()
  return account ? webAgentProfileRequests(account.consoleUrl, account.session) : null
}

/** Sync is on for this device and account: a state the engine only reaches while enabled. */
export function isAgentProfileSyncOn(state: DocumentSyncState): boolean {
  return state === 'synced' || state === 'pending' || state === 'offline' || state === 'conflict' || state === 'error'
}

const SIGNED_OUT: AgentProfileSyncStatus = {
  state: 'signed-out',
  account: null,
  lastSyncedAt: null,
  pendingKeys: [],
  conflicts: [],
  error: null,
  stoppedReason: null,
}

/** What the last action left for the person to read. */
export type AgentProfileSyncNotice =
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  | { kind: 'changed' }
  | { kind: 'has-unsent'; keys: AgentProfileKey[] }
  | { kind: 'cleared' }

export class AgentProfileSyncStore {
  status = $state<AgentProfileSyncStatus>(SIGNED_OUT)
  /** The first-enable choice waiting for the person: what the account already holds, read before anything is written. */
  offer = $state<AgentProfileEnableOffer | null>(null)
  busy = $state(false)
  notice = $state<AgentProfileSyncNotice | null>(null)
  private engine: AgentProfileSync | null = null
  private local: AgentProfileLocalStore | null = null
  private account: SyncAccount | null = null
  private readonly stops: Array<() => void> = []

  constructor(private readonly hosts: AgentProfileStore = agentProfileStore) {}

  get isAvailable(): boolean {
    return this.engine !== null
  }

  get isOn(): boolean {
    return isAgentProfileSyncOn(this.status.state)
  }

  /**
   * Joins the engine to the local copy. One per client; later calls return the
   * same stop. `ports` replace the browser and account ports (tests).
   */
  start(local: AgentProfileLocalStore, ports?: Partial<AgentProfileSyncPorts>): () => void {
    if (this.engine) return () => this.stop()
    const requests = ports?.requests ?? accountAgentProfileRequests()
    this.local = local
    if (!requests) return () => this.stop()
    const engine = new AgentProfileSync({
      requests,
      storage: ports?.storage ?? localStorage,
      environment: ports?.environment ?? browserSyncEnvironment(),
      clock: ports?.clock ?? browserSyncClock,
      broadcast: ports && 'broadcast' in ports ? ports.broadcast : browserSyncBroadcast('solus.agent-profile-sync'),
    })
    this.engine = engine
    this.noteStatus(engine.current)
    this.stops.push(engine.subscribe((status) => this.noteStatus(status)))
    // Cloud changes go into the local copy; the person's own edits go to the engine, which ignores them while sync is off.
    this.stops.push(engine.onRemoteChange((change) => local.applyRemote(change)))
    this.stops.push(local.onLocalChange((change) => engine.recordLocalChange(change)))
    return () => this.stop()
  }

  /**
   * The account changed. The local record switches first, so a cloud change
   * for the next account never lands in the previous one's record. Signing
   * out stops sync and takes this account's record and pending edits off this client.
   */
  setAccount(account: SyncAccount | null): void {
    const previous = this.account
    if (previous && account && syncAccountKey(previous) === syncAccountKey(account)) {
      this.engine?.setAccount(account)
      return
    }
    this.account = account
    this.offer = null
    this.notice = null
    if (!account && previous) {
      this.engine?.signOut()
      this.local?.removeProfile(syncAccountKey(previous))
      return
    }
    this.local?.setAccount(account ? syncAccountKey(account) : null)
    this.engine?.setAccount(account)
  }

  /** Follows the account the client shell or the account cookie names, for this client's lifetime. */
  followAccount(account: { state: AccountState; hasAnswered: boolean; start(): void }): () => void {
    account.start()
    return $effect.root(() => {
      $effect(() => {
        const next = syncAccountOf(account.state, account.hasAnswered)
        if (next !== undefined) untrack(() => this.setAccount(next))
      })
    })
  }

  /** Reads the account before anything is written, then waits for the person's choice. */
  async prepareEnable(): Promise<void> {
    if (!this.engine || this.busy) return
    this.busy = true
    this.notice = null
    try {
      const outcome = await this.engine.prepareEnable()
      if (outcome.kind === 'offer') this.offer = outcome.offer
      else this.noteUnavailable(outcome)
    } finally {
      this.busy = false
    }
  }

  /**
   * "Use synced", "Replace with this device", or — with nothing synced — the
   * first copy. "This device" is the computer's profile as it is now on the
   * desktop, and this client's local copy on the web, which has no computer.
   * Once on, every host the profile applies to pulls the account's copy.
   */
  async enable(choice: 'use-synced' | 'replace' | 'seed'): Promise<void> {
    const engine = this.engine
    const local = this.local
    if (!engine || !local || this.busy || !this.offer) return
    this.busy = true
    try {
      let request: AgentProfileEnableChoice
      if (choice === 'use-synced') request = { kind: 'use-synced' }
      else {
        const computer = await this.hosts.readComputer()
        const document = computer ?? local.storedEntries
        // The engine is off, so this lands locally only; what it confirms is applied over it.
        local.replaceAll(document)
        request = { kind: choice, document }
      }
      const outcome = await engine.enable(request)
      if (outcome.kind === 'enabled') {
        this.offer = null
        this.hosts.pullEverywhere()
      } else if (outcome.kind === 'cancelled') this.offer = null
      else if (outcome.kind === 'changed') {
        // The account changed under the dialog: nothing was overwritten. Ask again over what is there now.
        this.offer = outcome.offer
        this.notice = { kind: 'changed' }
      } else if (outcome.kind === 'invalid') this.notice = { kind: 'error', message: 'This profile could not be sent. Try again.' }
      else this.noteUnavailable(outcome)
    } catch (error) {
      // Only the read of this computer's profile throws here: the engine answers with outcomes.
      this.notice = { kind: 'error', message: `Solus could not read this computer's profile: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      this.busy = false
    }
  }

  cancelEnable(): void {
    this.offer = null
  }

  /** "Turn off on this device": the local copy stays; the account and other devices are left alone. */
  turnOff(): void {
    this.engine?.turnOff()
    this.notice = null
  }

  /** "Clear synced profile". With unsent edits it asks first: call again with `discardUnsent`. */
  async clearCloud(discardUnsent = false): Promise<void> {
    if (!this.engine || this.busy) return
    this.busy = true
    try {
      const outcome = await this.engine.clearCloud({ discardUnsent })
      if (outcome.kind === 'cleared') this.notice = { kind: 'cleared' }
      else if (outcome.kind === 'has-unsent') this.notice = { kind: 'has-unsent', keys: outcome.keys }
      else if (outcome.kind !== 'cancelled') this.noteUnavailable(outcome)
    } finally {
      this.busy = false
    }
  }

  resolveConflict(key: AgentProfileKey, choice: 'keep-mine' | 'take-theirs'): void {
    this.engine?.resolveConflict(key, choice)
  }

  /** Settings opened, or the person asked: read the account now. */
  refresh(): void {
    void this.engine?.refresh()
  }

  dismissNotice(): void {
    this.notice = null
  }

  private noteStatus(status: AgentProfileSyncStatus): void {
    const previous = this.status
    this.status = status
    this.hosts.setSync(isAgentProfileSyncOn(status.state))
    // Pending became synced: the account confirmed this client's write. The hosts read it now, not at their next refresh.
    if (previous.state === 'pending' && status.state === 'synced') this.hosts.pullEverywhere()
  }

  private noteUnavailable(outcome: { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'cancelled' } | { kind: 'error'; code: string; message: string | null }): void {
    if (outcome.kind === 'cancelled') return
    if (outcome.kind === 'offline') this.notice = { kind: 'offline' }
    else if (outcome.kind === 'signed-out') this.notice = { kind: 'error', message: 'Sign in to Solus again to sync your agent profile.' }
    else this.notice = { kind: 'error', message: outcome.message ?? `Solus could not reach your account (${outcome.code}).` }
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.engine?.dispose()
    this.engine = null
  }
}

export const agentProfileSyncStore = new AgentProfileSyncStore()
