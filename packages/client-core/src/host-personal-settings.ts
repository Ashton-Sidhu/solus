import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import {
  PERSONAL_SETTING_KEYS,
  PERSONAL_SETTING_SCHEMAS,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
  type PersonalSettingsPatch,
} from '@solus/contracts/settings'
import type { DocumentSyncStorage } from './document-sync'
import { HomeHostDocument } from './home-host-document'
import { isSolusApiId } from '@solus/contracts/uplink'

/**
 * A person's settings on their hosts, on every client (ADR 0007,
 * docs/plans/personal-settings-source.md). One per client.
 *
 * - Signed out, the home host is the source: this reads its copy when the host
 *   is ready or says that the copy changed, and sends each change the person
 *   makes here. A change made while the home host is away waits, in storage, and
 *   goes when it is back. Other hosts keep their own sets.
 * - Signed in, the account is the source (`SettingsSync`). After the account's
 *   copy changed, and when a host becomes ready, this asks each ready host to
 *   pull it (`personalSettingsChanged`). A host that holds no token for the
 *   person says so, and this writes the account's copy to it.
 *
 * A failed call (an older host, a dropped connection) is tried again at the next
 * `refresh`, which the client calls when a host's readiness changes.
 */

/** A host this client can call now. */
export interface PersonalSettingsHost {
  hostId: string
  api: Pick<SolusAPI, 'personalSettingsGet' | 'personalSettingsPatch' | 'personalSettingsChanged'>
}

export interface PersonalSettingsHostsPorts {
  /** The hosts this client is connected to now. */
  readyHosts(): PersonalSettingsHost[]
  /** The home host while signed out (`personalSettingsHomeId`); null when the client reaches none. */
  homeHostId(): string | null
  /** Whether the person is signed in to an account: then the account is the source. */
  isSignedIn(): boolean
  /** The settings on screen: the keys the person set. Signed in, the account's copy. */
  document(): PersonalSettingsDocument
  /** Signed out: the home host's copy, with the changes that wait to go to it laid over it, replaces the copy on screen. */
  adoptHostCopy(settings: PersonalSettingsDocument): void
  /** Durable storage for the changes that wait for the home host. */
  storage: DocumentSyncStorage
}

/** The home host of a signed-out person: the device host, else the default host. Never a Solus API: it keeps no settings. */
export function personalSettingsHomeId(choice: { deviceHostId: string | null; defaultServerId: string | null }): string | null {
  if (choice.deviceHostId) return choice.deviceHostId
  return choice.defaultServerId && !isSolusApiId(choice.defaultServerId) ? choice.defaultServerId : null
}

// SAFETY: `PERSONAL_SETTING_KEYS` is derived from the exhaustive owner table and is never empty.
const keySchema = z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])

/** A stored waiting change, key by key: a value that no longer passes its schema is dropped. */
const pendingSchema = z.object({
  set: z.looseObject({}).transform((stored) => {
    const set: PersonalSettingsDocument = {}
    for (const key of PERSONAL_SETTING_KEYS) {
      const parsed = PERSONAL_SETTING_SCHEMAS[key].safeParse(stored[key])
      if (Object.hasOwn(stored, key) && parsed.success) Object.assign(set, { [key]: parsed.data })
    }
    return set
  }),
  reset: z.array(z.string()).transform((keys) => keys.flatMap((key) => keySchema.safeParse(key).data ?? [])),
})

function same<V>(left: V, right: V): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The keys of a document, in the owner table's order, so two equal documents compare equal. */
function ordered(document: PersonalSettingsDocument): PersonalSettingsDocument {
  const result: PersonalSettingsDocument = {}
  for (const key of PERSONAL_SETTING_KEYS) if (Object.hasOwn(document, key)) Object.assign(result, { [key]: document[key] })
  return result
}

/** The change that makes a host's copy equal to `desired`. */
function changeTo(current: PersonalSettingsDocument, desired: PersonalSettingsDocument): PersonalSettingsPatch {
  const reset = PERSONAL_SETTING_KEYS.filter((key) => Object.hasOwn(current, key) && !Object.hasOwn(desired, key))
  return { set: structuredClone(desired), reset }
}

