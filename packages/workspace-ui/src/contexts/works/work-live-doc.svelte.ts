import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostEventMap } from '@solus/contracts/host-events'
import { uuid } from '@solus/contracts/uuid'
import { base64ToBytes, bytesToBase64, type WorkLiveLock } from '@solus/contracts/work-live'

/**
 * One work open live on this client (docs/plans/work-review-and-live-editing.md,
 * phases 3b and 3c): its `Y.Doc` and awareness, the offline copy on the device,
 * the edits the host has not confirmed, and the connection state the header
 * shows. Editors bind to `doc` and `awareness`; they never call the host.
 *
 * Every local change is kept on the device first, then pushed. A push is
 * dropped from the queue only when the host answers that it is stored. While
 * the connection is down, or the agent holds the work, edits wait; when the
 * connection returns, the client and the host exchange what each lacks.
 */

/** The origin of changes that came from the host, so they are not pushed back. */
export const REMOTE_ORIGIN = 'remote'

/** How often this client's cursor is sent, at most. */
const AWARENESS_INTERVAL_MS = 100
/** Reconnect backoff after a failed open or push. */
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
/** An update that carries nothing: an empty struct set and an empty delete set. */
const EMPTY_UPDATE_BYTES = 2

export type LiveConnection = 'connecting' | 'live' | 'offline' | 'unsupported'

/** Who made a change to the doc: a name like `REMOTE_ORIGIN`, or an undo manager. */
type UpdateOrigin = string | Y.UndoManager | null

/** What the provider needs from the work's host. */
export interface LiveHost {
  api(): HostApi
  subscribe<K extends 'workLive.update' | 'workLive.awareness' | 'workLive.state'>(type: K, listener: (payload: HostEventMap[K]) => void): () => void
  /** Called with true when the connection to the host comes back, false when it drops. */
  onConnection(listener: (connected: boolean) => void): () => void
  isConnected(): boolean
}

/** The device copy of a live doc: kept across restarts until the host has the edits. */
export interface LiveOfflineStore {
  /** Loaded before the doc is watched, so what it loads is never taken for an edit. */
  readonly whenLoaded: Promise<void>
  get(key: 'clientKey' | 'seq' | 'unsent'): Promise<string | number | undefined>
  set(key: 'clientKey' | 'seq' | 'unsent', value: string | number): Promise<void>
  destroy(): Promise<void>
}

export interface WorkLiveDocOptions {
  workId: string
  schemaVersion: number
  host: LiveHost
  /** The device copy; absent in a client with no storage, where edits live in memory. */
  offline?: (doc: Y.Doc) => LiveOfflineStore
  /** A local edit happened: the presence roster says the reader is editing. */
  onLocalEdit?: () => void
  /** The unsent count changed, for the device's list of works with unsent edits. */
  onUnsentChange?: (unsent: number) => void
  schedule?: (run: () => void, delayMs: number) => () => void
}

const scheduleTimeout = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

export class WorkLiveDoc {
  readonly doc = new Y.Doc()
  readonly awareness = new Awareness(this.doc)
  connection = $state<LiveConnection>('connecting')
  /** `read` for a viewer or a commenter, and for a client whose schema is not the host's. */
  mode = $state<'edit' | 'read'>('read')
  readReason = $state<'role' | 'schema' | null>(null)
  /** The agent edit lock: the editor is read-only until it ends. */
  lock = $state<WorkLiveLock | null>(null)
  /** Local edits the host has not confirmed yet. */
  unsent = $state(0)
  /** The first content arrived, from the device copy or the host. */
  ready = $state(false)
  /** Runs before a host update is applied (a raw markdown editor writes its pending text first). */
  beforeRemote: (() => void) | null = null
  /** Runs after a host update was applied. */
  afterRemote: (() => void) | null = null

  private readonly options: WorkLiveDocOptions
  private readonly schedule: (run: () => void, delayMs: number) => () => void
  private offline: LiveOfflineStore | null = null
  private clientKey = ''
  private seq = 0
  private pending: Uint8Array[] = []
  private inFlight: Uint8Array[] | null = null
  private retryDelay = RETRY_BASE_MS
  private cancelRetry: (() => void) | null = null
  private cancelAwareness: (() => void) | null = null
  private awarenessDue = false
  private readonly awarenessClients = new Map<string, Set<number>>()
  private readonly stops: (() => void)[] = []
  private destroyed = false

