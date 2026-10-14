import { z } from 'zod'

/**
 * Sync of one keyed account document (plans/018 §5, plans/020 §3). The local
 * copy is the source of truth on each client; the account document is its
 * optional replica. This engine moves changes between them and nothing else:
 * the local store applies what it emits and reports what the person changes.
 * It renders nothing and owns no document.
 *
 * The engine is one for every synced document — the personal settings and the
 * agent profile — and a `SyncedDocumentContract` names what differs: the keys a
 * document may hold, its schema and size bound, and where its record is kept.
 *
 * One engine per client and shape (one per browser tab, which share one
 * storage record and a broadcast port), constructed with injected ports so
 * desktop, web, and native share the same conflict rules. Signed in is synced
 * (plans/018 decision 9): the engine starts by itself when an account is set.
 * It reads the account first; a document with content there replaces this
 * device's copy, and an absent or empty one is created from this device's copy
 * (`ports.localCopy`). A generation another device advanced, by clearing, is
 * the same start again, never a stop.
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
export function syncAccountKey(account: SyncAccount | null): string {
  return account ? `${account.origin}|${account.userId}` : 'anonymous'
}

// ─── The contract of one synced document ───

/** A document is an object of optional keys; an absent key reads as the default. Its keys are the conflict units. */
export type DocumentKey<D extends object> = Extract<keyof D, string>

export interface SyncedDocumentContract<D extends object, K extends DocumentKey<D>> {
  /** Where this shape's record for an account is kept. */
  storageKey(accountKey: string): string
  keySchema: z.ZodType<K>
  documentSchema: z.ZodType<D>
  /** The keys these documents hold, or every key the shape allows when the key set is fixed. */
  keysOf(...documents: D[]): K[]
  empty(): D
  byteLength(document: D): number
  maxBytes: number
  /** What a person reads when a patch kept losing the revision race. */
  retriesExhaustedMessage: string
}

// ─── Requests ───

/** The account's copy, as the cloud answered. */
export interface SyncedDocument<D> {
  generation: number
  /** Null before the first write of a generation. */
  revision: number | null
  document: D
  updatedAt: number | null
}

export interface DocumentPatchRequest<D, K extends string> {
  generation: number
  expectedRevision: number | null
  set: D
  reset: K[]
}

export type DocumentSyncResult<D> =
  | { kind: 'ok'; document: SyncedDocument<D> }
  /** A stale revision, or a generation another client advanced. `code` is the server's own word for it. */
  | { kind: 'conflict'; reason: 'revision' | 'generation'; code: string; current: SyncedDocument<D> }
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'error'; code: string; message: string | null }

export interface DocumentSyncRequests<D, K extends string> {
  get(): Promise<DocumentSyncResult<D>>
  patch(request: DocumentPatchRequest<D, K>): Promise<DocumentSyncResult<D>>
  delete(): Promise<DocumentSyncResult<D>>
}

// ─── Ports ───

/** Synchronous key/value storage that survives restart: `localStorage`, or the native `KeyValueStore`. */
export interface DocumentSyncStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type DocumentSyncSignal = 'online' | 'offline' | 'foreground' | 'background'

/** Network and visibility, as the client sees them. */
export interface DocumentSyncEnvironment {
  isOnline(): boolean
  isForeground(): boolean
  subscribe(listener: (signal: DocumentSyncSignal) => void): () => void
}

export interface DocumentSyncClock {
  now(): number
  /** Calls `callback` once after `ms`; the returned function cancels it. */
  setTimer(callback: () => void, ms: number): () => void
}

/** Tells other tabs of this browser profile that an account's sync record changed. */
export interface DocumentSyncMessage {
  accountKey: string
}

export interface DocumentSyncBroadcast {
  post(message: DocumentSyncMessage): void
  subscribe(listener: (message: DocumentSyncMessage) => void): () => void
}

