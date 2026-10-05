import {
  SettingsSync,
  settingsAccountKey,
  type EnableOffer,
  type SettingsSyncBroadcast,
  type SettingsSyncClock,
  type SettingsSyncEnvironment,
  type SettingsSyncMessage,
  type SettingsSyncPorts,
  type SettingsSyncSignal,
  type SettingsSyncStatus,
  type SyncAccount,
} from '@solus/client-core/settings-sync'
import { cookieSettingsRequests, type SettingsCloudRequests } from '@solus/client-core/settings-requests'
import { localApi } from '@solus/client-core/local-api'
import { cloudAccount } from '@solus/client-core/cloud-account'
import type { AccountState } from '@solus/contracts/account-types'
import type { PersonalSettingKey } from '@solus/contracts/settings'
import type { PersonalSettingsStore } from './personal-settings.store.svelte'
import { untrack } from 'svelte'
import { z } from 'zod'

/**
 * Personal settings sync on this client (plans/018 §5): one `SettingsSync`
 * coordinator for the whole client, never one per tab, joined to the personal
 * store. It turns the account's state into the profile shown and the account
 * synced, and holds what the Settings page shows: the status, the first-enable
 * offer, and the last outcome. Sync is off until the person turns it on here;
 * signing in alone never uploads.
 */

// ─── Browser ports ───

export function browserSyncEnvironment(): SettingsSyncEnvironment {
  return {
    isOnline: () => globalThis.navigator?.onLine !== false,
    isForeground: () => globalThis.document?.visibilityState !== 'hidden',
    subscribe(listener: (signal: SettingsSyncSignal) => void) {
      const online = () => listener('online')
      const offline = () => listener('offline')
      const visibility = () => listener(document.visibilityState === 'hidden' ? 'background' : 'foreground')
      globalThis.window?.addEventListener('online', online)
      globalThis.window?.addEventListener('offline', offline)
      globalThis.document?.addEventListener('visibilitychange', visibility)
      return () => {
        globalThis.window?.removeEventListener('online', online)
        globalThis.window?.removeEventListener('offline', offline)
        globalThis.document?.removeEventListener('visibilitychange', visibility)
      }
    },
  }
}

