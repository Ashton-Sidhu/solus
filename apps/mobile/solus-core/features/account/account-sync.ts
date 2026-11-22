import { AgentProfileSync, type AgentProfileSyncPorts, type AgentProfileSyncStatus } from '@solus/client-core/agent-profile-sync'
import {
  syncAccountKey,
  type DocumentSyncClock,
  type DocumentSyncEnvironment,
  type DocumentSyncState,
  type DocumentSyncStorage,
  type SyncAccount,
} from '@solus/client-core/document-sync'
import type { HostApi } from '@solus/client-core/host-api'
import { SettingsSync, type SettingsSyncPorts, type SettingsSyncStatus } from '@solus/client-core/settings-sync'
import type { AgentProfileStatus } from '@solus/contracts/agent-profile'
import { Listeners } from '../../lib/listeners'
import type { AgentProfileLocalStore } from '../settings/agent-profile-local'
import type { PersonalSettingsStore } from '../settings/personal-settings'

/**
 * The account's sync on this device (plans/018 decision 9, plans/020 §10
 * "One account, one policy"): one owner for the two synced documents, the
 * personal settings and the agent profile, over the shared client-core
 * engine. Signed in is synced: each engine starts by itself when the account
 * is set, with this device's copy as the seed when the account has none. The
 * engines keep every conflict rule; this owns the wiring, React's view of the
 * one status, the profile's copy on each host, and the nudge: the cloud cannot
 * push (plans/020 decision 8), so after this device's write is confirmed, and
 * after a start or a clear, every connected host is asked to pull.
 */

/** The phone's timers. One process is the whole client, so there is no broadcast port. */
export const timerClock: DocumentSyncClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/** Where no platform reports network and app state (tests, a host-less preview): online and in front. */
export const alwaysOnlineEnvironment: DocumentSyncEnvironment = {
  isOnline: () => true,
  isForeground: () => true,
  subscribe: () => () => {},
}

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

export interface AccountSyncPorts {
  settingsRequests: SettingsSyncPorts['requests']
  profileRequests: AgentProfileSyncPorts['requests']
  storage: DocumentSyncStorage
  environment: DocumentSyncEnvironment
  clock: DocumentSyncClock
}

/** Worst first: the account's one state is the worse of its two documents'. */
const STATE_ORDER: DocumentSyncState[] = ['signed-out', 'error', 'conflict', 'offline', 'pending', 'loading', 'synced']

export function worseSyncState(left: DocumentSyncState, right: DocumentSyncState): DocumentSyncState {
  return STATE_ORDER.indexOf(left) <= STATE_ORDER.indexOf(right) ? left : right
}

/** The account's status as the screens read it: the worse state, and the counts across both documents. */
export interface AccountSyncStatus {
  state: DocumentSyncState
  /** The older of the two documents' last confirmed times; null until both were confirmed. */
  lastSyncedAt: number | null
  pendingCount: number
  conflictCount: number
  error: { code: string; message: string | null } | null
}

export class AccountSync {
  readonly changes = new Listeners()
  readonly settingsEngine: SettingsSync
  readonly profileEngine: AgentProfileSync
  settings: SettingsSyncStatus
  profile: AgentProfileSyncStatus
  private hosts = new Map<string, AgentProfileHostState>()
  private accountKey: string | null = null
  private readonly unsubscribes: Array<() => void> = []