export interface DocumentSyncPorts<D, K extends string> {
  requests: DocumentSyncRequests<D, K>
  storage: DocumentSyncStorage
  environment: DocumentSyncEnvironment
  clock: DocumentSyncClock
  /** Absent where one process is the whole client (native). */
  broadcast?: DocumentSyncBroadcast
  /**
   * This device's copy. For `seed`, the account's first copy when the account
   * has none: on the desktop, this computer's profile. For `replace`, what the
   * account's copy replaces key by key: this client's own copy.
   */
  localCopy(purpose: 'seed' | 'replace'): Promise<D> | D
}

// ─── Public shapes ───

/** `loading` until the account has been read for this device and account; the rest while it has. */
export type DocumentSyncState = 'signed-out' | 'loading' | 'synced' | 'pending' | 'offline' | 'conflict' | 'error'

/**
 * A key both sides changed. Each side is a document holding that one key, or
 * none when that side reset it to the default.
 */
export interface DocumentConflict<D, K extends string> {
  key: K
  mine: D
  theirs: D
}

export interface DocumentSyncStatus<D, K extends string> {
  state: DocumentSyncState
  account: SyncAccount | null
  /** The account document's generation this device is on; null until the account was read. A clear moves it. */
  generation: number | null
  /** The last time the cloud confirmed this client's view. Never an optimistic edit. */
  lastSyncedAt: number | null
  /** Local edits the cloud has not confirmed. */
  pendingKeys: K[]
  conflicts: DocumentConflict<D, K>[]
  /** The last refusal, while `state` is `error`. */
  error: { code: string; message: string | null } | null
}

/** A change for the local copy: keys to set, and keys to return to their default. */
export interface DocumentChange<D, K extends string> {
  set: D
  reset: K[]
}

export type DocumentSyncUnavailable = { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'error'; code: string; message: string | null }

export type LocalChangeOutcome = 'queued' | 'ignored' | 'invalid' | 'too-large'

export type ClearOutcome<K extends string> =
  | { kind: 'cleared'; generation: number }
  /** Unsent edits would be lost. Explain them, then call again with `discardUnsent`. */
  | { kind: 'has-unsent'; keys: K[] }
  | { kind: 'cancelled' }
  | DocumentSyncUnavailable

// ─── Timing ───

/** How long after the last local edit the patch is sent. */
export const DOCUMENT_SYNC_DEBOUNCE_MS = 1_500
/** Refresh period while foreground, online, and on. */
export const DOCUMENT_SYNC_POLL_MS = 60_000
/** Patches tried against a moving revision before the engine stops and waits for the next trigger. */
export const DOCUMENT_SYNC_MAX_ATTEMPTS = 4
/** Starts tried while another device keeps writing the first copy. */
const START_MAX_ATTEMPTS = 3

// ─── Durable record ───

interface SyncRecord<D, K extends string> {
  /** Null until the account was read for this device: nothing is sent before that. */
  generation: number | null
  revision: number | null
  /** The last document the cloud confirmed. */
  base: D
  pendingSet: D
  pendingReset: K[]
  conflicts: DocumentConflict<D, K>[]
  lastSyncedAt: number | null
}

function recordSchema<D extends object, K extends DocumentKey<D>>(contract: SyncedDocumentContract<D, K>): z.ZodType<SyncRecord<D, K>> {
  const record = z.object({
    generation: z.number().int().nonnegative().nullable(),
    revision: z.number().int().positive().nullable(),
    base: contract.documentSchema,
    pendingSet: contract.documentSchema,
    pendingReset: z.array(contract.keySchema),
    conflicts: z.array(z.object({ key: contract.keySchema, mine: contract.documentSchema, theirs: contract.documentSchema })),
    lastSyncedAt: z.number().nullable(),
  })
  // SAFETY: each field is parsed by the contract's own schemas, so a parsed record is a `SyncRecord` of that contract's document and keys.
  return record as z.ZodType<SyncRecord<D, K>>
}

// ─── Document helpers ───