export const browserSyncClock: SettingsSyncClock = {
  now: () => Date.now(),
  setTimer(callback, ms) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/** Tabs of one browser profile share the sync record; this tells the others it changed. Absent without BroadcastChannel. */
const syncMessageSchema = z.object({ accountKey: z.string() })

export function browserSyncBroadcast(): SettingsSyncBroadcast | undefined {
  if (!('BroadcastChannel' in globalThis)) return undefined
  const channel = new BroadcastChannel('solus.settings-sync')
  return {
    post: (message: SettingsSyncMessage) => channel.postMessage(message),
    subscribe(listener) {
      const receive = (event: MessageEvent) => {
        const message = syncMessageSchema.safeParse(event.data)
        if (message.success) listener(message.data)
      }
      channel.addEventListener('message', receive)
      return () => channel.removeEventListener('message', receive)
    },
  }
}

/**
 * The account-plane calls for whoever holds this client's account: the desktop
 * main process (which adds its token), or the account cookie on the web client
 * served at the account origin. Null with neither: there is no account to sync.
 */
export function accountSettingsRequests(): SettingsCloudRequests | null {
  // The desktop preload bridge has the account methods; a browser has no bridge.
  if (localApi.accountSettingsGet !== undefined) return localApi
  const account = cloudAccount()
  return account ? cookieSettingsRequests(account.consoleUrl) : null
}

/** The account a state names; undefined while it says nothing new (signing in, an unverified session). */
export function syncAccountOf(state: AccountState, hasAnswered: boolean): SyncAccount | null | undefined {
  if (state.kind === 'signed-in') return { origin: state.consoleUrl, userId: state.profile.id }
  if (state.kind === 'signed-out') return hasAnswered ? null : undefined
  return undefined
}

const SIGNED_OUT: SettingsSyncStatus = {
  state: 'signed-out',
  account: null,
  lastSyncedAt: null,
  pendingKeys: [],
  conflicts: [],
  error: null,
  stoppedReason: null,
}

/** What the last action left for the person to read. */
export type SyncNotice =
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  | { kind: 'changed' }
  | { kind: 'has-unsent'; keys: PersonalSettingKey[] }
  | { kind: 'cleared' }

export class SettingsSyncStore {
  status = $state<SettingsSyncStatus>(SIGNED_OUT)
  /** The first-enable choice waiting for the person: what the account already holds, read before anything is written. */
  offer = $state<EnableOffer | null>(null)
  busy = $state(false)
  notice = $state<SyncNotice | null>(null)
  private engine: SettingsSync | null = null
  private personal: PersonalSettingsStore | null = null
  private account: SyncAccount | null = null
  private readonly stops: Array<() => void> = []

  get isAvailable(): boolean {
    return this.engine !== null
  }

  /**
   * Joins the engine to the personal store. One per client; later calls return
   * the same stop. `ports` replace the browser and account ports (tests).
   */
  start(personal: PersonalSettingsStore, ports?: Partial<SettingsSyncPorts>): () => void {
    if (this.engine) return () => this.stop()
    const requests = ports?.requests ?? accountSettingsRequests()
    this.personal = personal
    if (!requests) return () => this.stop()
    const engine = new SettingsSync({
      requests,
      storage: ports?.storage ?? localStorage,
      environment: ports?.environment ?? browserSyncEnvironment(),
      clock: ports?.clock ?? browserSyncClock,
      broadcast: ports && 'broadcast' in ports ? ports.broadcast : browserSyncBroadcast(),
    })
    this.engine = engine
    this.status = engine.current
    this.stops.push(engine.subscribe((status) => { this.status = status }))
    // Cloud changes go into the profile; the person's own edits go to the engine, which ignores them while sync is off.
    this.stops.push(engine.onRemoteChange((change) => personal.applyRemote(change)))
    this.stops.push(personal.onChange((change, origin) => {
      if (origin === 'local') engine.recordLocalChange(change)
    }))
    return () => this.stop()
  }

  /**
   * The account changed. The profile switches first, so a cloud change for the
   * next account never lands in the previous one's profile. Signing out stops
   * sync and takes this account's profile and pending edits off this client.
   */
  setAccount(account: SyncAccount | null): void {
    const previous = this.account
    if (previous && account && settingsAccountKey(previous) === settingsAccountKey(account)) {
      this.engine?.setAccount(account)
      return
    }
    this.account = account
    this.offer = null
    this.notice = null
    if (!account && previous) {
      this.engine?.signOut()
      this.personal?.removeProfile(settingsAccountKey(previous))
      return
    }
    this.personal?.setAccount(account ? settingsAccountKey(account) : null)
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
  async beginEnable(): Promise<void> {
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

  /** "Use synced settings", "Replace with this device", or — with nothing synced — "Start syncing". */
  async choose(choice: 'use-synced' | 'replace' | 'seed'): Promise<void> {
    const engine = this.engine
    const personal = this.personal
    if (!engine || !personal || this.busy || !this.offer) return
    this.busy = true
    try {
      const outcome = await engine.enable(choice === 'use-synced' ? { kind: 'use-synced' } : { kind: choice, settings: personal.storedDocument })
      if (outcome.kind === 'enabled' || outcome.kind === 'cancelled') this.offer = null
      else if (outcome.kind === 'changed') {
        // The account changed under the dialog: nothing was overwritten. Ask again over what is there now.
        this.offer = outcome.offer
        this.notice = { kind: 'changed' }
      } else if (outcome.kind === 'invalid') this.notice = { kind: 'error', message: 'These settings could not be sent. Try again.' }
      else this.noteUnavailable(outcome)
    } finally {
      this.busy = false
    }
  }

  cancelEnable(): void {
    this.offer = null
  }

  /** "Turn off on this device": confirmed values stay here; the account and other devices are left alone. */
  turnOff(): void {
    this.engine?.turnOff()
    this.notice = null
  }

  /** "Clear synced settings". With unsent edits it asks first: call again with `discardUnsent`. */
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

  resolveConflict(key: PersonalSettingKey, choice: 'keep-mine' | 'take-theirs'): void {
    this.engine?.resolveConflict(key, choice)
  }

  /** Settings opened, or the person asked: read the account now. */
  refresh(): void {
    void this.engine?.refresh()
  }

  dismissNotice(): void {
    this.notice = null
  }

  private noteUnavailable(outcome: { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'cancelled' } | { kind: 'error'; code: string; message: string | null }): void {
    if (outcome.kind === 'cancelled') return
    if (outcome.kind === 'offline') this.notice = { kind: 'offline' }
    else if (outcome.kind === 'signed-out') this.notice = { kind: 'error', message: 'Sign in to Solus again to sync settings.' }
    else this.notice = { kind: 'error', message: outcome.message ?? `Solus could not reach your account (${outcome.code}).` }
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.engine?.dispose()
    this.engine = null
  }
}

export const settingsSyncStore = new SettingsSyncStore()