  constructor(options: WorkLiveDocOptions) {
    this.options = options
    this.schedule = options.schedule ?? scheduleTimeout
  }

  get workId(): string {
    return this.options.workId
  }

  /** Whether the reader may type now. */
  get canEdit(): boolean {
    return this.mode === 'edit' && !this.lock && this.connection !== 'unsupported'
  }

  async start(): Promise<void> {
    this.offline = this.options.offline?.(this.doc) ?? null
    if (this.offline) {
      await this.offline.whenLoaded
      if (this.destroyed) return
      this.clientKey = String((await this.offline.get('clientKey')) ?? '')
      this.seq = Number((await this.offline.get('seq')) ?? 0)
      this.setUnsent(Number((await this.offline.get('unsent')) ?? 0))
      // Edits a previous run could not send are on the device: show them now.
      if (this.doc.store.clients.size > 0) this.ready = true
    }
    if (!this.clientKey) {
      this.clientKey = uuid()
      void this.offline?.set('clientKey', this.clientKey)
    }
    this.doc.on('update', this.onLocalUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    const { host } = this.options
    this.stops.push(
      host.subscribe('workLive.update', (event) => {
        if (event.workId !== this.workId) return
        this.beforeRemote?.()
        Y.applyUpdate(this.doc, base64ToBytes(event.update), REMOTE_ORIGIN)
        this.afterRemote?.()
      }),
      host.subscribe('workLive.awareness', (event) => {
        if (event.workId !== this.workId) return
        if (event.update === null) {
          const ids = this.awarenessClients.get(event.clientId)
          if (ids) removeAwarenessStates(this.awareness, [...ids], REMOTE_ORIGIN)
          this.awarenessClients.delete(event.clientId)
          return
        }
        this.applyRemoteAwareness(event.clientId, event.update)
      }),
      host.subscribe('workLive.state', (event) => {
        if (event.workId !== this.workId) return
        this.lock = event.lock
        if (!event.lock) void this.pump()
      }),
      host.onConnection((connected) => {
        if (connected) void this.connect()
        else this.goOffline()
      }),
    )
    if (host.isConnected()) await this.connect()
    else this.goOffline()
  }

  /** Leave the room and stop listening. The device copy stays for the next open. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.cancelRetry?.()
    this.cancelAwareness?.()
    for (const stop of this.stops) stop()
    this.doc.off('update', this.onLocalUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    if (this.connection === 'live') void this.options.host.api().workLiveClose({ workId: this.workId }).catch(() => {})
    this.awareness.destroy()
    await this.offline?.destroy()
    this.doc.destroy()
  }

  /** Join the room: take what the host has, and queue what it lacks. */
  private async connect(): Promise<void> {
    if (this.destroyed) return
    this.cancelRetry?.()
    this.cancelRetry = null
    if (this.connection !== 'live') this.connection = 'connecting'
    try {
      const result = await this.options.host.api().workLiveOpen({
        workId: this.workId,
        clientKey: this.clientKey,
        schemaVersion: this.options.schemaVersion,
        stateVector: bytesToBase64(Y.encodeStateVector(this.doc)),
      })
      if (this.destroyed) return
      if (result.mode === 'unsupported') {
        this.connection = 'unsupported'
        return
      }
      Y.applyUpdate(this.doc, base64ToBytes(result.update), REMOTE_ORIGIN)
      this.mode = result.mode
      this.readReason = result.reason ?? null
      this.lock = result.lock
      this.seq = Math.max(this.seq, result.lastSeq)
      for (const entry of result.awareness) this.applyRemoteAwareness(entry.clientId, entry.update)
      // Everything the host lacks, including edits made offline or before a
      // restart, is one update; it replaces the queue, which it contains.
      const missing = Y.encodeStateAsUpdate(this.doc, base64ToBytes(result.stateVector))
      this.pending = missing.length > EMPTY_UPDATE_BYTES ? [missing] : []
      this.inFlight = null
      if (this.pending.length === 0) this.setUnsent(0)
      else if (this.unsent === 0) this.setUnsent(1)
      this.ready = true
      this.connection = 'live'
      this.retryDelay = RETRY_BASE_MS
      this.sendAwareness()
      await this.pump()
    } catch (error) {
      if (this.destroyed) return
      if (/Unknown method|Unknown RPC|not registered/i.test(error instanceof Error ? error.message : String(error))) {
        this.connection = 'unsupported'
        return
      }
      this.goOffline()
      this.retryLater()
    }
  }

  /** Send the queued edits as one merged update, one push at a time. */
  private async pump(): Promise<void> {
    if (this.destroyed || this.inFlight || this.pending.length === 0 || this.connection !== 'live' || this.mode !== 'edit' || this.lock) return
    const batch = this.pending
    this.pending = []
    this.inFlight = batch
    const seq = this.seq + 1
    try {
      const result = await this.options.host.api().workLivePush({ workId: this.workId, clientKey: this.clientKey, seq, update: bytesToBase64(Y.mergeUpdates(batch)) })
      if (this.destroyed) return
      this.inFlight = null
      switch (result.status) {
        case 'accepted':
        case 'duplicate':
          this.seq = Math.max(this.seq, result.seq, seq)
          void this.offline?.set('seq', this.seq)
          this.setUnsent(this.pending.length === 0 ? 0 : this.unsent)
          await this.pump()
          return
        case 'locked':
          // Kept, and sent when the lock ends (`workLive.state`).
          this.pending = [...batch, ...this.pending]
          return
        case 'read-only':
          this.pending = [...batch, ...this.pending]
          this.mode = 'read'
          return
        case 'not-open':
          this.pending = [...batch, ...this.pending]
          await this.connect()
          return
      }
    } catch {
      if (this.destroyed) return
      this.inFlight = null
      this.pending = [...batch, ...this.pending]
      this.goOffline()
      this.retryLater()
    }
  }

  private readonly onLocalUpdate = (update: Uint8Array, origin: UpdateOrigin): void => {
    // The host's changes, and the device copy loading, are not the reader's edits.
    if (origin === REMOTE_ORIGIN) return
    this.pending.push(update)
    this.setUnsent(this.unsent + 1)
    this.options.onLocalEdit?.()
    void this.pump()
  }

  private setUnsent(unsent: number): void {
    if (this.unsent === unsent) return
    this.unsent = unsent
    void this.offline?.set('unsent', unsent)
    this.options.onUnsentChange?.(unsent)
  }

  private goOffline(): void {
    if (this.connection !== 'unsupported') this.connection = 'offline'
  }

  private retryLater(): void {
    if (this.cancelRetry || this.destroyed) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null
      if (this.options.host.isConnected()) void this.connect()
    }, delay)
  }

  // ── Awareness ─────────────────────────────────────────────────────────────

  private readonly onAwarenessUpdate = (_change: { added: number[]; updated: number[]; removed: number[] }, origin: string | null): void => {
    if (origin !== 'local') return
    this.awarenessDue = true
    if (this.cancelAwareness) return
    this.sendAwareness()
    this.cancelAwareness = this.schedule(() => {
      this.cancelAwareness = null
      if (this.awarenessDue) this.sendAwareness()
    }, AWARENESS_INTERVAL_MS)
  }

  private sendAwareness(): void {
    this.awarenessDue = false
    if (this.connection !== 'live' || !this.awareness.getLocalState()) return
    const update = bytesToBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
    void this.options.host.api().workLiveAwareness({ workId: this.workId, update }).catch(() => {})
  }

  private applyRemoteAwareness(clientId: string, update: string): void {
    const before = new Set(this.awareness.getStates().keys())
    applyAwarenessUpdate(this.awareness, base64ToBytes(update), REMOTE_ORIGIN)
    const ids = this.awarenessClients.get(clientId) ?? new Set<number>()
    for (const id of this.awareness.getStates().keys()) if (!before.has(id) && id !== this.doc.clientID) ids.add(id)
    this.awarenessClients.set(clientId, ids)
  }
}