/** JSON with object keys sorted, so two equal values from different writers compare equal. */
function canonical<V>(value: V): string | undefined {
  // The replacer sees each nested value of `value` as JSON.stringify walks it.
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Object && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry)
}

/** Value equality: key order does not matter, absent equals absent. */
function sameValue<V>(left: V, right: V): boolean {
  return canonical(left) === canonical(right)
}

function hasKey<D extends object>(document: D, key: DocumentKey<D>): boolean {
  return Object.hasOwn(document, key)
}

function valueOf<D extends object>(document: D, key: DocumentKey<D>): D[DocumentKey<D>] {
  return document[key]
}

/** Copies one key (or its absence) from `source` into `target`. */
function copyKey<D extends object>(target: D, source: D, key: DocumentKey<D>): void {
  if (hasKey(source, key)) Object.assign(target, { [key]: structuredClone(source[key]) })
  else delete target[key]
}

function union<K extends string>(...lists: K[][]): K[] {
  return [...new Set(lists.flat())]
}

// ─── Engine ───

type Failure = { kind: 'offline' } | { kind: 'error'; code: string; message: string | null } | null

export class DocumentSync<D extends object, K extends DocumentKey<D>> {
  private account: SyncAccount | null = null
  private accountKey: string | null = null
  private record: SyncRecord<D, K>
  /** Grows on account switch, sign-out, and dispose: every older answer is dropped. */
  private accountEpoch = 0
  /** Grows when the document starts again (a clear, a generation another device advanced): an older answer is reported, never resumed. */
  private startEpoch = 0
  private isAuthLost = false
  private failure: Failure = null
  private busyCount = 0
  private queued: { read: boolean } | null = null
  private chain: Promise<void> = Promise.resolve()
  private cancelDebounce: (() => void) | null = null
  private cancelPoll: (() => void) | null = null
  private status: DocumentSyncStatus<D, K>
  private readonly recordJsonSchema: z.ZodType<SyncRecord<D, K>, string>
  private readonly statusListeners = new Set<(status: DocumentSyncStatus<D, K>) => void>()
  private readonly changeListeners = new Set<(change: DocumentChange<D, K>) => void>()
  private readonly unsubscribes: Array<() => void> = []

  constructor(private readonly ports: DocumentSyncPorts<D, K>, private readonly contract: SyncedDocumentContract<D, K>) {
    this.record = this.freshRecord()
    this.recordJsonSchema = z.string().transform((text, context) => {
      try {
        return JSON.parse(text)
      } catch {
        context.addIssue({ code: 'custom', message: 'not JSON' })
        return z.NEVER
      }
    }).pipe(recordSchema(contract))
    this.status = this.computeStatus()
    this.unsubscribes.push(ports.environment.subscribe((signal) => this.onSignal(signal)))
    if (ports.broadcast) {
      this.unsubscribes.push(ports.broadcast.subscribe((message) => {
        if (message.accountKey === this.accountKey) this.reload()
      }))
    }
  }

  // ── Reading ──

  get current(): DocumentSyncStatus<D, K> {
    return this.status
  }

