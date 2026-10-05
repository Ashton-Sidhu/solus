import { z } from 'zod'
import {
  MAX_PERSONAL_SETTINGS_BYTES,
  PERSONAL_SETTING_KEYS,
  organizationSettingsPatchRequestSchema,
  personalSettingsByteLength,
  personalSettingsDocumentSchema,
  type AccountSettingsResponse,
  type OrganizationSettings,
  type PersonalSettingKey,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { AccountSettingsResult, OrganizationSettingsResult, SettingsCloudRequests } from './settings-requests'

/**
 * Personal settings sync (plans/018 §5). The local personal profile is the
 * source of truth on each client; the account document is its optional replica.
 * This engine moves changes between them and nothing else: the personal store
 * applies what it emits and reports what the person changes. It renders nothing
 * and owns no profile.
 *
 * One engine per client (one per browser tab, which share one storage record and
 * a broadcast port), constructed with injected ports so desktop, web, and native
 * share the same conflict rules. A sync is opt-in per client and per account:
 * signing in alone never uploads.
 *
 * The conflict unit is one top-level key. Local edits wait in a bounded, durable
 * pending patch beside the last confirmed document (the base) and its revision,
 * so a 409 merges three ways: unrelated keys retry against the new revision, and
 * a key both sides changed becomes a visible conflict until the person picks.
 */

// ─── Identity ───

/** The account a client syncs for. Each cloud origin is its own account space. */
export interface SyncAccount {
  origin: string
  userId: string
}

/** The storage key segment of one account; `anonymous` when signed out. Profiles and sync records use it. */
export function settingsAccountKey(account: SyncAccount | null): string {
  return account ? `${account.origin}|${account.userId}` : 'anonymous'
}

const syncRecordStorageKey = (accountKey: string): string => `solus.settings-sync.v1:${accountKey}`

// ─── Ports ───

/** Synchronous key/value storage that survives restart: `localStorage`, or the native `KeyValueStore`. */
export interface SettingsSyncStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type SettingsSyncSignal = 'online' | 'offline' | 'foreground' | 'background'

/** Network and visibility, as the client sees them. */
export interface SettingsSyncEnvironment {
  isOnline(): boolean
  isForeground(): boolean
  subscribe(listener: (signal: SettingsSyncSignal) => void): () => void
}

export interface SettingsSyncClock {
  now(): number
  /** Calls `callback` once after `ms`; the returned function cancels it. */
  setTimer(callback: () => void, ms: number): () => void
}

/** Tells other tabs of this browser profile that an account's sync record changed. */
export interface SettingsSyncMessage {
  accountKey: string
}

export interface SettingsSyncBroadcast {
  post(message: SettingsSyncMessage): void
  subscribe(listener: (message: SettingsSyncMessage) => void): () => void
}

export interface SettingsSyncPorts {
  requests: Pick<SettingsCloudRequests, 'accountSettingsGet' | 'accountSettingsPatch' | 'accountSettingsDelete'>
  storage: SettingsSyncStorage
  environment: SettingsSyncEnvironment
  clock: SettingsSyncClock
  /** Absent where one process is the whole client (native). */
  broadcast?: SettingsSyncBroadcast
}

// ─── Public shapes ───

export type SettingsSyncState = 'signed-out' | 'off' | 'loading' | 'synced' | 'pending' | 'offline' | 'conflict' | 'error'

/**
 * A key both sides changed. Each side is a document holding that one key, or
 * none when that side reset it to the default.
 */
export interface SettingConflict {
  key: PersonalSettingKey
  mine: PersonalSettingsDocument
  theirs: PersonalSettingsDocument
}

export interface SettingsSyncStatus {
  state: SettingsSyncState
  account: SyncAccount | null
  /** The last time the cloud confirmed this client's view. Never an optimistic edit. */
  lastSyncedAt: number | null
  /** Local edits the cloud has not confirmed. */
  pendingKeys: PersonalSettingKey[]
  conflicts: SettingConflict[]
  /** The last refusal, while `state` is `error`. */
  error: { code: string; message: string | null } | null
  /** Set when another client cleared synced settings and this client turned sync off. */
  stoppedReason: 'generation-changed' | null
}

/** A change for the personal profile: keys to set, and keys to return to their default. */
export interface PersonalSettingsChange {
  set: PersonalSettingsDocument
  reset: PersonalSettingKey[]
}

/** What turning sync on would do, read from the cloud before anything is written. */
export type EnableOffer =
  /** No synced document: offer this device's portable settings as the seed. */
  | { kind: 'absent'; generation: number }
  /** A synced document exists: "Use synced settings" by default, or "Replace with this device". */
  | { kind: 'present'; generation: number; revision: number; settings: PersonalSettingsDocument; updatedAt: number | null }

export type EnableChoice =
  | { kind: 'seed'; settings: PersonalSettingsDocument }
  | { kind: 'use-synced' }
  | { kind: 'replace'; settings: PersonalSettingsDocument }

export type SettingsSyncUnavailable = { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'error'; code: string; message: string | null }

export type PrepareEnableOutcome = { kind: 'offer'; offer: EnableOffer } | SettingsSyncUnavailable | { kind: 'cancelled' }

export type EnableOutcome =
  | { kind: 'enabled' }
  /** The cloud changed after the offer; nothing was overwritten. Ask again with this offer. */
  | { kind: 'changed'; offer: EnableOffer }
  /** The choice does not match the current offer, or the settings fail the schema or size bound. */
  | { kind: 'invalid' }
  | { kind: 'cancelled' }
  | SettingsSyncUnavailable

export type LocalChangeOutcome = 'queued' | 'ignored' | 'invalid' | 'too-large'

export type ClearOutcome =
  | { kind: 'cleared'; generation: number }
  /** Unsent edits would be lost. Explain them, then call again with `discardUnsent`. */
  | { kind: 'has-unsent'; keys: PersonalSettingKey[] }
  | { kind: 'cancelled' }
  | SettingsSyncUnavailable

// ─── Timing ───

/** How long after the last local edit the patch is sent. */
export const SETTINGS_SYNC_DEBOUNCE_MS = 1_500
/** Refresh period while foreground, online, and on. */
export const SETTINGS_SYNC_POLL_MS = 60_000
/** Patches tried against a moving revision before the engine stops and waits for the next trigger. */
export const SETTINGS_SYNC_MAX_ATTEMPTS = 4

// ─── Durable record ───

// SAFETY: `PERSONAL_SETTING_KEYS` is derived from the exhaustive owner table and is never empty.
const settingKeySchema = z.enum(PERSONAL_SETTING_KEYS as [PersonalSettingKey, ...PersonalSettingKey[]])

const syncRecordSchema = z.object({
  enabled: z.boolean(),
  generation: z.number().int().nonnegative().nullable(),
  revision: z.number().int().positive().nullable(),
  /** The last document the cloud confirmed. */
  base: personalSettingsDocumentSchema,
  pendingSet: personalSettingsDocumentSchema,
  pendingReset: z.array(settingKeySchema),
  conflicts: z.array(z.object({ key: settingKeySchema, mine: personalSettingsDocumentSchema, theirs: personalSettingsDocumentSchema })),
  lastSyncedAt: z.number().nullable(),
  stoppedReason: z.literal('generation-changed').nullable(),
})
type SyncRecord = z.infer<typeof syncRecordSchema>

const syncRecordJsonSchema = z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(syncRecordSchema)

function offRecord(): SyncRecord {
  return { enabled: false, generation: null, revision: null, base: {}, pendingSet: {}, pendingReset: [], conflicts: [], lastSyncedAt: null, stoppedReason: null }
}

// ─── Document helpers ───

/** One key's value in a document; undefined when absent (the default). */
type SettingValue = PersonalSettingsDocument[PersonalSettingKey]

/** Value equality for settings: key order does not matter, absent equals absent. */
function sameValue(left: SettingValue, right: SettingValue): boolean {
  return canonical(left) === canonical(right)
}

/** JSON with object keys sorted, so two equal values from different writers compare equal. */
function canonical(value: SettingValue | SettingsSyncStatus): string | undefined {
  // The replacer sees each nested value of `value` as JSON.stringify walks it.
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Object && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry)
}

