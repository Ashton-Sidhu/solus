import * as Y from 'yjs'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { Attribution } from '@solus/contracts/user'
import {
  base64ToBytes,
  bytesToBase64,
  type WorkLiveLock,
  type WorkLiveOpenRequest,
  type WorkLiveOpenResult,
  type WorkLivePushRequest,
  type WorkLivePushResult,
} from '@solus/contracts/work-live'
import type { Principal, RecordScope } from '../admission/principal'
import { resourceRoleAtLeast, type ResourceRole, type ShareResource } from '@solus/contracts/sharing'
import { afterDatabaseCommit } from '../db/database'
import { Work } from '../data/works/work'
import type { WorkLiveBridge } from '../data/works/work-live-bridge'
import { createLogger } from '../logger'
import { absorbIntoLiveDoc, isLiveWorkType, liveSchemaVersion, projectLiveDoc, seedLiveDoc, type LiveWorkType } from './live-codec'
import { hasLiveDoc, loadLiveDoc, saveLiveDoc } from './live-store'

const log = createLogger('folio', 'work-live-manager.ts')

/** The origin of a change the host itself makes to a live doc. */
const HOST_ORIGIN = 'host'
/** The body is projected this long after the last push … */
const PROJECT_IDLE_MS = 800
/** … and at least this often while pushes keep coming. */
const PROJECT_MAX_MS = 4_000
/** A write that never commits (its outer transaction rolled back) releases its lock after this. */
const LOCK_TIMEOUT_MS = 30_000

type LiveTopic = 'workLive.update' | 'workLive.awareness' | 'workLive.state'
type Publish = <K extends LiveTopic>(clientIds: readonly string[], type: K, payload: HostEventMap[K]) => void
type Schedule = (run: () => void, delayMs: number) => () => void

const scheduleTimeout: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

interface RoomClient {
  /** Who opened it, so a share change can check them again. */
  principal: Principal | null
  mode: 'edit' | 'read'
  /** The client's last cursor, for whoever joins after it. Memory only. */
  awareness: string | null
}

/** One work open live: its doc, and the clients that opened it. */
interface Room {
  workId: string
  organizationId: string
  type: LiveWorkType
  doc: Y.Doc
  clientSeqs: Map<string, number>
  clients: Map<string, RoomClient>
  /** Pushes the body does not have yet. */
  dirty: boolean
  lastAuthor: Attribution | null
  cancelIdle: (() => void) | null
  cancelMax: (() => void) | null
}

export interface WorkLiveManagerOptions {
  /** Sends a live topic to exactly these clients: the room, never everyone with access. */
  publish: Publish
  schedule?: Schedule
}

/**
 * The live docs of the works people edit together on this host
 * (docs/plans/work-review-and-live-editing.md, phase 3b). One `Y.Doc` in memory
 * for each work a client has open, and the room of those clients. A push is
 * applied, stored with its receipt, and only then acknowledged and relayed to
 * the room. The body in `works.content` is projected from the doc when edits
 * pause, and before any read (`flush`), so an agent reads what people see.
 *
 * A body written from outside (an agent's `update_work`, a restore, an API
 * write) takes the agent edit lock: pushes are refused as `locked` (clients
 * keep them and retry), the version check runs against the flushed body, and
 * the written body is folded into the doc as a structural change.
 */
export class WorkLiveManager {
  private readonly rooms = new Map<string, Room>()
  private readonly locks = new Map<string, { lock: WorkLiveLock; release: () => void }>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly publish: Publish
  private readonly schedule: Schedule

  constructor(options: WorkLiveManagerOptions) {
    this.publish = options.publish
    this.schedule = options.schedule ?? scheduleTimeout
  }

  /** The hooks `Work` calls; installed at boot with `installWorkLiveBridge`. */
  bridge(): WorkLiveBridge {
    return {
      flush: (workId) => this.flush(workId),
      write: (workId, by, run) => this.write(workId, by, run),
    }
  }

