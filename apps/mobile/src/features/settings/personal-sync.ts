import {
  SettingsSync,
  settingsAccountKey,
  type EnableOffer,
  type EnableOutcome,
  type SettingsSyncClock,
  type SettingsSyncEnvironment,
  type SettingsSyncPorts,
  type SettingsSyncStatus,
  type SyncAccount,
} from '@solus/client-core/settings-sync'
import { Listeners } from '../../lib/listeners'
import type { PersonalSettingsStore } from './personal-settings'

/**
 * Personal settings sync on this device (plans/018 §5): the shared client-core
 * engine, connected to the personal store and the account. The engine keeps
 * every conflict rule; this owns only the wiring and React's view of the
 * status. Sync is off until the person turns it on here: signing in does not.
 */

/** The phone's timers. One process is the whole client, so there is no broadcast port. */
export const timerClock: SettingsSyncClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/** Where no platform reports network and app state (tests, a host-less preview): online and in front. */
export const alwaysOnlineEnvironment: SettingsSyncEnvironment = {
  isOnline: () => true,
  isForeground: () => true,
  subscribe: () => () => {},
}

/** The person's three ways to turn sync on, as the screen offers them. */
export type EnableChoiceKind = 'use-synced' | 'replace' | 'seed'

export class PersonalSync {
  readonly changes = new Listeners()
  readonly engine: SettingsSync
  status: SettingsSyncStatus
  private accountKey: string | null = null
  private readonly unsubscribes: Array<() => void> = []

  constructor(private readonly personal: PersonalSettingsStore, ports: Omit<SettingsSyncPorts, 'broadcast'>) {
    this.engine = new SettingsSync(ports)
    this.status = this.engine.current
    this.unsubscribes.push(
      this.engine.subscribe((status) => {
        this.status = status
        this.changes.notify()
      }),
      this.engine.onRemoteChange((change) => personal.applyRemote(change)),
      // The engine ignores a change while sync is off, so a local edit stays local.
      personal.onLocalChange((change) => { this.engine.recordLocalChange(change) }),
    )
  }

  current = (): SettingsSyncStatus => this.status

  /**
   * Follows the account. Sign-out ends sync for that account on this device: its
   * consent, pending edits, and confirmed copy leave, and the anonymous profile
   * returns. The personal store switches first, so a cloud change lands in the
   * profile of the account it belongs to.
   */
  followAccount(account: SyncAccount | null): void {
    const accountKey = account ? settingsAccountKey(account) : null
    this.personal.setAccount(account)
    if (accountKey === null && this.accountKey !== null) this.engine.signOut()
    else this.engine.setAccount(account)
    this.accountKey = accountKey
  }

  /** Turns sync on with the person's choice. Seed and replace send this device's profile. */
  enable(kind: EnableChoiceKind): Promise<EnableOutcome> {
    if (kind === 'use-synced') return this.engine.enable({ kind })
    return this.engine.enable({ kind, settings: this.personal.document() })
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.engine.dispose()
  }
}

/** The choices a first enable offers, default first (plans/018 §5). */
export function enableChoicesFor(offer: EnableOffer): EnableChoiceKind[] {
  return offer.kind === 'present' ? ['use-synced', 'replace'] : ['seed']
}
