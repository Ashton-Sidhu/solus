import { EventEmitter } from 'events'
import type { RpcMethod, RpcTopic } from '../../shared/rpc'
import { createLogger, isDebugEnabled } from '../logger'

const log = createLogger('server', 'server.ts')

/**
 * The single dispatch core. Both transports (Electron IPC + WebSocket) attach
 * to this server and forward requests through `handle()`. Events flow the
 * other way through `broadcast()` — every transport that has called
 * `subscribe()` for the topic receives the payload.
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

  // Ring buffer per topic for resume; capped at BUFFER_LIMIT events.
  // Used by the WebSocket transport when a client reconnects with a last-seen seq.
  private static readonly BUFFER_LIMIT = 1024

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

  broadcast(topic: RpcTopic, ...payload: unknown[]): void {
    if (isDebugEnabled) log.debug(`Sending payload ${JSON.stringify(payload)} to topic ${topic}`)
    const seq = (this.seqCounters.get(topic) ?? 0) + 1
    this.seqCounters.set(topic, seq)

    const ring = this.buffer.get(topic) ?? []
    ring.push({ seq, payload, timestamp: Date.now() })
    if (ring.length > SolusServer.BUFFER_LIMIT) ring.shift()
    this.buffer.set(topic, ring)

    this.emitter.emit(topic, payload, seq)
  }

  /**
   * Returns events newer than `lastSeq` for the given topic. Used by the
   * WebSocket transport's resume protocol — if the buffer doesn't go back
   * far enough, returns null and the client should perform a full reload.
   */
  replayFrom(topic: RpcTopic, lastSeq: number): BufferedEvent[] | null {
    const ring = this.buffer.get(topic)
    if (!ring || ring.length === 0) return []
    if (ring[0].seq > lastSeq + 1) return null // gap — caller should re-snapshot
    return ring.filter(e => e.seq > lastSeq)
  }

  getSeqWatermark(): Record<string, number> {
    return Object.fromEntries(this.seqCounters.entries())
  }
}

export type Handler = (args: unknown[], ctx: HandlerCtx) => unknown | Promise<unknown>

export interface HandlerCtx {
  /** Identifies the client that issued the call (e.g. "electron", "ws:abcd"). */
  clientId?: string
  /** Web-client device label, set after pairing. */
  deviceLabel?: string
  /**
   * Stable device identifier — persists across reconnects for paired web clients,
   * and is "electron" for the desktop renderer. Used to scope tabs per-device so
   * one device's tabs don't appear on another device's snapshot.
   */
  deviceId?: string
}

export type TopicListener = (payload: unknown[], seq: number) => void

interface BufferedEvent {
  seq: number
  payload: unknown[]
  timestamp: number
}