function hasKey(document: PersonalSettingsDocument, key: PersonalSettingKey): boolean {
  return Object.hasOwn(document, key)
}

function valueOf(document: PersonalSettingsDocument, key: PersonalSettingKey): SettingValue {
  return document[key]
}

/** Copies one key (or its absence) from `source` into `target`. */
function copyKey(target: PersonalSettingsDocument, source: PersonalSettingsDocument, key: PersonalSettingKey): void {
  if (hasKey(source, key)) Object.assign(target, { [key]: structuredClone(source[key]) })
  else delete target[key]
}

function onlyKey(source: PersonalSettingsDocument, key: PersonalSettingKey): PersonalSettingsDocument {
  const document: PersonalSettingsDocument = {}
  copyKey(document, source, key)
  return document
}

function isPending(record: SyncRecord, key: PersonalSettingKey): boolean {
  return hasKey(record.pendingSet, key) || record.pendingReset.includes(key)
}

/** The pending value of a key as a one-key document; empty for a pending reset. */
function pendingDocument(record: SyncRecord, key: PersonalSettingKey): PersonalSettingsDocument {
  return onlyKey(record.pendingSet, key)
}

function dropPending(record: SyncRecord, key: PersonalSettingKey): void {
  delete record.pendingSet[key]
  record.pendingReset = record.pendingReset.filter((candidate) => candidate !== key)
}

