import type { RpcMethod } from '@solus/contracts/rpc'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { GoogleUploadDocRequest } from '@solus/contracts/types'
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

  register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): void {
    if (this.handlers.has(method)) {
      throw new Error(`SolusServer: duplicate handler for "${method}"`)
    }
    // SAFETY: The method key and handler share M, so later dispatch supplies that method's exact tuple.
    this.handlers.set(method, handler as Handler)
  }

  handle<M extends RpcMethod>(method: M, args: RpcArgs<M>, ctx?: HandlerCtx): Promise<RpcResult<M>>
  async handle(method: RpcMethod, args: RpcInvocationArgs, ctx?: HandlerCtx): Promise<RpcInvocationResult> {
    if (isDebugEnabled) {
      if (method === 'googleUploadDoc') {
        // SAFETY: Runtime dispatch pairs this literal method with SolusAPI.googleUploadDoc's request tuple.
        const request = args[0] as GoogleUploadDocRequest
        log.debug('rpc_method_invoked', {
          method,
          title: request.title,
          markdownLength: request.markdown.length,
          diagramAssets: request.diagramAssets?.map((asset) => ({
            workId: asset.workId,
            title: asset.title,
            mimeType: asset.mimeType,
            base64Length: asset.base64.length,
          })),
        })
      } else {
        log.debug('rpc_method_invoked', { method, args })
      }
    }
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`SolusServer: no handler for "${method}"`)
    return await handler(args, ctx ?? {})
  }

  hasHandler(method: string): method is RpcMethod {
    // SAFETY: The map contains every accepted RPC method and rejects all other strings.
    return this.handlers.has(method as RpcMethod)
  }

}

type RpcApiMethod<M extends RpcMethod> = M extends keyof SolusAPI ? SolusAPI[M] : never
export type RpcArgs<M extends RpcMethod> = RpcApiMethod<M> extends (...args: infer Args) => Promise<infer _Result>
  ? Args
  : never
export type RpcResult<M extends RpcMethod> = RpcApiMethod<M> extends (...args: infer _Args) => Promise<infer Result>
  ? Result
  : never
type RpcArgsByMethod = { [M in RpcMethod]: RpcArgs<M> }
type RpcResultByMethod = { [M in RpcMethod]: RpcResult<M> }
export type RpcInvocationArgs = RpcArgsByMethod[RpcMethod]
export type RpcInvocationResult = RpcResultByMethod[RpcMethod]
export type Handler = (
  args: RpcInvocationArgs,
  ctx: HandlerCtx,
) => RpcInvocationResult | Promise<RpcInvocationResult>
export type RpcHandler<M extends RpcMethod> = (
  args: RpcArgs<M>,
  ctx: HandlerCtx,
) => RpcResult<M> | Promise<RpcResult<M>>

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
