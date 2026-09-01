import type { RpcMethod } from '../../shared/rpc'
import { createLogger, isDebugEnabled } from '../logger'

const log = createLogger('server', 'server.ts')

export const LOCAL_DEVICE_LABEL = 'This Mac'

/**
 * The single dispatch core. The WebSocket transport forwards requests through
 * The server is transport-agnostic: it doesn't know about IPC channels,
 * BrowserWindow, or sockets. Transports are thin shims that translate
 * their wire format into method+args.
 */
export class SolusServer {
  private handlers = new Map<RpcMethod, Handler>()

  register<M extends RpcMethod>(method: M, handler: Handler): void {
    if (this.handlers.has(method)) {
      throw new Error(`SolusServer: duplicate handler for "${method}"`)
    }
    this.handlers.set(method, handler)
  }

  async handle(method: RpcMethod, args: unknown[], ctx?: HandlerCtx): Promise<unknown> {
    if (isDebugEnabled) log.debug('rpc_method_invoked', { method, args })
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`SolusServer: no handler for "${method}"`)
    return await handler(args, ctx ?? {})
  }

  hasHandler(method: string): method is RpcMethod {
    return this.handlers.has(method as RpcMethod)
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