/** Records `desired` (a one-key document, or empty for default) as the local value of `key`. */
function setPending(record: SyncRecord, key: PersonalSettingKey, desired: PersonalSettingsDocument): void {
  dropPending(record, key)
  if (sameValue(valueOf(desired, key), valueOf(record.base, key))) return
  if (hasKey(desired, key)) copyKey(record.pendingSet, desired, key)
  else record.pendingReset.push(key)
}

function pendingKeys(record: SyncRecord): PersonalSettingKey[] {
  return PERSONAL_SETTING_KEYS.filter((key) => isPending(record, key))
}

function emptyChange(): PersonalSettingsChange {
  return { set: {}, reset: [] }
}

function addToChange(change: PersonalSettingsChange, source: PersonalSettingsDocument, key: PersonalSettingKey): void {
  if (hasKey(source, key)) copyKey(change.set, source, key)
  else change.reset.push(key)
}

function isEmptyChange(change: PersonalSettingsChange): boolean {
  return Object.keys(change.set).length === 0 && change.reset.length === 0
}

/**
 * Adopts a newer cloud document into the record: the three-way merge. Keys only
 * the cloud changed go into the returned change for the local profile. A pending
 * key the cloud left alone stays pending; one the cloud changed to the same value
 * is confirmed; one changed to something else becomes a conflict.
 */
function adoptRemote(record: SyncRecord, remote: AccountSettingsResponse): PersonalSettingsChange {
  const change = emptyChange()
  const before = record.base
  const after = remote.settings
  for (const key of PERSONAL_SETTING_KEYS) {
    const conflict = record.conflicts.find((candidate) => candidate.key === key)
    if (conflict) {
      conflict.theirs = onlyKey(after, key)
      if (sameValue(valueOf(conflict.mine, key), valueOf(after, key))) {
        record.conflicts = record.conflicts.filter((candidate) => candidate !== conflict)
      }
      continue
    }
    const remoteValue = valueOf(after, key)
    if (isPending(record, key)) {
      const mine = pendingDocument(record, key)
      if (sameValue(valueOf(mine, key), remoteValue)) dropPending(record, key)
      else if (!sameValue(valueOf(before, key), remoteValue)) {
        dropPending(record, key)
        record.conflicts.push({ key, mine, theirs: onlyKey(after, key) })
      }
      continue
    }
    if (!sameValue(valueOf(before, key), remoteValue)) addToChange(change, after, key)
  }
  record.base = structuredClone(after)
  record.revision = remote.revision
  return change
}

/** The edits of an enabled record that would leave the size bound. */
function exceedsBound(record: SyncRecord): boolean {
  const merged: PersonalSettingsDocument = { ...record.base, ...record.pendingSet }
  for (const key of record.pendingReset) delete merged[key]
  return personalSettingsByteLength(merged) > MAX_PERSONAL_SETTINGS_BYTES
}

// ─── Engine ───

type Failure = { kind: 'offline' } | { kind: 'error'; code: string; message: string | null } | null