  constructor(
    private readonly personal: PersonalSettingsStore,
    private readonly local: AgentProfileLocalStore,
    ports: AccountSyncPorts,
    /** Every host connected now; a host that is not cannot be asked to pull. */
    private readonly reachableHosts: () => ReachableHost[],
  ) {
    const shared = { storage: ports.storage, environment: ports.environment, clock: ports.clock }
    this.settingsEngine = new SettingsSync({ ...shared, requests: ports.settingsRequests, localCopy: () => personal.document() })
    this.profileEngine = new AgentProfileSync({ ...shared, requests: ports.profileRequests, localCopy: () => local.document() })
    this.settings = this.settingsEngine.current
    this.profile = this.profileEngine.current
    this.unsubscribes.push(
      this.settingsEngine.subscribe((status) => {
        this.settings = status
        this.changes.notify()
      }),
      this.profileEngine.subscribe((status) => {
        const previous = this.profile
        this.profile = status
        this.changes.notify()
        // This device moved onto a copy of the account document (a start, a clear here or elsewhere), or a confirmed write:
        // the account holds this device's copy. Hosts read it from there.
        const started = status.generation !== null && status.generation !== previous.generation
        const confirmed = status.state === 'synced' && previous.pendingKeys.length > 0 && status.pendingKeys.length === 0
        if (started || confirmed) this.pullEverywhere()
      }),
      this.settingsEngine.onRemoteChange((change) => personal.applyRemote(change)),
      this.profileEngine.onRemoteChange((change) => local.applyRemote(change)),
      // The engine ignores a change until the account was read, so an edit made before stays local and seeds.
      personal.onLocalChange((change) => { this.settingsEngine.recordLocalChange(change) }),
      local.onLocalChange((change) => { this.profileEngine.recordLocalChange(change) }),
    )
  }

  /** The account's one status. A new object only when something changed, so `useListened` can compare it. */
  current = (): AccountSyncStatus => {
    const { settings, profile } = this
    const lastSyncedAt = settings.lastSyncedAt === null || profile.lastSyncedAt === null
      ? settings.lastSyncedAt ?? profile.lastSyncedAt
      : Math.min(settings.lastSyncedAt, profile.lastSyncedAt)
    const next: AccountSyncStatus = {
      state: worseSyncState(settings.state, profile.state),
      lastSyncedAt,
      pendingCount: settings.pendingKeys.length + profile.pendingKeys.length,
      conflictCount: settings.conflicts.length + profile.conflicts.length,
      error: settings.error ?? profile.error,
    }
    const last = this.status
    if (last && last.state === next.state && last.lastSyncedAt === next.lastSyncedAt && last.pendingCount === next.pendingCount
      && last.conflictCount === next.conflictCount && last.error === next.error) return last
    this.status = next
    return next
  }
  private status: AccountSyncStatus | null = null

  currentSettings = (): SettingsSyncStatus => this.settings

  currentProfile = (): AgentProfileSyncStatus => this.profile

  /** Each host's copy of the profile, as it last answered. The same map until one changes. */
  hostStates = (): ReadonlyMap<string, AgentProfileHostState> => this.hosts

  hostState(hostId: string): AgentProfileHostState {
    return this.hosts.get(hostId) ?? IDLE_HOST
  }

  /**
   * Follows the account, which starts sync for it. Sign-out ends sync for that
   * account on this device: its pending edits and confirmed copies leave. The
   * local stores switch first, so a cloud change lands in the copy of the
   * account it belongs to.
   */
  followAccount(account: SyncAccount | null): void {
    const accountKey = account ? syncAccountKey(account) : null
    this.personal.setAccount(account)
    this.local.setAccount(account)
    if (accountKey === null && this.accountKey !== null) {
      this.settingsEngine.signOut()
      this.profileEngine.signOut()
    } else {
      this.settingsEngine.setAccount(account)
      this.profileEngine.setAccount(account)
    }
    this.accountKey = accountKey
  }

  /** "Clear synced settings": the account's copy goes, and this device starts it again from its own. */
  clearSettings(options: { discardUnsent?: boolean } = {}): ReturnType<SettingsSync['clearCloud']> {
    return this.settingsEngine.clearCloud(options)
  }

  /** "Clear synced profile": the same reset for the profile; every connected host then pulls the new copy. */
  clearProfile(options: { discardUnsent?: boolean } = {}): ReturnType<AgentProfileSync['clearCloud']> {
    return this.profileEngine.clearCloud(options)
  }

  /** "Sync now": both documents read the account; a start that failed is tried again. */
  async syncNow(): Promise<void> {
    await Promise.all([this.settingsEngine.refresh(), this.profileEngine.refresh()])
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
    this.settingsEngine.dispose()
    this.profileEngine.dispose()
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
