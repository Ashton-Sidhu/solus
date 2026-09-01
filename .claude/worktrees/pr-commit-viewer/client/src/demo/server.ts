import type { RpcInvokeMethod } from '../../../src/shared/rpc'
import type { HostEventMap, HostEventName } from '../../../src/shared/host-events'
import { HostEventSubscriber } from '../../../src/client-core/host-event-subscriber'
import type { DemoServer } from './fixtures/types'

type RpcHandler = (args: unknown[]) => unknown | Promise<unknown>
export class DemoBackend implements DemoServer {
  readonly events = new HostEventSubscriber()
  private handlers = new Map<RpcInvokeMethod, RpcHandler>()

  register(method: RpcInvokeMethod, fn: RpcHandler): void {
    this.handlers.set(method, fn)
  }

  async handle(method: RpcInvokeMethod, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(method)
    if (handler) return handler(args)
    if (import.meta.env.DEV) console.warn(`[demo] unhandled RPC: ${method}`)
    return null
  }

  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): void {
    this.events.receive({ type, payload, occurredAt: Date.now() })
  }
}