export class SettingsSync {
  private account: SyncAccount | null = null
  private accountKey: string | null = null
  private record: SyncRecord = offRecord()
  /** Grows on account switch, sign-out, and dispose: every older answer is dropped. */
  private accountEpoch = 0
  /** Grows when sync is turned off or cleared here: an older answer is reported, never resumed. */
  private enableEpoch = 0
  private isAuthLost = false
  private failure: Failure = null
  private busyCount = 0
  private offer: { offer: EnableOffer; accountEpoch: number } | null = null
  private queued: { read: boolean } | null = null
  private chain: Promise<void> = Promise.resolve()
  private cancelDebounce: (() => void) | null = null
  private cancelPoll: (() => void) | null = null
  private status: SettingsSyncStatus
  private readonly statusListeners = new Set<(status: SettingsSyncStatus) => void>()
  private readonly changeListeners = new Set<(change: PersonalSettingsChange) => void>()
  private readonly unsubscribes: Array<() => void> = []

  constructor(private readonly ports: SettingsSyncPorts) {
    this.status = this.computeStatus()
    this.unsubscribes.push(ports.environment.subscribe((signal) => this.onSignal(signal)))
    if (ports.broadcast) {
      this.unsubscribes.push(ports.broadcast.subscribe((message) => {
        if (message.accountKey === this.accountKey) this.reload()
      }))
    }
  }

  // ── Reading ──

  get current(): SettingsSyncStatus {
    return this.status
  }