export class PersonalSettingsHosts {
  /** Signed in: hostId → the account copy this client last saw on that host (or wrote there). */
  private readonly accountCopies = new Map<string, string>()
  /** Signed out: the home host is the source. */
  private readonly home: HomeHostDocument<PersonalSettingsDocument, PersonalSettingKey>
  private isNudging = false
  private nudgeAgain = false

  constructor(private readonly ports: PersonalSettingsHostsPorts) {
    this.home = new HomeHostDocument<PersonalSettingsDocument, PersonalSettingKey>({
      homeHostId: () => this.homeHostId,
      callsFor: (hostId) => {
        const host = ports.readyHosts().find((candidate) => candidate.hostId === hostId)
        return host ? {
          get: async () => (await host.api.personalSettingsGet()).settings,
          patch: async (change) => (await host.api.personalSettingsPatch(change)).settings.settings,
        } : null
      },
      document: () => ports.document(),
      adopt: (settings) => ports.adoptHostCopy(settings),
      storage: ports.storage,
      storageKey: (hostId) => `solus.personal-settings.pending.v1:${hostId}`,
      pendingSchema,
    }, () => ({}))
  }

  /** The home host of a signed-out person; null signed in. */
  get homeHostId(): string | null {
    return this.ports.isSignedIn() ? null : this.ports.homeHostId()
  }

  /**
   * A host connected or left, the home moved, or the account changed. Signed
   * out, the home host is read when it is ready and has not been read since, and
   * what waits for it is sent. Signed in, each ready host that has not seen the
   * account's copy yet is asked to pull it.
   */
  refresh(): void {
    const ready = this.ports.readyHosts()
    for (const hostId of this.accountCopies.keys()) {
      if (!ready.some((host) => host.hostId === hostId)) this.accountCopies.delete(hostId)
    }
    if (this.ports.isSignedIn()) {
      this.home.forget()
      void this.nudge()
      return
    }
    this.accountCopies.clear()
    this.home.refresh()
  }

  /** Signed out: the person changed settings here. They go to the home host, now or when it is back. */
  recordLocalChange(change: PersonalSettingsPatch): void {
    this.home.recordLocalChange(change)
  }

  /** A host said that the person's copy there changed (`personalDocument.changed`). */
  hostChanged(hostId: string): void {
    this.home.hostChanged(hostId)
  }

  /**
   * The copy on screen moved to another source (a sign-in or a sign-out), or the
   * account's copy changed (a start, a confirmed write, a change from another
   * device). Signed in, each ready host takes it again; signed out, the home host
   * is read again.
   */
  accountChanged(): void {
    this.accountCopies.clear()
    this.home.forget()
    this.refresh()
  }

  // ── Signed in: every ready host ──

  /** Asks each ready host that has not seen the account's copy to pull it, and writes it to a host that cannot. */
  private async nudge(): Promise<void> {
    if (this.isNudging) {
      this.nudgeAgain = true
      return
    }
    this.isNudging = true
    try {
      const desired = ordered(this.ports.document())
      const copy = JSON.stringify(desired)
      // A Solus API runs no work, so it keeps no settings (the execution plane).
      const hosts = this.ports.readyHosts().filter((host) => !isSolusApiId(host.hostId) && this.accountCopies.get(host.hostId) !== copy)
      await Promise.all(hosts.map(async (host) => {
        this.accountCopies.set(host.hostId, copy)
        try {
          const held = await host.api.personalSettingsChanged()
          if (held.followsAccount || same(ordered(held.settings), desired)) return
          await host.api.personalSettingsPatch(changeTo(held.settings, desired))
        } catch {
          // An older host, a Solus API, or a dropped connection: the next refresh tries again.
          if (this.accountCopies.get(host.hostId) === copy) this.accountCopies.delete(host.hostId)
        }
      }))
    } finally {
      this.isNudging = false
      if (this.nudgeAgain) {
        this.nudgeAgain = false
        void this.nudge()
      }
    }
  }
}
