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
  /**
   * WebSocket client ids currently connected, tracked via the presence topic the
   * WS transport already broadcasts on connect/disconnect. The resume ring buffer
   * only exists for WS reconnects, so with zero web clients we skip appending to
   * it entirely (the Electron transport pushes live and never replays), keeping it
   * from pinning tens of MB of payloads.
   */
  private wsClientIds = new Set<string>()

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

    if (topic === 'presence') this._trackPresence(payload)

    // Only retain events for resume while a WS client is connected; the seq
    // counter keeps advancing so a reconnecting client past the gap re-snapshots.
    if (this.wsClientIds.size > 0) {
      const ring = this.buffer.get(topic) ?? []
      ring.push({ seq, payload, timestamp: Date.now() })
      if (ring.length > SolusServer.BUFFER_LIMIT) ring.shift()
      this.buffer.set(topic, ring)
    }

    this.emitter.emit(topic, payload, seq)
  }

  /** Maintain the connected-WS-client set from the presence stream. */
  private _trackPresence(payload: unknown[]): void {
    const evt = payload[0] as { type?: string; id?: string } | undefined
    if (!evt || typeof evt.id !== 'string') return
    if (evt.type === 'connect') {
      this.wsClientIds.add(evt.id)
    } else if (evt.type === 'disconnect') {
      this.wsClientIds.delete(evt.id)
      // Last client gone — drop retained events so idle memory stays flat.
      if (this.wsClientIds.size === 0) this.buffer.clear()
    }
  }

  /**
   * Returns events newer than `lastSeq` for the given topic. Used by the
   * WebSocket transport's resume protocol — if the buffer doesn't go back
   * far enough, returns null and the client should perform a full reload.
   */
  replayFrom(topic: RpcTopic, lastSeq: number): BufferedEvent[] | null {
    const currentSeq = this.seqCounters.get(topic) ?? 0
    if (currentSeq <= lastSeq) return [] // client already caught up
    const ring = this.buffer.get(topic)
    // Behind, but nothing retained (buffer cleared while no clients, or never
    // populated past the gap) — force a re-snapshot rather than silently skipping.
    if (!ring || ring.length === 0) return null
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
