import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { DemoRpcResult, DemoServer, RpcHandler } from './fixtures/types'

export class DemoBackend implements DemoServer {
  readonly events = new HostEventSubscriber()
  private handlers = new Map<RpcInvokeMethod, RpcHandler>()

  register(method: RpcInvokeMethod, fn: RpcHandler): void {
    this.handlers.set(method, fn)
  }

  async handle(method: RpcInvokeMethod, args: unknown[]): Promise<DemoRpcResult> {
    const handler = this.handlers.get(method)
    if (handler) return handler(args)
    // The demo answers a deliberate subset of the RPC surface, so an unanswered
    // method returning null is the design, not a fault. Keep the diagnostic for
    // whoever runs the demo standalone and keep it out of the console of every
    // visitor to the landing page — `import.meta.env.DEV` cannot carry that
    // split, because the shipped demo bundle is built with it set.
    if (window.self === window.top) console.warn(`[demo] unhandled RPC: ${method}`)
    return null
  }

  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): void {
    this.events.receive({ type, payload, occurredAt: Date.now() })
  }
}
