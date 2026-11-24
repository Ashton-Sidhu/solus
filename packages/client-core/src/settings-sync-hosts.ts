import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import { hostConfigPatchSchema, sharedHostConfigOf, type HostConfigPatch } from '@solus/contracts/host-config'
import {
  PERSONAL_SETTING_KEYS,
  PERSONAL_SETTING_SCHEMAS,
  type HostPersonalSettings,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
  type PersonalSettingsPatch,
} from '@solus/contracts/settings'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { DocumentSyncStorage } from './document-sync'
import { HostRpcError } from './rpc-error'

/**
 * Sync settings (docs/plans/settings-sync-hosts.md): a signed-out person's server
 * settings — their personal settings on a host and the shared host settings — the
 * same on each of their hosts whose Sync settings switch is on. One per client.
 *
 * Hosts never talk to each other: this client copies the settings to a host that
 * the person adds (`hostAdded`), and sends each later change that the person makes
 * on a synced host to the other synced hosts (`personalChanged`,
 * `hostConfigChanged`). What a host that is away must take waits in storage, and
 * goes when the host is ready (`refresh`). Before it sends, this reads the host's
 * switch: a host whose switch is off keeps its own settings. Signed in, the account
 * keeps every host the same (ADR 0007), so this copies and sends nothing.
 */

/** A host this client can call now. */
export interface SettingsSyncHost {
  api: Pick<SolusAPI, 'personalSettingsGet' | 'personalSettingsPatch' | 'personalSettingsSyncSet' | 'configGet' | 'configUpdate'>
  /** The person may change this host's config (`host.admin`). */
  mayWriteHostConfig(): boolean
}

export interface SettingsSyncHostsPorts {
  /** Every host this client knows, ready or not. */
  knownHostIds(): string[]
  /** A host's calls when it is ready; null when it is not. */
  readyHost(hostId: string): SettingsSyncHost | null
  /** Signed in, the account is the source of every host's settings. */
  isSignedIn(): boolean
  /** The host a new host copies from: the home host (`personalSettingsHomeId`); null with none. */
  copySourceId(): string | null
  /** Durable storage for what waits for a host. */
  storage: DocumentSyncStorage
  /** The switch of a host changed, or became known. */
  onSwitchesChange?(): void
}

/** What waits for one host. */
interface Pending {
  /** The switch to set first: from the Sync settings checkbox when the person added the host. */
  syncSettings?: boolean
  /** Copy the server settings of this host first (the person added the host with Sync settings on). */
  copyFrom?: string
  /** Personal changes made on a synced host since. */
  personal: PersonalSettingsPatch
  /** Shared host settings changed on a synced host since. */
  hostConfig: HostConfigPatch
}

const STORAGE_PREFIX = 'solus.settings-sync.pending.v1:'

// SAFETY: `PERSONAL_SETTING_KEYS` is derived from the exhaustive owner table and is never empty.
const personalKeySchema = z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])

/** A stored queue, key by key: a value that no longer passes its schema is dropped. */
const pendingSchema = z.object({
  syncSettings: z.boolean().optional(),
  copyFrom: z.string().min(1).optional(),
  personal: z.object({
    set: z.looseObject({}).transform((stored) => {
      const set: PersonalSettingsDocument = {}
      for (const key of PERSONAL_SETTING_KEYS) {
        const parsed = PERSONAL_SETTING_SCHEMAS[key].safeParse(stored[key])
        if (Object.hasOwn(stored, key) && parsed.success) Object.assign(set, { [key]: parsed.data })
      }
      return set
    }),
    reset: z.array(z.string()).transform((keys) => keys.flatMap((key) => personalKeySchema.safeParse(key).data ?? [])),
  }),
  hostConfig: z.looseObject({}).transform((stored) => sharedHostConfigOf(hostConfigPatchSchema.safeParse(stored).data ?? {})),
})

function emptyPending(): Pending {
  return { personal: { set: {}, reset: [] }, hostConfig: {} }
}

