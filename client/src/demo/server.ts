import type { RpcInvokeMethod, RpcTopic } from '../../../src/shared/rpc'
import type { DemoServer } from './fixtures/types'

type RpcHandler = (args: unknown[]) => unknown | Promise<unknown>
type TopicListener = (...payload: unknown[]) => void

export class DemoBackend implements DemoServer {
  private handlers = new Map<RpcInvokeMethod, RpcHandler>()
  private listeners = new Map<RpcTopic, Set<TopicListener>>()

  register(method: RpcInvokeMethod, fn: RpcHandler): void {
    this.handlers.set(method, fn)
  }

  async handle(method: RpcInvokeMethod, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(method)
    if (handler) return handler(args)
    if (import.meta.env.DEV) console.warn(`[demo] unhandled RPC: ${method}`)
    return null
  }

  subscribe(topic: RpcTopic, listener: TopicListener): () => void {
    let listeners = this.listeners.get(topic)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(topic, listeners)
    }
    listeners.add(listener)
    return () => listeners?.delete(listener)
  }

  broadcast(topic: RpcTopic, ...payload: unknown[]): void {
    const listeners = this.listeners.get(topic)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(...payload)
      } catch (error) {
        console.error('[demo] listener threw', error)
      }
    }
  }
}
