import { EventEmitter } from 'events'
import type { RpcMethod, RpcTopic } from '../../shared/rpc'
import { createLogger, isDebugEnabled } from '../logger'

const log = createLogger('server', 'server.ts')

/**
 * The single dispatch core. Both transports (Electron IPC + WebSocket) attach
 * to this server and forward requests through `handle()`. Global events flow
 * through `broadcast()`. Tab-scoped events use `sendTargeted()` so only their
 * owning transport receives the payload while retaining reconnect replay.
 *
 * The server is transport-agnostic: it doesn't know about IPC channels,
 * BrowserWindow, or sockets. Transports are thin shims that translate
 * their wire format into method+args.
 */
export class SolusServer {
  private handlers = new Map<RpcMethod, Handler>()
  private emitter = new EventEmitter()
  private seqCounters = new Map<RpcTopic, number>()
  private buffer = new Map<RpcTopic, BufferedEvent[]>()
  private directClients = new Map<string, DirectTopicListener[]>()
  private targetedSeqCounters = new Map<string, Map<RpcTopic, number>>()
  private targetedBuffer = new Map<string, Map<RpcTopic, BufferedEvent[]>>()
  private targetedCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Ring buffer per topic for resume; capped at BUFFER_LIMIT events.
  // Used by the WebSocket transport when a client reconnects with a last-seen seq.
  private static readonly BUFFER_LIMIT = 1024
  private static readonly TARGETED_BUFFER_TTL_MS = 6 * 60_000
  private static readonly TARGETED_TOPICS = new Set<RpcTopic>(['normalized-event', 'enriched-error'])

  constructor() {
    // Allow many transports to subscribe per topic without warnings.
    this.emitter.setMaxListeners(100)
  }

  register<M extends RpcMethod>(method: M, handler: Handler): void {
    if (this.handlers.has(method)) {
      throw new Error(`SolusServer: duplicate handler for "${method}"`)
    }
    this.handlers.set(method, handler)
  }