function same<V>(left: V, right: V): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Keys sorted, so two equal documents compare equal. */
function sorted(document: PersonalSettingsDocument): [string, unknown][] {
  return Object.entries(document).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function hasPersonalChange(change: PersonalSettingsPatch): boolean {
  return Object.keys(change.set).length > 0 || change.reset.length > 0
}

/** `change` laid over `pending`: the last value of a key wins. */
function mergePersonal(pending: PersonalSettingsPatch, change: PersonalSettingsPatch): void {
  const setKeys = Object.keys(change.set)
  pending.reset = pending.reset.filter((key) => !setKeys.includes(key))
  Object.assign(pending.set, structuredClone(change.set))
  for (const key of change.reset) {
    delete pending.set[key]
    if (!pending.reset.includes(key)) pending.reset.push(key)
  }
}

/** The document `copy`, with `change` laid over it. */
function applied(copy: PersonalSettingsDocument, change: PersonalSettingsPatch): PersonalSettingsDocument {
  const result = structuredClone(copy)
  for (const key of change.reset) delete result[key]
  return Object.assign(result, structuredClone(change.set))
}

/** The change that makes a host's copy equal to `desired`. */
function changeTo(current: PersonalSettingsDocument, desired: PersonalSettingsDocument): PersonalSettingsPatch {
  const reset = PERSONAL_SETTING_KEYS.filter((key) => Object.hasOwn(current, key) && !Object.hasOwn(desired, key))
  return { set: structuredClone(desired), reset }
}

export class SettingsSyncHosts {
  /** hostId → the person's switch there, as the host last said (or as the person chose). */
  private readonly switches = new Map<string, boolean>()
  /** The ready hosts whose switch was read since they became ready. */
  private readonly read = new Set<string>()
  private readonly sending = new Set<string>()
  private readonly sendAgain = new Set<string>()

  constructor(private readonly ports: SettingsSyncHostsPorts) {}

  /** The person's switch on a host; null before this client read it. */
  switchOf(hostId: string): boolean | null {
    return this.switches.get(hostId) ?? null
  }

  /**
   * A host connected or left, or the person signed in or out. Each ready host is
   * read once after it became ready, and takes what waits for it.
   */
  refresh(): void {
    for (const hostId of [...this.read]) if (!this.ports.readyHost(hostId)) this.read.delete(hostId)
    if (this.ports.isSignedIn()) return
    for (const hostId of this.ports.knownHostIds()) {
      if (isSolusApiId(hostId) || !this.ports.readyHost(hostId)) continue
      if (!this.read.has(hostId) || this.hasPending(hostId)) void this.send(hostId)
    }
  }

  /** A host said that the person's switch there changed (`personalDocument.changed`). */
  hostChanged(hostId: string): void {
    this.read.delete(hostId)
    if (!this.ports.isSignedIn()) void this.send(hostId)
  }

  /** The person turned the switch of a ready host on or off. It changes no setting. */
  async setSwitch(hostId: string, syncSettings: boolean): Promise<void> {
    const host = this.ports.readyHost(hostId)
    if (!host) throw new Error('This host cannot be reached now.')
    const held = await host.api.personalSettingsSyncSet(syncSettings)
    this.learnSwitch(hostId, held.syncSettings)
    // Off: what waits for the host is no longer wanted. On: it takes the changes made from now on.
    if (!held.syncSettings) this.dropQueuedSettings(hostId)
  }

  /**
   * The person added or paired a host. With Sync settings on, it takes the server
   * settings of the copy source (the home host, else `fromHostId`), and its switch
   * is on. With it off, nothing is copied, and its switch is off.
   */
  hostAdded(hostId: string, choice: { syncSettings: boolean; fromHostId?: string | null }): void {
    if (this.ports.isSignedIn() || isSolusApiId(hostId)) return
    const source = this.ports.copySourceId() ?? choice.fromHostId ?? null
    const pending: Pending = emptyPending()
    pending.syncSettings = choice.syncSettings
    if (choice.syncSettings && source && source !== hostId) pending.copyFrom = source
    this.store(hostId, pending)
    this.learnSwitch(hostId, choice.syncSettings)
    this.read.delete(hostId)
    void this.send(hostId)
  }

  /** The person changed their settings on `fromHostId`. A synced host's change goes to the other synced hosts. */
  personalChanged(fromHostId: string, change: PersonalSettingsPatch): void {
    if (!hasPersonalChange(change)) return
    this.spread(fromHostId, (pending) => mergePersonal(pending.personal, change))
  }

  /** The person changed host settings on `fromHostId`. Only the shared keys go to the other synced hosts. */
  hostConfigChanged(fromHostId: string, patch: HostConfigPatch): void {
    const shared = sharedHostConfigOf(patch)
    if (Object.keys(shared).length === 0) return
    this.spread(fromHostId, (pending) => Object.assign(pending.hostConfig, shared))
  }

  /** The person forgot a host on this client: nothing waits for it any more. */
  forget(hostId: string): void {
    this.ports.storage.removeItem(STORAGE_PREFIX + hostId)
    this.read.delete(hostId)
    if (this.switches.delete(hostId)) this.ports.onSwitchesChange?.()
  }

  private spread(fromHostId: string, add: (pending: Pending) => void): void {
    if (this.ports.isSignedIn() || this.switchOf(fromHostId) === false) return
    for (const hostId of this.ports.knownHostIds()) {
      if (hostId === fromHostId || isSolusApiId(hostId) || this.switchOf(hostId) === false) continue
      const pending = this.pending(hostId)
      add(pending)
      this.store(hostId, pending)
      void this.send(hostId)
    }
  }

  /** Reads the host's switch, then sends what waits for it. One at a time per host; a call during one runs once after it. */
  private async send(hostId: string): Promise<void> {
    if (this.sending.has(hostId)) {
      this.sendAgain.add(hostId)
      return
    }
    const host = this.ports.readyHost(hostId)
    if (!host || this.ports.isSignedIn()) return
    this.sending.add(hostId)
    try {
      let pending = this.pending(hostId)
      let held: HostPersonalSettings
      if (pending.syncSettings !== undefined) {
        held = await host.api.personalSettingsSyncSet(pending.syncSettings)
        const now = this.pending(hostId)
        delete now.syncSettings
        this.store(hostId, now)
      } else {
        held = await host.api.personalSettingsGet()
      }
      this.read.add(hostId)
      this.learnSwitch(hostId, held.syncSettings)
      pending = this.pending(hostId)
      // Off: the host keeps its own settings.
      if (!held.syncSettings) {
        this.dropQueuedSettings(hostId)
        return
      }
      let personal = pending.personal
      let hostConfig = pending.hostConfig
      if (pending.copyFrom) {
        const source = this.ports.readyHost(pending.copyFrom)
        // The copy waits until its source is ready too.
        if (!source) return
        const [copy, config] = await Promise.all([source.api.personalSettingsGet(), source.api.configGet()])
        personal = changeTo(held.settings, applied(copy.settings, pending.personal))
        hostConfig = { ...sharedHostConfigOf(config.config), ...pending.hostConfig }
      }
      if (hasPersonalChange(personal) && !same(sorted(applied(held.settings, personal)), sorted(held.settings))) {
        await host.api.personalSettingsPatch(personal)
      }
      if (Object.keys(hostConfig).length > 0 && host.mayWriteHostConfig()) {
        try {
          await host.api.configUpdate(hostConfig)
        } catch (error) {
          // The host refused it (a policy lock, or a key this older host does not know): a retry would be refused again.
          if (!(error instanceof HostRpcError)) throw error
        }
      }
      this.dropSent(hostId, pending)
    } catch {
      // An older host, or a connection that dropped: what waits stays, and the next refresh tries again.
      this.read.delete(hostId)
    } finally {
      this.sending.delete(hostId)
      if (this.sendAgain.delete(hostId)) void this.send(hostId)
    }
  }

  private learnSwitch(hostId: string, syncSettings: boolean): void {
    if (this.switches.get(hostId) === syncSettings) return
    this.switches.set(hostId, syncSettings)
    this.ports.onSwitchesChange?.()
  }

  /** A host with its switch off: only a switch that waits to be set stays. */
  private dropQueuedSettings(hostId: string): void {
    const now = this.pending(hostId)
    this.store(hostId, now.syncSettings === undefined ? emptyPending() : { ...emptyPending(), syncSettings: now.syncSettings })
  }

  /** What was sent stops waiting; a key the person changed again since stays. */
  private dropSent(hostId: string, sent: Pending): void {
    const now = this.pending(hostId)
    if (now.copyFrom === sent.copyFrom) delete now.copyFrom
    for (const [key, value] of Object.entries(sent.personal.set)) {
      if (Object.hasOwn(now.personal.set, key) && same(Object.getOwnPropertyDescriptor(now.personal.set, key)?.value, value)) Reflect.deleteProperty(now.personal.set, key)
    }
    now.personal.reset = now.personal.reset.filter((key) => !sent.personal.reset.includes(key))
    for (const [key, value] of Object.entries(sent.hostConfig)) {
      if (Object.hasOwn(now.hostConfig, key) && same(Object.getOwnPropertyDescriptor(now.hostConfig, key)?.value, value)) Reflect.deleteProperty(now.hostConfig, key)
    }
    this.store(hostId, now)
  }

  private hasPending(hostId: string): boolean {
    return this.ports.storage.getItem(STORAGE_PREFIX + hostId) !== null
  }

  private pending(hostId: string): Pending {
    const raw = this.ports.storage.getItem(STORAGE_PREFIX + hostId)
    if (!raw) return emptyPending()
    try {
      const parsed = pendingSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : emptyPending()
    } catch {
      return emptyPending()
    }
  }

  private store(hostId: string, pending: Pending): void {
    const isEmpty = pending.syncSettings === undefined && !pending.copyFrom
      && !hasPersonalChange(pending.personal) && Object.keys(pending.hostConfig).length === 0
    if (isEmpty) this.ports.storage.removeItem(STORAGE_PREFIX + hostId)
    else this.ports.storage.setItem(STORAGE_PREFIX + hostId, JSON.stringify(pending))
  }
}