  /** Join the work's room and answer what the client lacks. `canEdit` is the caller's role. */
  async open(input: { clientId: string; principal?: Principal; scope: RecordScope; request: WorkLiveOpenRequest; canEdit: boolean }): Promise<WorkLiveOpenResult> {
    const { clientId, request } = input
    const work = await Work.byId(input.scope, request.workId)
    const type = work.type
    if (!isLiveWorkType(type) || work.mirroredDoc?.provider === 'gdrive') return { mode: 'unsupported' }
    return this.serial(request.workId, async () => {
      const room = this.rooms.get(request.workId) ?? await this.load(work.id, work.organizationId, type, work.content)
      const schemaMatches = request.schemaVersion === liveSchemaVersion(room.type)
      const mode = input.canEdit && schemaMatches ? 'edit' : 'read'
      room.clients.set(clientId, { principal: input.principal ?? null, mode, awareness: room.clients.get(clientId)?.awareness ?? null })
      const others = [...room.clients].filter(([id, client]) => id !== clientId && client.awareness)
      const result: WorkLiveOpenResult = {
        mode,
        update: bytesToBase64(diffFor(room.doc, request.stateVector)),
        stateVector: bytesToBase64(Y.encodeStateVector(room.doc)),
        lastSeq: room.clientSeqs.get(request.clientKey) ?? 0,
        awareness: others.map(([id, client]) => ({ clientId: id, update: client.awareness! })),
        lock: this.locks.get(room.workId)?.lock ?? null,
      }
      if (mode === 'read') result.reason = schemaMatches ? 'role' : 'schema'
      return result
    })
  }

  /** Apply a client's edits, store them with the receipt, then relay them to the room. */
  async push(input: { clientId: string; request: WorkLivePushRequest; author: Attribution | null }): Promise<WorkLivePushResult> {
    const { clientId, request } = input
    return this.serial(request.workId, async () => {
      const room = this.rooms.get(request.workId)
      const client = room?.clients.get(clientId)
      if (!room || !client) return { status: 'not-open' }
      if (client.mode !== 'edit') return { status: 'read-only' }
      if (this.locks.has(room.workId)) return { status: 'locked' }
      const last = room.clientSeqs.get(request.clientKey) ?? 0
      if (request.seq <= last) return { status: 'duplicate', seq: last }
      Y.applyUpdate(room.doc, base64ToBytes(request.update), clientId)
      room.clientSeqs.set(request.clientKey, request.seq)
      try {
        await saveLiveDoc(room.organizationId, room.workId, { state: Y.encodeStateAsUpdate(room.doc), clientSeqs: room.clientSeqs })
      } catch (error) {
        // Memory is ahead of the disk: forget it, so the next open reads what is stored.
        this.drop(room)
        throw error
      }
      this.publish(this.othersIn(room, clientId), 'workLive.update', { workId: room.workId, update: request.update })
      room.lastAuthor = input.author
      this.markDirty(room)
      return { status: 'accepted', seq: request.seq }
    })
  }

  /** Relay a cursor to the room; kept in memory for whoever joins next. */
  awareness(clientId: string, workId: string, update: string): void {
    const room = this.rooms.get(workId)
    const client = room?.clients.get(clientId)
    if (!room || !client) return
    client.awareness = update
    this.publish(this.othersIn(room, clientId), 'workLive.awareness', { workId, clientId, update })
  }

  close(clientId: string, workId: string): void {
    const room = this.rooms.get(workId)
    if (room) this.leave(room, clientId)
  }

  /** A client's socket closed: it leaves every room. */
  disconnected(clientId: string): void {
    for (const room of Array.from(this.rooms.values())) if (room.clients.has(clientId)) this.leave(room, clientId)
  }

