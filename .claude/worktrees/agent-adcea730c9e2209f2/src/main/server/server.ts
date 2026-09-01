import { EventEmitter } from 'events'
import type { RpcMethod, RpcTopic } from '../../shared/rpc'
import { createLogger, isDebugEnabled } from '../logger'

const log = createLogger('server', 'server.ts')

/**
 * The single dispatch core. The WebSocket transport forwards requests through
 * `handle()`. Global events flow through `broadcast()`. Tab-scoped events use
 * `sendTargeted()` so only their owning client receives the payload.
 *
 * The server is transport-agnostic: it doesn't know about IPC channels,
 * BrowserWindow, or sockets. Transports are thin shims that translate
 * their wire format into method+args.
 */
export class SolusServer {
  private handlers = new Map<RpcMethod, Handler>()
  private emitter = new EventEmitter()
  private directClients = new Map<string, DirectTopicListener[]>()

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
    }
  }

  broadcast(topic: RpcTopic, ...payload: unknown[]): void {
    if (isDebugEnabled) log.debug(`Sending payload ${JSON.stringify(payload)} to topic ${topic}`)
    this.emitter.emit(topic, payload)
  }

  sendTo(clientId: string, topic: RpcTopic, ...payload: unknown[]): boolean {
    const listener = this.directClients.get(clientId)?.at(-1)
    if (!listener) return false
    listener(topic, payload)
    return true
  }

  sendTargeted(clientId: string, topic: 'normalized-event' | 'enriched-error', ...payload: unknown[]): boolean {
    const listener = this.directClients.get(clientId)?.at(-1)
    if (!listener) return false
    listener(topic, payload)
    return true
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

export type TopicListener = (payload: unknown[]) => void
export type DirectTopicListener = (topic: RpcTopic, payload: unknown[]) => void
