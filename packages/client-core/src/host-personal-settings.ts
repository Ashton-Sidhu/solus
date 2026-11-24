import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import {
  PERSONAL_SETTING_KEYS,
  PERSONAL_SETTING_SCHEMAS,
  type HostPersonalSettings,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
  type PersonalSettingsPatch,
} from '@solus/contracts/settings'
import type { DocumentSyncStorage } from './document-sync'
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

const pendingKey = (hostId: string) => `solus.personal-settings.pending.v1:${hostId}`

// SAFETY: `PERSONAL_SETTING_KEYS` is derived from the exhaustive owner table and is never empty.
const keySchema = z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])

/** A stored pending change, key by key: a value that no longer passes its schema is dropped. */
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

/** `pending` laid over `copy`: what the person sees while their changes wait. */
function withPending(copy: PersonalSettingsDocument, pending: PersonalSettingsPatch): PersonalSettingsDocument {
  const result = structuredClone(copy)
  for (const key of pending.reset) delete result[key]
  Object.assign(result, structuredClone(pending.set))
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
  /** Signed out: the home host whose copy is on screen, once it was read. */
  private readHomeId: string | null = null
  private isSending = false
  private sendAgain = false
  private isNudging = false
  private nudgeAgain = false

  constructor(private readonly ports: PersonalSettingsHostsPorts) {}

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
      this.readHomeId = null
      void this.nudge()
      return
    }
    this.accountCopies.clear()
    const home = this.readyHome()
    if (!home) {
      this.readHomeId = null
      return
    }
    if (this.readHomeId === home.hostId) return
    this.readHomeId = home.hostId
    void this.syncHome()
  }

  /** Signed out: the person changed settings here. They go to the home host, now or when it is back. */
  recordLocalChange(change: PersonalSettingsPatch): void {
    const homeId = this.homeHostId
    if (!homeId) return
    const pending = this.pending(homeId)
    for (const key of Object.keys(change.set)) pending.reset = pending.reset.filter((candidate) => candidate !== key)
    Object.assign(pending.set, structuredClone(change.set))
    for (const key of change.reset) {
      delete pending.set[key]
      if (!pending.reset.includes(key)) pending.reset.push(key)
    }
    this.storePending(homeId, pending)
    void this.syncHome()
  }

  /** A host said that the person's copy there changed (`personalDocument.changed`). */
  hostChanged(hostId: string): void {
    if (!this.ports.isSignedIn() && hostId === this.homeHostId) void this.syncHome()
  }

  /**
   * The copy on screen moved to another source (a sign-in or a sign-out), or the
   * account's copy changed (a start, a confirmed write, a change from another
   * device). Signed in, each ready host takes it again; signed out, the home host
   * is read again.
   */
  accountChanged(): void {
    this.accountCopies.clear()
    this.readHomeId = null
    this.refresh()
  }

  // ── Signed out: the home host ──

  private readyHome(): PersonalSettingsHost | null {
    const homeId = this.homeHostId
    return homeId ? this.ports.readyHosts().find((host) => host.hostId === homeId) ?? null : null
  }

  /** Sends what waits, then shows the home host's copy. One at a time; a call during one runs once after it. */
  private async syncHome(): Promise<void> {
    if (this.isSending) {
      this.sendAgain = true
      return
    }
    const home = this.readyHome()
    if (!home) return
    this.isSending = true
    try {
      const pending = this.pending(home.hostId)
      const hasPending = Object.keys(pending.set).length > 0 || pending.reset.length > 0
      const copy = hasPending ? (await home.api.personalSettingsPatch(pending)).settings : await home.api.personalSettingsGet()
      if (hasPending) this.dropSent(home.hostId, pending)
      // Signed in or moved home while the call ran: the copy is no longer the one on screen.
      if (this.ports.isSignedIn() || this.homeHostId !== home.hostId) return
      this.adopt(copy, this.pending(home.hostId))
    } catch {
      // An older host, or a connection that dropped: the next refresh reads again, and what waits stays.
      this.readHomeId = null
    } finally {
      this.isSending = false
      if (this.sendAgain) {
        this.sendAgain = false
        void this.syncHome()
      }
    }
  }

  private adopt(copy: HostPersonalSettings, pending: PersonalSettingsPatch): void {
    const next = withPending(copy.settings, pending)
    if (!same(ordered(next), ordered(this.ports.document()))) this.ports.adoptHostCopy(next)
  }

  /** The keys sent that the person has not changed again since stop waiting. */
  private dropSent(hostId: string, sent: PersonalSettingsPatch): void {
    const now = this.pending(hostId)
    for (const [key, value] of Object.entries(sent.set)) {
      if (Object.hasOwn(now.set, key) && same(now.set[key as PersonalSettingKey], value)) delete now.set[key as PersonalSettingKey]
    }
    now.reset = now.reset.filter((key) => !sent.reset.includes(key))
    this.storePending(hostId, now)
  }

  private pending(hostId: string): PersonalSettingsPatch {
    const raw = this.ports.storage.getItem(pendingKey(hostId))
    if (!raw) return { set: {}, reset: [] }
    try {
      const parsed = pendingSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : { set: {}, reset: [] }
    } catch {
      return { set: {}, reset: [] }
    }
  }

  private storePending(hostId: string, pending: PersonalSettingsPatch): void {
    if (Object.keys(pending.set).length === 0 && pending.reset.length === 0) this.ports.storage.removeItem(pendingKey(hostId))
    else this.ports.storage.setItem(pendingKey(hostId), JSON.stringify(pending))
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
