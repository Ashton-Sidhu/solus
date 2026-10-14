import { AgentProfileSync, type AgentProfileSyncPorts, type AgentProfileSyncStatus } from '@solus/client-core/agent-profile-sync'
import { webAgentProfileRequests, type AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import { cloudAccount } from '@solus/client-core/cloud-account'
import {
  syncAccountKey,
  type DocumentSyncBroadcast,
  type DocumentSyncClock,
  type DocumentSyncEnvironment,
  type DocumentSyncState,
  type DocumentSyncStatus,
  type DocumentSyncStorage,
  type DocumentSyncUnavailable,
  type SyncAccount,
} from '@solus/client-core/document-sync'
import { localApi } from '@solus/client-core/local-api'
import { webSettingsRequests, type SettingsCloudRequests } from '@solus/client-core/settings-requests'
import { SettingsSync, type SettingsSyncPorts, type SettingsSyncStatus } from '@solus/client-core/settings-sync'
import type { AccountState } from '@solus/contracts/account-types'
import type { AgentProfile, AgentProfileKey } from '@solus/contracts/agent-profile'
import type { PersonalSettingKey } from '@solus/contracts/settings'
import { untrack } from 'svelte'
import type { PersonalSettingsStore } from '../app/personal-settings.store.svelte'
import type { AgentProfileLocalStore } from '../seats/agent-profile-local.store.svelte'
import { agentProfileStore, type AgentProfileStore } from '../seats/agent-profile.store.svelte'
import { browserSyncBroadcast, browserSyncClock, browserSyncEnvironment } from './lib/browser-sync-ports'

/**
 * The account's sync on this client (plans/018 decision 9, plans/020 §10
 * "One account, one policy"): one owner for the two synced documents, the
 * personal settings and the agent profile. Signed in is synced: each engine
 * starts by itself when the account is set, with this device's copy as the
 * seed when the account has none. This store joins each engine to its local
 * copy, follows the account, and holds what Settings → Account & sync shows:
 * one status for the account, each document's conflicts, the last notice, and
 * the two clear actions. One per client, never one per tab.
 *
 * The profile has one rule of its own: a host pulls the profile from the
 * account, and after this client's write is confirmed every host the profile
 * applies to is asked to pull (plans/020 decision 8: the cloud cannot push).
 */

// ─── Account requests ───

/**
 * The account-plane calls for whoever holds this client's account: the desktop
 * main process (which adds its token), or the page's own sign-in on the web client
 * served at the account origin. Null with neither: there is no account to sync.
 */
export function accountSettingsRequests(): SettingsCloudRequests | null {
  // The desktop preload bridge has the account methods; a browser has no bridge.
  if (localApi.accountSettingsGet !== undefined) return localApi
  const account = cloudAccount()
  return account ? webSettingsRequests(account.consoleUrl, account.session) : null
}

export function accountAgentProfileRequests(): AgentProfileCloudRequests | null {
  if (localApi.accountAgentProfileGet !== undefined) return localApi
  const account = cloudAccount()
  return account ? webAgentProfileRequests(account.consoleUrl, account.session) : null
}

/** The account a state names; undefined while it says nothing new (signing in, an unverified session). */
export function syncAccountOf(state: AccountState, hasAnswered: boolean): SyncAccount | null | undefined {
  if (state.kind === 'signed-in') return { origin: state.consoleUrl, userId: state.identity.sub }
  if (state.kind === 'signed-out') return hasAnswered ? null : undefined
  return undefined
}

// ─── Shapes ───

export type SyncedDocumentName = 'settings' | 'profile'

/** The ports the two engines share, and each one's requests. Tests replace the browser's. */
export interface AccountSyncPorts {
  settingsRequests: SettingsSyncPorts['requests'] | null
  profileRequests: AgentProfileSyncPorts['requests'] | null
  storage: DocumentSyncStorage
  environment: DocumentSyncEnvironment
  clock: DocumentSyncClock
  /** One channel per document, for the other tabs of this browser profile. */
  broadcast: (channel: string) => DocumentSyncBroadcast | undefined
}

/** What the last action left for the person to read, and for which document. */
export type AccountSyncNotice =
  | { document: SyncedDocumentName; kind: 'offline' }
  | { document: SyncedDocumentName; kind: 'error'; message: string }
  | { document: 'settings'; kind: 'has-unsent'; keys: PersonalSettingKey[] }
  | { document: 'profile'; kind: 'has-unsent'; keys: AgentProfileKey[] }
  | { document: SyncedDocumentName; kind: 'cleared' }

function signedOut<D, K extends string>(): DocumentSyncStatus<D, K> {
  return { state: 'signed-out', account: null, generation: null, lastSyncedAt: null, pendingKeys: [], conflicts: [], error: null }
}

/** Worst first: the account's one state is the worse of its two documents'. */
const STATE_ORDER: DocumentSyncState[] = ['signed-out', 'error', 'conflict', 'offline', 'pending', 'loading', 'synced']

export function worseSyncState(left: DocumentSyncState, right: DocumentSyncState): DocumentSyncState {
  return STATE_ORDER.indexOf(left) <= STATE_ORDER.indexOf(right) ? left : right
}

/** Sync is on for this account: signed in, whatever else the engine reports. */
export function isSyncOn(state: DocumentSyncState): boolean {
  return state !== 'signed-out'
}

// ─── Store ───

export class AccountSyncStore {
  settings = $state<SettingsSyncStatus>(signedOut())
  profile = $state<AgentProfileSyncStatus>(signedOut())
  busy = $state(false)
  notice = $state<AccountSyncNotice | null>(null)
  private settingsEngine: SettingsSync | null = null
  private profileEngine: AgentProfileSync | null = null
  private personal: PersonalSettingsStore | null = null
  private local: AgentProfileLocalStore | null = null
  private account: SyncAccount | null = null
  private readonly stops: Array<() => void> = []

  constructor(private readonly hosts: AgentProfileStore = agentProfileStore) {}

  /** This client has an account to sync with: the desktop's main process, or the web page's own sign-in. */
  get isAvailable(): boolean {
    return this.settingsEngine !== null || this.profileEngine !== null
  }

  /** The account's one state: the worse of the two documents' (of the one, where only one has an engine). */
  get state(): DocumentSyncState {
    if (!this.settingsEngine) return this.profile.state
    if (!this.profileEngine) return this.settings.state
    return worseSyncState(this.settings.state, this.profile.state)
  }

  /** The older of the two documents' last confirmed times; null until both were confirmed. */
  get lastSyncedAt(): number | null {
    const { settings, profile } = this
    if (settings.lastSyncedAt === null || profile.lastSyncedAt === null) return settings.lastSyncedAt ?? profile.lastSyncedAt
    return Math.min(settings.lastSyncedAt, profile.lastSyncedAt)
  }

  get conflictCount(): number {
    return this.settings.conflicts.length + this.profile.conflicts.length
  }

  get pendingCount(): number {
    return this.settings.pendingKeys.length + this.profile.pendingKeys.length
  }

  /** The last refusal of either document, while its state is `error`. */
  get error(): { code: string; message: string | null } | null {
    return this.settings.error ?? this.profile.error
  }

  /**
   * Joins the engines to the local copies. One per client; later calls return
   * the same stop. `ports` replace the browser's and the account's (tests).
   */
  start(personal: PersonalSettingsStore, local: AgentProfileLocalStore, ports?: Partial<AccountSyncPorts>): () => void {
    if (this.settingsEngine || this.profileEngine) return () => this.stop()
    this.personal = personal
    this.local = local
    const shared = {
      storage: ports?.storage ?? localStorage,
      environment: ports?.environment ?? browserSyncEnvironment(),
      clock: ports?.clock ?? browserSyncClock,
    }
    const broadcast = ports?.broadcast ?? browserSyncBroadcast
    const settingsRequests = ports && 'settingsRequests' in ports ? ports.settingsRequests : accountSettingsRequests()
    const profileRequests = ports && 'profileRequests' in ports ? ports.profileRequests : accountAgentProfileRequests()
    if (settingsRequests) {
      const engine = new SettingsSync({ ...shared, requests: settingsRequests, broadcast: broadcast('solus.settings-sync'), localCopy: () => personal.storedDocument })
      this.settingsEngine = engine
      this.settings = engine.current
      this.stops.push(engine.subscribe((status) => { this.settings = status }))
      // Cloud changes go into the profile; the person's own edits go to the engine.
      this.stops.push(engine.onRemoteChange((change) => personal.applyRemote(change)))
      this.stops.push(personal.onChange((change, origin) => {
        if (origin === 'local') engine.recordLocalChange(change)
      }))
    }
    if (profileRequests) {
      const engine = new AgentProfileSync({ ...shared, requests: profileRequests, broadcast: broadcast('solus.agent-profile-sync'), localCopy: (purpose) => (purpose === 'seed' ? this.profileSeed(local) : local.storedEntries) })
      this.profileEngine = engine
      this.noteProfileStatus(engine.current)
      this.stops.push(engine.subscribe((status) => this.noteProfileStatus(status)))
      this.stops.push(engine.onRemoteChange((change) => local.applyRemote(change)))
      this.stops.push(local.onLocalChange((change) => engine.recordLocalChange(change)))
    }
    return () => this.stop()
  }

  /**
   * The account changed. The local copies switch first, so a cloud change for
   * the next account never lands in the previous one's copy. Signing in starts
   * sync. Signing out stops it and takes this account's copies and pending
   * edits off this client.
   */
  setAccount(account: SyncAccount | null): void {
    const previous = this.account
    if (previous && account && syncAccountKey(previous) === syncAccountKey(account)) {
      this.settingsEngine?.setAccount(account)
      this.profileEngine?.setAccount(account)
      return
    }
    this.account = account
    this.notice = null
    if (!account && previous) {
      this.settingsEngine?.signOut()
      this.profileEngine?.signOut()
      this.personal?.removeProfile(syncAccountKey(previous))
      this.local?.removeProfile(syncAccountKey(previous))
      return
    }
    const accountKey = account ? syncAccountKey(account) : null
    this.personal?.setAccount(accountKey)
    this.local?.setAccount(accountKey)
    this.settingsEngine?.setAccount(account)
    this.profileEngine?.setAccount(account)
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

  /** "Clear synced settings": the account's copy goes, and this device starts it again from its own. With unsent edits it asks first. */
  clearSettings(discardUnsent = false): Promise<void> {
    return this.clear('settings', this.settingsEngine, discardUnsent)
  }

  /** "Clear synced profile": the same reset for the profile; every host then pulls the new copy. */
  clearProfile(discardUnsent = false): Promise<void> {
    return this.clear('profile', this.profileEngine, discardUnsent)
  }

  resolveSettingConflict(key: PersonalSettingKey, choice: 'keep-mine' | 'take-theirs'): void {
    this.settingsEngine?.resolveConflict(key, choice)
  }

  resolveProfileConflict(key: AgentProfileKey, choice: 'keep-mine' | 'take-theirs'): void {
    this.profileEngine?.resolveConflict(key, choice)
  }

  /** Settings opened, or the person asked: read the account now. A start that failed is tried again. */
  refresh(): void {
    void this.settingsEngine?.refresh()
    void this.profileEngine?.refresh()
  }

  dismissNotice(): void {
    this.notice = null
  }

  private async clear(document: SyncedDocumentName, engine: SettingsSync | AgentProfileSync | null, discardUnsent: boolean): Promise<void> {
    if (!engine || this.busy) return
    this.busy = true
    try {
      const outcome = await engine.clearCloud({ discardUnsent })
      if (outcome.kind === 'cleared') this.notice = { document, kind: 'cleared' }
      else if (outcome.kind === 'has-unsent') {
        // SAFETY: an engine's unsent keys are the keys of its own document, which `document` names.
        this.notice = { document, kind: 'has-unsent', keys: outcome.keys } as AccountSyncNotice
      } else if (outcome.kind !== 'cancelled') this.noteUnavailable(document, outcome)
    } finally {
      this.busy = false
    }
  }

  /** The account's first copy of the profile: this computer's, on the desktop, else this device's copy. */
  private async profileSeed(local: AgentProfileLocalStore): Promise<AgentProfile> {
    try {
      return (await this.hosts.readComputer()) ?? local.storedEntries
    } catch (error) {
      this.notice = { document: 'profile', kind: 'error', message: `Solus could not read this computer's profile: ${error instanceof Error ? error.message : String(error)}` }
      return local.storedEntries
    }
  }

  private noteProfileStatus(status: AgentProfileSyncStatus): void {
    const previous = this.profile
    this.profile = status
    this.hosts.setSync(isSyncOn(status.state))
    // This device moved onto a copy of the account document (a start, a clear here or elsewhere), or pending became synced:
    // the account holds this client's copy. The hosts read it now, not at their next refresh.
    const started = status.generation !== null && status.generation !== previous.generation
    const confirmed = previous.state === 'pending' && status.state === 'synced'
    if (started || confirmed) this.hosts.pullEverywhere()
  }

  private noteUnavailable(document: SyncedDocumentName, outcome: DocumentSyncUnavailable): void {
    if (outcome.kind === 'offline') this.notice = { document, kind: 'offline' }
    else if (outcome.kind === 'signed-out') this.notice = { document, kind: 'error', message: 'Sign in to Solus again to sync.' }
    else this.notice = { document, kind: 'error', message: outcome.message ?? `Solus could not reach your account (${outcome.code}).` }
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.settingsEngine?.dispose()
    this.profileEngine?.dispose()
    this.settingsEngine = null
    this.profileEngine = null
  }
}

export const accountSyncStore = new AccountSyncStore()