  /**
   * A share list changed: check each client in every room once more. One who
   * can no longer open the work leaves its room (its next push is `not-open`,
   * and opening again is refused); one who can no longer edit reads only (its
   * next push is `read-only`). Nobody gains edit here: a reader opens again.
   */
  async revalidate(roleOf: (principal: Principal, resource: ShareResource) => Promise<ResourceRole>): Promise<void> {
    for (const room of Array.from(this.rooms.values())) {
      const resource = { kind: 'work', id: room.workId } as const
      for (const [clientId, client] of Array.from(room.clients)) {
        if (!client.principal) continue
        const role = await roleOf(client.principal, resource).catch(() => 'none' as const)
        if (role === 'none') this.leave(room, clientId)
        else if (!resourceRoleAtLeast(role, 'editor')) client.mode = 'read'
      }
    }
  }

  /** A deleted work's room ends; its clients are told by `works.changed`. */
  forget(workId: string): void {
    const room = this.rooms.get(workId)
    if (room) this.drop(room)
  }

  /** The clients in a work's room. */
  clientsOf(workId: string): string[] {
    return [...this.rooms.get(workId)?.clients.keys() ?? []]
  }

  /**
   * Write the pushes the body does not have yet. Called before every read of a
   * work, and when edits pause. The room is marked clean before the write, so
   * the read inside the write does not flush again.
   */
  async flush(workId: string): Promise<void> {
    const room = this.rooms.get(workId)
    if (!room?.dirty) return
    room.dirty = false
    this.cancelTimers(room)
    try {
      const content = projectLiveDoc(room.type, room.doc)
      const work = await Work.byId(room.organizationId, room.workId)
      await work.applyLiveProjection({ content, author: room.lastAuthor })
    } catch (error) {
      room.dirty = true
      log.error('work_live_projection_failed', { workId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Shutdown: write every body with pushes it does not have yet, after each work's
   * operations in flight (a leaving client's write among them). The pushes are stored
   * already; this keeps the body current for the process that comes next.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.keys(), ...this.chains.keys()].map(workId => this.serial(workId, () => this.flush(workId))))
  }

  // ── Writes from outside the live doc ──────────────────────────────────────

  private async write(workId: string, by: Attribution | null, run: () => Promise<string>): Promise<void> {
    if (!this.rooms.has(workId) && !(await hasLiveDoc(workId))) {
      await run()
      return
    }
    await this.acquireLock(workId, by)
    let content: string
    try {
      await this.flush(workId)
      content = await run()
    } catch (error) {
      this.releaseLock(workId)
      throw error
    }
    await afterDatabaseCommit(async () => {
      try {
        await this.absorb(workId, content)
      } catch (error) {
        log.error('work_live_absorb_failed', { workId, error: error instanceof Error ? error.message : String(error) })
      } finally {
        this.releaseLock(workId)
      }
    })
  }

  /** Pushes already in flight finish first; later ones are answered `locked`. */
  private async acquireLock(workId: string, by: Attribution | null): Promise<void> {
    await this.serial(workId, async () => {
      this.locks.get(workId)?.release()
      const lock: WorkLiveLock = { by }
      const cancel = this.schedule(() => this.releaseLock(workId), LOCK_TIMEOUT_MS)
      this.locks.set(workId, { lock, release: cancel })
      this.announceLock(workId, lock)
    })
  }

  private releaseLock(workId: string): void {
    const held = this.locks.get(workId)
    if (!held) return
    held.release()
    this.locks.delete(workId)
    this.announceLock(workId, null)
  }

  private announceLock(workId: string, lock: WorkLiveLock | null): void {
    const room = this.rooms.get(workId)
    if (room) this.publish([...room.clients.keys()], 'workLive.state', { workId, lock })
  }

  /** Fold a body written from outside into the live doc, and tell the room. */
  private async absorb(workId: string, content: string): Promise<void> {
    await this.serial(workId, async () => {
      const room = this.rooms.get(workId)
      if (room) {
        const updates = captureUpdates(room.doc, () => absorbIntoLiveDoc(room.type, room.doc, content, HOST_ORIGIN))
        if (updates.length === 0) return
        await saveLiveDoc(room.organizationId, workId, { state: Y.encodeStateAsUpdate(room.doc), clientSeqs: room.clientSeqs })
        for (const update of updates) this.publish([...room.clients.keys()], 'workLive.update', { workId, update: bytesToBase64(update) })
        // The body is the one just written; its formatting stays until someone edits live.
        room.dirty = false
        this.cancelTimers(room)
        return
      }
      const stored = await loadLiveDoc(workId)
      if (!stored) return
      const work = await Work.find(stored.organizationId, workId)
      if (!work || !isLiveWorkType(work.type)) return
      const doc = new Y.Doc()
      Y.applyUpdate(doc, stored.state)
      absorbIntoLiveDoc(work.type, doc, content, HOST_ORIGIN)
      await saveLiveDoc(stored.organizationId, workId, { state: Y.encodeStateAsUpdate(doc), clientSeqs: stored.clientSeqs })
    })
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────

  /** The stored doc, or one the host seeds from the body: clients never seed. */
  private async load(workId: string, organizationId: string, type: LiveWorkType, content: string): Promise<Room> {
    const stored = await loadLiveDoc(workId)
    let doc: Y.Doc
    let clientSeqs: Map<string, number>
    if (stored) {
      doc = new Y.Doc()
      Y.applyUpdate(doc, stored.state)
      clientSeqs = stored.clientSeqs
    } else {
      doc = seedLiveDoc(type, content)
      clientSeqs = new Map()
      await saveLiveDoc(organizationId, workId, { state: Y.encodeStateAsUpdate(doc), clientSeqs })
    }
    const room: Room = { workId, organizationId, type, doc, clientSeqs, clients: new Map(), dirty: false, lastAuthor: null, cancelIdle: null, cancelMax: null }
    this.rooms.set(workId, room)
    return room
  }

  private leave(room: Room, clientId: string): void {
    if (!room.clients.delete(clientId)) return
    this.publish([...room.clients.keys()], 'workLive.awareness', { workId: room.workId, clientId, update: null })
    if (room.clients.size > 0) return
    // The last client left: write the body, then let the doc go. Its state is
    // already stored with every push.
    void this.serial(room.workId, async () => {
      if (room.clients.size > 0 || this.rooms.get(room.workId) !== room) return
      await this.flush(room.workId)
      if (room.clients.size === 0) this.drop(room)
    })
  }

  private drop(room: Room): void {
    this.cancelTimers(room)
    if (this.rooms.get(room.workId) === room) this.rooms.delete(room.workId)
    room.doc.destroy()
  }

  private othersIn(room: Room, clientId: string): string[] {
    return [...room.clients.keys()].filter((id) => id !== clientId)
  }

  private markDirty(room: Room): void {
    room.dirty = true
    room.cancelIdle?.()
    room.cancelIdle = this.schedule(() => void this.flush(room.workId), PROJECT_IDLE_MS)
    room.cancelMax ??= this.schedule(() => void this.flush(room.workId), PROJECT_MAX_MS)
  }

  private cancelTimers(room: Room): void {
    room.cancelIdle?.()
    room.cancelMax?.()
    room.cancelIdle = null
    room.cancelMax = null
  }

  /** One work's operations run one after another; a failed one does not block the next. */
  private serial<T>(workId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workId) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(() => undefined, () => undefined)
    this.chains.set(workId, settled)
    void settled.then(() => { if (this.chains.get(workId) === settled) this.chains.delete(workId) })
    return result
  }
}

/** What the host has that a client with this state vector lacks; everything for a vector it cannot read. */
function diffFor(doc: Y.Doc, stateVector: string): Uint8Array {
  try {
    return Y.encodeStateAsUpdate(doc, base64ToBytes(stateVector))
  } catch {
    return Y.encodeStateAsUpdate(doc)
  }
}

function captureUpdates(doc: Y.Doc, change: () => void): Uint8Array[] {
  const updates: Uint8Array[] = []
  const listener = (update: Uint8Array) => updates.push(update)
  doc.on('update', listener)
  try {
    change()
  } finally {
    doc.off('update', listener)
  }
  return updates
}