  subscribe(listener: (status: DocumentSyncStatus<D, K>) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** Cloud changes for the local copy to apply. Never an echo of this client's own edit. */
  onRemoteChange(listener: (change: DocumentChange<D, K>) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  // ── Account lifecycle ──

  /**
   * The account owner names who is signed in (null when nobody is). A different
   * account cancels all work first: no answer for the previous account reaches the
   * next one, and its queue is never sent for the next one. The same account again
   * (after a 401 and a fresh sign-in) resumes. Signed in, sync starts now: the
   * account is read, and adopted or seeded from this device.
   */
  setAccount(account: SyncAccount | null): void {
    const accountKey = account ? syncAccountKey(account) : null
    if (accountKey === this.accountKey) {
      if (this.isAuthLost) {
        this.isAuthLost = false
        this.afterChange()
        void this.schedule(true)
      }
      return
    }
    this.cancelWork()
    this.account = account
    this.accountKey = accountKey
    this.isAuthLost = false
    this.failure = null
    this.record = this.freshRecord()
    // The record this device kept for the account: its confirmed copy goes to the local copy, pending edits stay pending.
    if (accountKey) this.adoptStored(this.load(accountKey))
    this.afterChange()
    if (accountKey) void this.schedule(true)
  }

  /**
   * Sign-out: sync stops, and this account's pending edits and confirmed copy
   * leave this client. Ask about `current.pendingKeys` before calling.
   */
  signOut(): void {
    const accountKey = this.accountKey
    this.setAccount(null)
    if (accountKey) {
      this.ports.storage.removeItem(this.contract.storageKey(accountKey))
      this.ports.broadcast?.post({ accountKey })
    }
  }

  dispose(): void {
    this.cancelWork()
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.statusListeners.clear()
    this.changeListeners.clear()
  }

  // ── Clearing ──

  /**
   * "Clear synced": deletes the cloud document and advances its generation, so
   * every client still holding the old one starts again and cannot restore it.
   * Online only. This device starts the document again from its own copy.
   */
  async clearCloud(options: { discardUnsent?: boolean } = {}): Promise<ClearOutcome<K>> {
    if (!this.accountKey) return { kind: 'signed-out' }
    if (!this.ports.environment.isOnline()) return { kind: 'offline' }
    const unsent = this.pendingKeys(this.record)
    if (unsent.length > 0 && !options.discardUnsent) return { kind: 'has-unsent', keys: unsent }
    const accountEpoch = this.accountEpoch
    const result = await this.busy(() => this.ports.requests.delete())
    if (accountEpoch !== this.accountEpoch) return { kind: 'cancelled' }
    // A clear answers 409 only if another client cleared first; its generation is the new one either way.
    if (result.kind !== 'ok' && result.kind !== 'conflict') return this.unavailable(result)
    const cleared = result.kind === 'ok' ? result.document : result.current
    await this.startFrom(cleared)
    return { kind: 'cleared', generation: cleared.generation }
  }

  // ── Changes ──

  /**
   * A change the person made to the local copy. Queued once the account has been
   * read for this device; before that it stays local, and the seed reads it from
   * the local copy. Sent after the person stops editing.
   */
  recordLocalChange(change: Partial<DocumentChange<D, K>>): LocalChangeOutcome {
    if (!this.accountKey || this.record.generation === null) return 'ignored'
    const parsed = this.contract.documentSchema.safeParse(change.set ?? this.contract.empty())
    const reset = z.array(this.contract.keySchema).safeParse(change.reset ?? [])
    if (!parsed.success || !reset.success) return 'invalid'
    let outcome: LocalChangeOutcome = 'queued'
    this.mutate((record) => {
      const draft = structuredClone(record)
      const apply = (key: K, desired: D) => {
        const conflict = draft.conflicts.find((candidate) => candidate.key === key)
        if (!conflict) return this.setPending(draft, key, desired)
        // Still a conflict: the person has not picked a side yet, only changed theirs.
        conflict.mine = desired
        if (sameValue(valueOf(desired, key), valueOf(conflict.theirs, key))) {
          draft.conflicts = draft.conflicts.filter((candidate) => candidate !== conflict)
        }
      }
      for (const key of this.contract.keysOf(parsed.data)) if (hasKey(parsed.data, key)) apply(key, this.onlyKey(parsed.data, key))
      for (const key of reset.data) apply(key, this.contract.empty())
      if (this.exceedsBound(draft)) {
        outcome = 'too-large'
        return
      }
      Object.assign(record, draft)
    })
    if (outcome === 'queued') this.debounceSend()
    return outcome
  }

  resolveConflict(key: K, choice: 'keep-mine' | 'take-theirs'): void {
    const conflict = this.record.conflicts.find((candidate) => candidate.key === key)
    if (!conflict) return
    this.mutate((record) => {
      const current = record.conflicts.find((candidate) => candidate.key === key)
      if (!current) return
      record.conflicts = record.conflicts.filter((candidate) => candidate !== current)
      if (choice === 'keep-mine') return this.setPending(record, key, current.mine)
      const change = this.emptyChange()
      this.addToChange(change, current.theirs, key)
      return change
    })
    if (choice === 'keep-mine') void this.schedule(false)
  }

  /** Reads the cloud now (Settings opened, a manual refresh), then sends what is pending. A start that failed is tried again. */
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
    if (!this.isSignedIn()) return
    if (!this.ports.environment.isOnline()) {
      this.setFailure({ kind: 'offline' })
      return
    }
    const accountEpoch = this.accountEpoch
    const startEpoch = this.startEpoch
    const isCurrent = () => accountEpoch === this.accountEpoch && startEpoch === this.startEpoch
    if (this.record.generation === null) {
      // The first sync for this device and account: read, then adopt or seed.
      const result = await this.busy(() => this.ports.requests.get())
      if (!isCurrent()) return
      if (result.kind !== 'ok') return this.noteFailure(result)
      if (!(await this.startFrom(result.document))) return
      return this.send()
    }
    if (read) {
      const result = await this.ports.requests.get()
      if (!isCurrent()) return
      if (result.kind !== 'ok') return this.noteFailure(result)
      if (result.document.generation !== this.record.generation) {
        // Another device cleared the synced document: this one starts again on the new copy.
        await this.startFrom(result.document)
        return
      }
      this.mutate((record) => {
        const change = this.adoptRemote(record, result.document)
        record.lastSyncedAt = this.ports.clock.now()
        return change
      })
      this.setFailure(null)
    }
    return this.send()
  }

  /** Sends what is pending, merging three ways against a moving revision. */
  private async send(): Promise<void> {
    const accountEpoch = this.accountEpoch
    const startEpoch = this.startEpoch
    for (let attempt = 0; attempt < DOCUMENT_SYNC_MAX_ATTEMPTS; attempt += 1) {
      const sent = this.record
      if (this.pendingKeys(sent).length === 0 || sent.generation === null) return
      const set = structuredClone(sent.pendingSet)
      const reset = [...sent.pendingReset]
      const result = await this.ports.requests.patch({ generation: sent.generation, expectedRevision: sent.revision, set, reset })
      if (accountEpoch !== this.accountEpoch) return
      if (startEpoch !== this.startEpoch) {
        // Started again while this write was in flight: record a commit, resume nothing.
        if (result.kind === 'ok') this.mutate((record) => { record.lastSyncedAt = this.ports.clock.now() })
        return
      }
      if (result.kind === 'ok') {
        this.mutate((record) => {
          // What was sent is now confirmed: fold it into the base so it is not echoed back.
          for (const key of union(this.contract.keysOf(set), reset)) {
            copyKey(record.base, set, key)
            if (sameValue(valueOf(this.pendingDocument(record, key), key), valueOf(set, key)) && this.isPending(record, key)) this.dropPending(record, key)
          }
          record.lastSyncedAt = this.ports.clock.now()
          return this.adoptRemote(record, result.document)
        })
        this.setFailure(null)
        continue
      }
      if (result.kind === 'conflict') {
        if (result.reason === 'generation') {
          await this.startFrom(result.current)
          return
        }
        this.mutate((record) => this.adoptRemote(record, result.current))
        continue
      }
      return this.noteFailure(result)
    }
    if (this.pendingKeys(this.record).length > 0) {
      this.setFailure({ kind: 'error', code: 'conflict_retries_exhausted', message: this.contract.retriesExhaustedMessage })
    }
  }

  /**
   * The start, on the account's copy as last read: every old-generation edit and
   * conflict is dropped. A copy with content replaces this device's copy; an
   * absent or empty one is created from it. False when it did not finish: the
   * account changed, the cloud refused, or the seed could not be written.
   */
  private async startFrom(remote: SyncedDocument<D>, attempt = 0): Promise<boolean> {
    this.startEpoch += 1
    const accountEpoch = this.accountEpoch
    const startEpoch = this.startEpoch
    const isCurrent = () => accountEpoch === this.accountEpoch && startEpoch === this.startEpoch
    this.cancelDebounce?.()
    this.cancelDebounce = null
    this.failure = null
    this.mutate((record) => {
      Object.assign(record, this.freshRecord(), { generation: remote.generation, lastSyncedAt: record.lastSyncedAt })
    })
    const hasRemote = remote.revision !== null && this.hasContent(remote.document)
    const local = await this.busy(() => Promise.resolve(this.ports.localCopy(hasRemote ? 'replace' : 'seed')))
    if (!isCurrent()) return false
    if (hasRemote) {
      // The account wins: its copy replaces this device's, key by key.
      this.mutate((record) => {
        const change = this.adoptRemote(record, remote)
        for (const key of this.contract.keysOf(local)) {
          if (hasKey(local, key) && !hasKey(remote.document, key) && !change.reset.includes(key)) change.reset.push(key)
        }
        record.lastSyncedAt = this.ports.clock.now()
        return change
      })
      this.setFailure(null)
      return true
    }
    const parsed = this.contract.documentSchema.safeParse(local)
    if (!parsed.success || this.contract.byteLength(parsed.data) > this.contract.maxBytes) {
      this.setFailure({ kind: 'error', code: 'local_copy_invalid', message: 'This device’s copy could not be sent.' })
      return false
    }
    const seed = parsed.data
    if (!this.hasContent(seed)) {
      // Nothing on either side: synced, with nothing to write until an edit.
      this.mutate((record) => { record.revision = remote.revision; record.lastSyncedAt = this.ports.clock.now() })
      this.setFailure(null)
      return true
    }
    const result = await this.busy(() => this.ports.requests.patch({ generation: remote.generation, expectedRevision: remote.revision, set: seed, reset: [] }))
    if (!isCurrent()) return false
    if (result.kind === 'conflict') {
      // Another device wrote the first copy between the read and this write: take that copy instead.
      if (attempt + 1 >= START_MAX_ATTEMPTS) {
        this.setFailure({ kind: 'error', code: 'conflict_retries_exhausted', message: this.contract.retriesExhaustedMessage })
        return false
      }
      return this.startFrom(result.current, attempt + 1)
    }
    if (result.kind !== 'ok') {
      this.noteFailure(result)
      return false
    }
    this.mutate((record) => {
      // The confirmed copy is applied whole: the local copy may not hold what `localCopy` read (a computer's profile).
      record.lastSyncedAt = this.ports.clock.now()
      return this.adoptRemote(record, result.document)
    })
    this.setFailure(null)
    return true
  }

  private noteFailure(result: Exclude<DocumentSyncResult<D>, { kind: 'ok' }>): void {
    if (result.kind === 'conflict') {
      this.setFailure({ kind: 'error', code: result.code, message: null })
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

  // ── Record helpers ──

  private freshRecord(): SyncRecord<D, K> {
    return { generation: null, revision: null, base: this.contract.empty(), pendingSet: this.contract.empty(), pendingReset: [], conflicts: [], lastSyncedAt: null }
  }

  private hasContent(document: D): boolean {
    return this.contract.keysOf(document).some((key) => hasKey(document, key))
  }

  private onlyKey(source: D, key: K): D {
    const document = this.contract.empty()
    copyKey(document, source, key)
    return document
  }

  private isPending(record: SyncRecord<D, K>, key: K): boolean {
    return hasKey(record.pendingSet, key) || record.pendingReset.includes(key)
  }

  /** The pending value of a key as a one-key document; empty for a pending reset. */
  private pendingDocument(record: SyncRecord<D, K>, key: K): D {
    return this.onlyKey(record.pendingSet, key)
  }

  private dropPending(record: SyncRecord<D, K>, key: K): void {
    delete record.pendingSet[key]
    record.pendingReset = record.pendingReset.filter((candidate) => candidate !== key)
  }

  /** Records `desired` (a one-key document, or empty for default) as the local value of `key`. */
  private setPending(record: SyncRecord<D, K>, key: K, desired: D): void {
    this.dropPending(record, key)
    if (sameValue(valueOf(desired, key), valueOf(record.base, key))) return
    if (hasKey(desired, key)) copyKey(record.pendingSet, desired, key)
    else record.pendingReset.push(key)
  }

  private pendingKeys(record: SyncRecord<D, K>): K[] {
    return union(this.contract.keysOf(record.pendingSet), record.pendingReset).filter((key) => this.isPending(record, key))
  }

  private emptyChange(): DocumentChange<D, K> {
    return { set: this.contract.empty(), reset: [] }
  }

  private addToChange(change: DocumentChange<D, K>, source: D, key: K): void {
    if (hasKey(source, key)) copyKey(change.set, source, key)
    else change.reset.push(key)
  }

  /**
   * Adopts a newer cloud document into the record: the three-way merge. Keys only
   * the cloud changed go into the returned change for the local copy. A pending
   * key the cloud left alone stays pending; one the cloud changed to the same value
   * is confirmed; one changed to something else becomes a conflict.
   */
  private adoptRemote(record: SyncRecord<D, K>, remote: SyncedDocument<D>): DocumentChange<D, K> {
    const change = this.emptyChange()
    const before = record.base
    const after = remote.document
    for (const key of union(this.contract.keysOf(before, after, record.pendingSet), record.pendingReset, record.conflicts.map((conflict) => conflict.key))) {
      const conflict = record.conflicts.find((candidate) => candidate.key === key)
      if (conflict) {
        conflict.theirs = this.onlyKey(after, key)
        if (sameValue(valueOf(conflict.mine, key), valueOf(after, key))) {
          record.conflicts = record.conflicts.filter((candidate) => candidate !== conflict)
        }
        continue
      }
      const remoteValue = valueOf(after, key)
      if (this.isPending(record, key)) {
        const mine = this.pendingDocument(record, key)
        if (sameValue(valueOf(mine, key), remoteValue)) this.dropPending(record, key)
        else if (!sameValue(valueOf(before, key), remoteValue)) {
          this.dropPending(record, key)
          record.conflicts.push({ key, mine, theirs: this.onlyKey(after, key) })
        }
        continue
      }
      if (!sameValue(valueOf(before, key), remoteValue)) this.addToChange(change, after, key)
    }
    record.base = structuredClone(after)
    record.revision = remote.revision
    return change
  }

  /** The edits of a record that would leave the size bound. */
  private exceedsBound(record: SyncRecord<D, K>): boolean {
    const merged: D = { ...record.base, ...record.pendingSet }
    for (const key of record.pendingReset) delete merged[key]
    return this.contract.byteLength(merged) > this.contract.maxBytes
  }

  // ── Timers and signals ──

  private onSignal(signal: DocumentSyncSignal): void {
    this.updateTimers()
    this.afterChange()
    // Back online or in front: catch up now, or start again after a failed start.
    if ((signal === 'online' || signal === 'foreground') && this.isSignedIn()) void this.schedule(true)
  }

  private debounceSend(): void {
    this.cancelDebounce?.()
    this.cancelDebounce = this.ports.clock.setTimer(() => {
      this.cancelDebounce = null
      void this.schedule(false)
    }, DOCUMENT_SYNC_DEBOUNCE_MS)
  }

  private updateTimers(): void {
    const shouldPoll = this.isSignedIn() && this.ports.environment.isOnline() && this.ports.environment.isForeground()
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
    }, DOCUMENT_SYNC_POLL_MS)
  }

  private cancelTimers(): void {
    this.cancelDebounce?.()
    this.cancelDebounce = null
    this.cancelPoll?.()
    this.cancelPoll = null
  }

  private cancelWork(): void {
    this.accountEpoch += 1
    this.startEpoch += 1
    this.cancelTimers()
    this.queued = null
    this.busyCount = 0
    // An unanswered request of the previous account must not hold up the next one.
    this.chain = Promise.resolve()
  }

  // ── State ──

  private isSignedIn(): boolean {
    return this.accountKey !== null && !this.isAuthLost
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

  private unavailable(result: Exclude<DocumentSyncResult<D>, { kind: 'ok' }>): DocumentSyncUnavailable {
    if (result.kind === 'conflict') return { kind: 'error', code: result.code, message: null }
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

  private load(accountKey: string): SyncRecord<D, K> {
    const raw = this.ports.storage.getItem(this.contract.storageKey(accountKey))
    if (!raw) return this.freshRecord()
    const parsed = this.recordJsonSchema.safeParse(raw)
    return parsed.success ? parsed.data : this.freshRecord()
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

  private adoptStored(next: SyncRecord<D, K>): void {
    const previous = this.record
    const change = this.emptyChange()
    for (const key of this.contract.keysOf(previous.base, next.base)) {
      if (this.isPending(next, key) || next.conflicts.some((conflict) => conflict.key === key)) continue
      if (!sameValue(valueOf(previous.base, key), valueOf(next.base, key))) this.addToChange(change, next.base, key)
    }
    // Another tab started the document again (a clear, or it signed out): this tab's in-flight answers are dropped.
    if (next.generation !== previous.generation) {
      this.startEpoch += 1
      this.queued = null
    }
    this.emit(change)
    this.record = next
    this.updateTimers()
  }

  /**
   * Every write to the record: read what storage holds now (another tab may have
   * written), change it, store it, tell the other tabs.
   */
  private mutate(change: (record: SyncRecord<D, K>) => DocumentChange<D, K> | void): void {
    const accountKey = this.accountKey
    if (!accountKey) return
    this.adoptStored(this.load(accountKey))
    const record = structuredClone(this.record)
    const remote = change(record)
    this.record = record
    this.ports.storage.setItem(this.contract.storageKey(accountKey), JSON.stringify(record))
    this.ports.broadcast?.post({ accountKey })
    this.updateTimers()
    this.afterChange()
    // Applied after the record is stored, so a listener that writes back sees it.
    if (remote) this.emit(remote)
  }

  private emit(change: DocumentChange<D, K>): void {
    if (Object.keys(change.set).length === 0 && change.reset.length === 0) return
    for (const listener of this.changeListeners) listener(change)
  }

  private afterChange(): void {
    const next = this.computeStatus()
    if (canonical(next) === canonical(this.status)) return
    this.status = next
    for (const listener of this.statusListeners) listener(next)
  }

  private computeStatus(): DocumentSyncStatus<D, K> {
    const record = this.record
    const failure = this.failure
    const isStarted = record.generation !== null
    const state: DocumentSyncState = !this.isSignedIn()
      ? 'signed-out'
      : isStarted && record.conflicts.length > 0
        ? 'conflict'
        : failure?.kind === 'offline' || !this.ports.environment.isOnline()
          ? 'offline'
          : failure?.kind === 'error'
            ? 'error'
            : !isStarted
              ? 'loading'
              : this.pendingKeys(record).length > 0 ? 'pending' : 'synced'
    return {
      state,
      account: this.account,
      generation: this.accountKey ? record.generation : null,
      lastSyncedAt: this.accountKey ? record.lastSyncedAt : null,
      pendingKeys: isStarted ? this.pendingKeys(record) : [],
      conflicts: structuredClone(record.conflicts),
      error: state === 'error' && failure?.kind === 'error' ? { code: failure.code, message: failure.message } : null,
    }
  }
}