  async handle(method: RpcMethod, args: unknown[], ctx?: HandlerCtx): Promise<unknown> {
    if (isDebugEnabled) log.debug(`Running ${method} with args: ${JSON.stringify(args)}`)
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`SolusServer: no handler for "${method}"`)
    return await handler(args, ctx ?? {})
  }

  hasHandler(method: string): method is RpcMethod {
    return this.handlers.has(method as RpcMethod)
  }

  subscribe(topic: RpcTopic, listener: TopicListener): () => void {
    this.emitter.on(topic, listener)
    return () => this.emitter.off(topic, listener)
  }

  registerDirectClient(clientId: string, listener: DirectTopicListener): () => void {
    const cleanupTimer = this.targetedCleanupTimers.get(clientId)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    this.targetedCleanupTimers.delete(clientId)
    const listeners = this.directClients.get(clientId) ?? []
    listeners.push(listener)
    this.directClients.set(clientId, listeners)
    return () => {
      const current = this.directClients.get(clientId)
      if (!current) return
      const index = current.indexOf(listener)
      if (index === -1) return
      current.splice(index, 1)
      if (current.length > 0) return
      this.directClients.delete(clientId)
      const timer = setTimeout(() => {
        this.targetedSeqCounters.delete(clientId)
        this.targetedBuffer.delete(clientId)
        this.targetedCleanupTimers.delete(clientId)
      }, SolusServer.TARGETED_BUFFER_TTL_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.targetedCleanupTimers.set(clientId, timer)
    }
  }

  broadcast(topic: RpcTopic, ...payload: unknown[]): void {
    if (isDebugEnabled) log.debug(`Sending payload ${JSON.stringify(payload)} to topic ${topic}`)
    const seq = this._retain(topic, payload)
    this.emitter.emit(topic, payload, seq)
  }

  sendTo(clientId: string, topic: RpcTopic, ...payload: unknown[]): boolean {
    const listener = this.directClients.get(clientId)?.at(-1)
    if (!listener) return false
    listener(topic, payload)
    return true
  }

  /**
   * Sends a tab-scoped event only to its owning client while retaining a
   * per-client sequence stream for WebSocket reconnect replay. Targeted topics
   * never consume the global topic sequence, so an event for one client cannot
   * create an apparent replay gap for another.
   */
  sendTargeted(clientId: string, topic: 'normalized-event' | 'enriched-error', ...payload: unknown[]): boolean {
    const seq = this._retainTargeted(clientId, topic, payload)
    const listener = this.directClients.get(clientId)?.at(-1)
    if (!listener) return false
    listener(topic, payload, seq)
    return true
  }

  private _retain(topic: RpcTopic, payload: unknown[]): number {
    const seq = (this.seqCounters.get(topic) ?? 0) + 1
    this.seqCounters.set(topic, seq)

    const ring = this.buffer.get(topic) ?? []
    ring.push({ seq, payload, timestamp: Date.now() })
    if (ring.length > SolusServer.BUFFER_LIMIT) ring.shift()
    this.buffer.set(topic, ring)
    return seq
  }

  private _retainTargeted(clientId: string, topic: RpcTopic, payload: unknown[]): number {
    let counters = this.targetedSeqCounters.get(clientId)
    if (!counters) {
      counters = new Map()
      this.targetedSeqCounters.set(clientId, counters)
    }
    const seq = (counters.get(topic) ?? 0) + 1
    counters.set(topic, seq)

    let topics = this.targetedBuffer.get(clientId)
    if (!topics) {
      topics = new Map()
      this.targetedBuffer.set(clientId, topics)
    }
    const ring = topics.get(topic) ?? []
    ring.push({ seq, payload, timestamp: Date.now() })
    if (ring.length > SolusServer.BUFFER_LIMIT) ring.shift()
    topics.set(topic, ring)
    return seq
  }

  /**
   * Returns events newer than `lastSeq` for the given topic. Used by the
   * WebSocket transport's resume protocol — if the buffer doesn't go back
   * far enough, returns null and the client should perform a full reload.
   */
  replayFrom(topic: RpcTopic, lastSeq: number, clientId?: string): BufferedEvent[] | null {
    if (SolusServer.TARGETED_TOPICS.has(topic)) {
      if (!clientId) return null
      return this._replayFrom(
        this.targetedSeqCounters.get(clientId)?.get(topic) ?? 0,
        this.targetedBuffer.get(clientId)?.get(topic),
        lastSeq,
      )
    }
    return this._replayFrom(this.seqCounters.get(topic) ?? 0, this.buffer.get(topic), lastSeq)
  }

  /**
   * Resolves all streams a reconnect must replay. Global topics remain opt-in:
   * only topics in the client's watermark are considered. Targeted topics are
   * always probed from zero so their first event cannot be missed when it was
   * emitted while the client was disconnected.
   */
  replayForResume(
    clientId: string,
    lastSeqByTopic: Partial<Record<RpcTopic, number>>,
  ): Array<{ topic: RpcTopic; events: BufferedEvent[] }> | null {
    const requested = new Map<RpcTopic, number>()
    for (const [topic, lastSeq] of Object.entries(lastSeqByTopic)) {
      if (typeof lastSeq === 'number') requested.set(topic as RpcTopic, lastSeq)
    }
    for (const topic of SolusServer.TARGETED_TOPICS) {
      if (!requested.has(topic)) requested.set(topic, 0)
    }

    const result: Array<{ topic: RpcTopic; events: BufferedEvent[] }> = []
    for (const [topic, lastSeq] of requested) {
      const events = this.replayFrom(topic, lastSeq, clientId)
      if (events === null) return null
      if (events.length > 0) result.push({ topic, events })
    }
    return result
  }

  private _replayFrom(currentSeq: number, ring: BufferedEvent[] | undefined, lastSeq: number): BufferedEvent[] | null {
    if (lastSeq > currentSeq) return null // server/client stream identity changed — force a fresh snapshot
    if (currentSeq === lastSeq) return [] // client already caught up
    // Behind, but nothing retained — force a re-snapshot rather than silently skipping.
    if (!ring || ring.length === 0) return null
    if (ring[0].seq > lastSeq + 1) return null // gap — caller should re-snapshot
    return ring.filter(e => e.seq > lastSeq)
  }

  getSeqWatermark(clientId?: string): Record<string, number> {
    const entries = [...this.seqCounters.entries()].filter(([topic]) => !SolusServer.TARGETED_TOPICS.has(topic))
    if (clientId) {
      entries.push(...(this.targetedSeqCounters.get(clientId)?.entries() ?? []))
    }
    return Object.fromEntries(entries)
  }
}

export type Handler = (args: unknown[], ctx: HandlerCtx) => unknown | Promise<unknown>

export interface HandlerCtx {
  /** Identifies the client that issued the call (e.g. "ws:abcd"). */
  clientId?: string
  /** Web-client device label, set after pairing. */
  deviceLabel?: string
  /**
   * Stable device identifier from the paired client session token. Used to scope
   * tabs per-device so one device's tabs don't appear on another device's snapshot.
   */
  deviceId?: string
}

export type TopicListener = (payload: unknown[], seq: number) => void
export type DirectTopicListener = (topic: RpcTopic, payload: unknown[], seq?: number) => void

interface BufferedEvent {
  seq: number
  payload: unknown[]
  timestamp: number
}