  subscribe(listener: (status: SettingsSyncStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** Cloud changes for the personal profile to apply. Never an echo of this client's own edit. */
  onRemoteChange(listener: (change: PersonalSettingsChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  // ── Account lifecycle ──

  /**
   * The account owner names who is signed in (null when nobody is). A different
   * account cancels all work first: no answer for the previous account reaches the
   * next one, and its queue is never sent for the next one. The same account again
   * (after a 401 and a fresh sign-in) resumes.
   */
  setAccount(account: SyncAccount | null): void {
    const accountKey = account ? settingsAccountKey(account) : null
    if (accountKey === this.accountKey) {
      if (this.isAuthLost) {
        this.isAuthLost = false
        this.afterChange()
        if (this.record.enabled) void this.schedule(true)
      }
      return
    }
    this.cancelWork()
    this.account = account
    this.accountKey = accountKey
    this.isAuthLost = false
    this.failure = null
    this.record = accountKey ? this.load(accountKey) : offRecord()
    this.afterChange()
    if (this.record.enabled) void this.schedule(true)
  }

  /**
   * Sign-out: sync stops, and this account's consent, pending edits, and confirmed
   * copy leave this client. Ask about `current.pendingKeys` before calling.
   */
  signOut(): void {
    const accountKey = this.accountKey
    this.setAccount(null)
    if (accountKey) {
      this.ports.storage.removeItem(syncRecordStorageKey(accountKey))
      this.ports.broadcast?.post({ accountKey })
    }
  }

  dispose(): void {
    this.cancelWork()
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.statusListeners.clear()
    this.changeListeners.clear()
  }

  // ── Turning sync on and off ──

  /** Reads the cloud before anything is written. Shows `loading` meanwhile. */
  async prepareEnable(): Promise<PrepareEnableOutcome> {
    if (!this.accountKey) return { kind: 'signed-out' }
    const accountEpoch = this.accountEpoch
    const result = await this.busy(() => this.ports.requests.accountSettingsGet())
    if (accountEpoch !== this.accountEpoch) return { kind: 'cancelled' }
    if (result.kind !== 'ok') return this.unavailable(result)
    const offer = offerFrom(result.settings)
    this.offer = { offer, accountEpoch }
    return { kind: 'offer', offer }
  }

  /**
   * Turns sync on with the person's choice for the last offer. Seeding creates the
   * document only if none exists; replacing writes only over the revision offered.
   * Either answers `changed` instead of overwriting a newer document.
   */
  async enable(choice: EnableChoice): Promise<EnableOutcome> {
    const held = this.offer
    if (!this.accountKey || !held || held.accountEpoch !== this.accountEpoch) return { kind: 'invalid' }
    const { offer } = held
    if (choice.kind === 'use-synced') {
      if (offer.kind !== 'present') return { kind: 'invalid' }
      this.offer = null
      this.enableEpoch += 1
      const change = emptyChange()
      for (const key of PERSONAL_SETTING_KEYS) addToChange(change, offer.settings, key)
      this.failure = null
      this.mutate((record) => {
        Object.assign(record, offRecord(), {
          enabled: true,
          generation: offer.generation,
          revision: offer.revision,
          base: structuredClone(offer.settings),
          lastSyncedAt: this.ports.clock.now(),
        })
        return change
      })
      void this.schedule(true)
      return { kind: 'enabled' }
    }
    if ((choice.kind === 'seed') !== (offer.kind === 'absent')) return { kind: 'invalid' }
    const parsed = personalSettingsDocumentSchema.safeParse(choice.settings)
    if (!parsed.success || personalSettingsByteLength(parsed.data) > MAX_PERSONAL_SETTINGS_BYTES) return { kind: 'invalid' }
    const settings = parsed.data
    const accountEpoch = this.accountEpoch
    const result = await this.busy(() => this.ports.requests.accountSettingsPatch({
      generation: offer.generation,
      expectedRevision: offer.kind === 'present' ? offer.revision : null,
      set: settings,
      reset: offer.kind === 'present' ? PERSONAL_SETTING_KEYS.filter((key) => hasKey(offer.settings, key) && !hasKey(settings, key)) : [],
    }))
    if (accountEpoch !== this.accountEpoch) return { kind: 'cancelled' }
    if (result.kind === 'conflict') {
      const next = offerFrom(result.current)
      this.offer = { offer: next, accountEpoch }
      return { kind: 'changed', offer: next }
    }
    if (result.kind !== 'ok') return this.unavailable(result)
    this.offer = null
    this.enableEpoch += 1
    this.failure = null
    const confirmed = result.settings
    this.mutate((record) => {
      Object.assign(record, offRecord(), {
        enabled: true,
        generation: confirmed.generation,
        revision: confirmed.revision,
        // The local profile holds what was sent; the confirmed document is applied over it below.
        base: structuredClone(settings),
        lastSyncedAt: this.ports.clock.now(),
      })
      return adoptRemote(record, confirmed)
    })
    return { kind: 'enabled' }
  }

  /**
   * "Turn off on this device": no further transfers. Confirmed values stay in the
   * local profile; the cloud document and other clients are left alone. A write
   * already in flight may still commit; its confirmation is recorded, nothing more.
   */
  turnOff(): void {
    if (!this.accountKey) return
    this.enableEpoch += 1
    this.cancelTimers()
    this.queued = null
    this.failure = null
    this.mutate((record) => {
      record.enabled = false
      record.pendingSet = {}
      record.pendingReset = []
      record.conflicts = []
      record.stoppedReason = null
    })
  }

  /**
   * "Clear synced settings": deletes the cloud document and advances its
   * generation, so every client still holding the old one stops and cannot
   * restore it. Online only. Turns sync off here too; local values stay.
   */
  async clearCloud(options: { discardUnsent?: boolean } = {}): Promise<ClearOutcome> {
    if (!this.accountKey) return { kind: 'signed-out' }
    if (!this.ports.environment.isOnline()) return { kind: 'offline' }
    const unsent = pendingKeys(this.record)
    if (this.record.enabled && unsent.length > 0 && !options.discardUnsent) return { kind: 'has-unsent', keys: unsent }
    const accountEpoch = this.accountEpoch
    const result = await this.busy(() => this.ports.requests.accountSettingsDelete())
    if (accountEpoch !== this.accountEpoch) return { kind: 'cancelled' }
    // A clear answers 409 only if another client cleared first; its generation is the new one either way.
    if (result.kind !== 'ok' && result.kind !== 'conflict') return this.unavailable(result)
    const cleared = result.kind === 'ok' ? result.settings : result.current
    this.enableEpoch += 1
    this.cancelTimers()
    this.queued = null
    this.offer = null
    this.failure = null
    this.mutate((record) => {
      Object.assign(record, offRecord(), { generation: cleared.generation, lastSyncedAt: record.lastSyncedAt })
    })
    return { kind: 'cleared', generation: cleared.generation }
  }

  // ── Changes ──

  /**
   * A change the person made to the local profile. Queued only while sync is on;
   * otherwise it stays local. Sent after the person stops editing.
   */
  recordLocalChange(change: Partial<PersonalSettingsChange>): LocalChangeOutcome {
    if (!this.accountKey || !this.record.enabled) return 'ignored'
    const parsed = personalSettingsDocumentSchema.safeParse(change.set ?? {})
    const reset = z.array(settingKeySchema).safeParse(change.reset ?? [])
    if (!parsed.success || !reset.success) return 'invalid'
    let outcome: LocalChangeOutcome = 'queued'
    this.mutate((record) => {
      const draft = structuredClone(record)
      const apply = (key: PersonalSettingKey, desired: PersonalSettingsDocument) => {
        const conflict = draft.conflicts.find((candidate) => candidate.key === key)
        if (!conflict) return setPending(draft, key, desired)
        // Still a conflict: the person has not picked a side yet, only changed theirs.
        conflict.mine = desired
        if (sameValue(valueOf(desired, key), valueOf(conflict.theirs, key))) {
          draft.conflicts = draft.conflicts.filter((candidate) => candidate !== conflict)
        }
      }
      for (const key of PERSONAL_SETTING_KEYS) if (hasKey(parsed.data, key)) apply(key, onlyKey(parsed.data, key))
      for (const key of reset.data) apply(key, {})
      if (exceedsBound(draft)) {
        outcome = 'too-large'
        return
      }
      Object.assign(record, draft)
    })
    if (outcome === 'queued') this.debounceSend()
    return outcome
  }

  resolveConflict(key: PersonalSettingKey, choice: 'keep-mine' | 'take-theirs'): void {
    const conflict = this.record.conflicts.find((candidate) => candidate.key === key)
    if (!conflict) return
    this.mutate((record) => {
      const current = record.conflicts.find((candidate) => candidate.key === key)
      if (!current) return
      record.conflicts = record.conflicts.filter((candidate) => candidate !== current)
      if (choice === 'keep-mine') return setPending(record, key, current.mine)
      const change = emptyChange()
      addToChange(change, current.theirs, key)
      return change
    })
    if (choice === 'keep-mine') void this.schedule(false)
  }

  /** Reads the cloud now (Settings opened, a manual refresh), then sends what is pending. */
  refresh(): Promise<void> {
    return this.schedule(true)
  }

  /** Settles when the queued syncs have run. */
  idle(): Promise<void> {
    return this.chain
  }

  // ── The sync loop ──

  /** Queues one sync. A sync already queued absorbs this one. */
  private schedule(read: boolean): Promise<void> {
    if (this.queued) {
      this.queued.read ||= read
      return this.chain
    }
    this.queued = { read }
    this.chain = this.chain.then(async () => {
      const job = this.queued
      this.queued = null
      if (job) await this.run(job.read)
    })
    return this.chain
  }

  private async run(read: boolean): Promise<void> {
    if (!this.isActive()) return
    if (!this.ports.environment.isOnline()) {
      this.setFailure({ kind: 'offline' })
      return
    }
    const accountEpoch = this.accountEpoch
    const enableEpoch = this.enableEpoch
    const isCurrent = () => accountEpoch === this.accountEpoch && enableEpoch === this.enableEpoch
    if (read) {
      const result = await this.ports.requests.accountSettingsGet()
      if (!isCurrent()) return
      if (result.kind !== 'ok') return this.handleFailure(result)
      if (!this.adopt(result.settings)) return
      this.mutate((record) => { record.lastSyncedAt = this.ports.clock.now() })
      this.setFailure(null)
    }
    for (let attempt = 0; attempt < SETTINGS_SYNC_MAX_ATTEMPTS; attempt += 1) {
      const sent = this.record
      if (pendingKeys(sent).length === 0 || sent.generation === null) return
      const set = structuredClone(sent.pendingSet)
      const reset = [...sent.pendingReset]
      const result = await this.ports.requests.accountSettingsPatch({ generation: sent.generation, expectedRevision: sent.revision, set, reset })
      if (accountEpoch !== this.accountEpoch) return
      if (enableEpoch !== this.enableEpoch) {
        // Turned off while this write was in flight: record a commit, resume nothing.
        if (result.kind === 'ok') this.mutate((record) => { record.lastSyncedAt = this.ports.clock.now() })
        return
      }
      if (result.kind === 'ok') {
        this.mutate((record) => {
          // What was sent is now confirmed: fold it into the base so it is not echoed back.
          for (const key of PERSONAL_SETTING_KEYS) {
            const wasSent = hasKey(set, key) || reset.includes(key)
            if (!wasSent) continue
            copyKey(record.base, set, key)
            if (sameValue(valueOf(pendingDocument(record, key), key), valueOf(set, key)) && isPending(record, key)) dropPending(record, key)
          }
          record.lastSyncedAt = this.ports.clock.now()
          return adoptRemote(record, result.settings)
        })
        this.setFailure(null)
        continue
      }
      if (result.kind === 'conflict' && result.reason === 'settings_conflict') {
        if (!this.adopt(result.current)) return
        continue
      }
      return this.handleFailure(result)
    }
    if (pendingKeys(this.record).length > 0) {
      this.setFailure({ kind: 'error', code: 'conflict_retries_exhausted', message: 'The synced settings kept changing. Sync tries again later.' })
    }
  }

  /** Applies a cloud document; false when its generation ended this client's sync. */
  private adopt(remote: AccountSettingsResponse): boolean {
    if (remote.generation !== this.record.generation) {
      this.stopForGeneration(remote.generation)
      return false
    }
    this.mutate((record) => adoptRemote(record, remote))
    return true
  }

  private handleFailure(result: Exclude<AccountSettingsResult, { kind: 'ok' }>): void {
    if (result.kind === 'conflict') {
      // `settings_generation_changed`: someone cleared synced settings.
      this.stopForGeneration(result.current.generation)
      return
    }
    if (result.kind === 'signed-out') {
      this.isAuthLost = true
      this.cancelTimers()
      this.afterChange()
      return
    }
    this.setFailure(result.kind === 'offline' ? { kind: 'offline' } : { kind: 'error', code: result.code, message: result.message })
  }

  /** Another client cleared synced settings: turn off and drop every old-generation edit. */
  private stopForGeneration(generation: number): void {
    this.enableEpoch += 1
    this.cancelTimers()
    this.queued = null
    this.failure = null
    this.mutate((record) => {
      Object.assign(record, offRecord(), { generation, lastSyncedAt: record.lastSyncedAt, base: record.base, stoppedReason: 'generation-changed' })
    })
  }

  // ── Timers and signals ──

  private onSignal(signal: SettingsSyncSignal): void {
    this.updateTimers()
    this.afterChange()
    // Back online or in front: catch up now.
    if ((signal === 'online' || signal === 'foreground') && this.isActive()) void this.schedule(true)
  }

  private debounceSend(): void {
    this.cancelDebounce?.()
    this.cancelDebounce = this.ports.clock.setTimer(() => {
      this.cancelDebounce = null
      void this.schedule(false)
    }, SETTINGS_SYNC_DEBOUNCE_MS)
  }

  private updateTimers(): void {
    const shouldPoll = this.isActive() && this.ports.environment.isOnline() && this.ports.environment.isForeground()
    if (!shouldPoll) {
      this.cancelPoll?.()
      this.cancelPoll = null
      return
    }
    if (this.cancelPoll) return
    this.cancelPoll = this.ports.clock.setTimer(() => {
      this.cancelPoll = null
      void this.schedule(true)
      this.updateTimers()
    }, SETTINGS_SYNC_POLL_MS)
  }

  private cancelTimers(): void {
    this.cancelDebounce?.()
    this.cancelDebounce = null
    this.cancelPoll?.()
    this.cancelPoll = null
  }

  private cancelWork(): void {
    this.accountEpoch += 1
    this.enableEpoch += 1
    this.cancelTimers()
    this.queued = null
    this.offer = null
    this.busyCount = 0
    // An unanswered request of the previous account must not hold up the next one.
    this.chain = Promise.resolve()
  }

  // ── State ──

  private isActive(): boolean {
    return this.accountKey !== null && !this.isAuthLost && this.record.enabled
  }

  private async busy<T>(work: () => Promise<T>): Promise<T> {
    const accountEpoch = this.accountEpoch
    this.busyCount += 1
    this.afterChange()
    try {
      return await work()
    } finally {
      if (accountEpoch === this.accountEpoch) {
        this.busyCount -= 1
        this.afterChange()
      }
    }
  }

  private unavailable(result: Exclude<AccountSettingsResult, { kind: 'ok' }>): SettingsSyncUnavailable {
    if (result.kind === 'conflict') return { kind: 'error', code: result.reason, message: null }
    if (result.kind === 'signed-out') {
      this.isAuthLost = true
      this.afterChange()
    }
    return result
  }

  private setFailure(failure: Failure): void {
    this.failure = failure
    this.afterChange()
  }

  private load(accountKey: string): SyncRecord {
    const raw = this.ports.storage.getItem(syncRecordStorageKey(accountKey))
    if (!raw) return offRecord()
    const parsed = syncRecordJsonSchema.safeParse(raw)
    return parsed.success ? parsed.data : offRecord()
  }

  /**
   * Re-reads the record another tab wrote. Cloud values it confirmed that this tab
   * has not applied yet are emitted here.
   */
  private reload(): void {
    if (!this.accountKey) return
    this.adoptStored(this.load(this.accountKey))
    this.afterChange()
  }

  private adoptStored(next: SyncRecord): void {
    const previous = this.record
    if (next.enabled && previous.enabled) {
      const change = emptyChange()
      for (const key of PERSONAL_SETTING_KEYS) {
        if (isPending(next, key) || next.conflicts.some((conflict) => conflict.key === key)) continue
        if (!sameValue(valueOf(previous.base, key), valueOf(next.base, key))) addToChange(change, next.base, key)
      }
      this.emit(change)
    }
    if (previous.enabled && !next.enabled) {
      this.enableEpoch += 1
      this.queued = null
    }
    this.record = next
    this.updateTimers()
  }

  /**
   * Every write to the record: read what storage holds now (another tab may have
   * written), change it, store it, tell the other tabs.
   */
  private mutate(change: (record: SyncRecord) => PersonalSettingsChange | void): void {
    const accountKey = this.accountKey
    if (!accountKey) return
    this.adoptStored(this.load(accountKey))
    const record = structuredClone(this.record)
    const remote = change(record)
    this.record = record
    this.ports.storage.setItem(syncRecordStorageKey(accountKey), JSON.stringify(record))
    this.ports.broadcast?.post({ accountKey })
    this.updateTimers()
    this.afterChange()
    // Applied after the record is stored, so a listener that writes back sees it.
    if (remote) this.emit(remote)
  }

  private emit(change: PersonalSettingsChange): void {
    if (isEmptyChange(change)) return
    for (const listener of this.changeListeners) listener(change)
  }

  private afterChange(): void {
    const next = this.computeStatus()
    if (canonical(next) === canonical(this.status)) return
    this.status = next
    for (const listener of this.statusListeners) listener(next)
  }

  private computeStatus(): SettingsSyncStatus {
    const record = this.record
    const failure = this.failure
    const state: SettingsSyncState = !this.accountKey || this.isAuthLost
      ? 'signed-out'
      : !record.enabled
        ? this.busyCount > 0 ? 'loading' : 'off'
        : record.conflicts.length > 0
          ? 'conflict'
          : failure?.kind === 'offline' || !this.ports.environment.isOnline()
            ? 'offline'
            : failure?.kind === 'error'
              ? 'error'
              : pendingKeys(record).length > 0 ? 'pending' : 'synced'
    return {
      state,
      account: this.account,
      lastSyncedAt: this.accountKey ? record.lastSyncedAt : null,
      pendingKeys: record.enabled ? pendingKeys(record) : [],
      conflicts: structuredClone(record.conflicts),
      error: state === 'error' && failure?.kind === 'error' ? { code: failure.code, message: failure.message } : null,
      stoppedReason: record.stoppedReason,
    }
  }
}

function offerFrom(settings: AccountSettingsResponse): EnableOffer {
  return settings.revision === null
    ? { kind: 'absent', generation: settings.generation }
    : { kind: 'present', generation: settings.generation, revision: settings.revision, settings: settings.settings, updatedAt: settings.updatedAt }
}

// ─── Organization settings ───

export type OrganizationSettingsWriteResult = OrganizationSettingsResult | { kind: 'invalid'; message: string }

/**
 * The organization settings (today only Sync all Insights), read and saved over
 * the same request port. Writes are never queued: an owner saves a draft against
 * the revision they read, online, and sees a conflict at once. A write is checked
 * against the strict write schema here so a bad draft is refused before it
 * leaves the client.
 */
export class OrganizationSettingsClient {
  constructor(private readonly requests: Pick<SettingsCloudRequests, 'organizationSettingsGet' | 'organizationSettingsPatch'>) {}

  read(organizationId: string): Promise<OrganizationSettingsResult> {
    return this.requests.organizationSettingsGet(organizationId)
  }

  async save(organizationId: string, expectedRevision: number, settings: Partial<OrganizationSettings>): Promise<OrganizationSettingsWriteResult> {
    const request = organizationSettingsPatchRequestSchema.safeParse({ expectedRevision, settings })
    if (!request.success) return { kind: 'invalid', message: z.prettifyError(request.error) }
    return this.requests.organizationSettingsPatch(organizationId, request.data)
  }
}
