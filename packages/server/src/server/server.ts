import type { RpcMethod } from '@solus/contracts/rpc'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { PlanPublishRequest, WorkPublishRequest } from '@solus/contracts/docs'
import { createLogger, isDebugEnabled } from '../logger'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { withCredentialScope } from '../vault/credential-scope'
import { assertRpcAccess, type ResourceAccess } from './access-policy'
import { INTERNAL_PRINCIPAL, principalOwnerId, type Principal } from './principal'
import { ALL_ROLES, assertPlaneServed, type SolusRole } from './roles'

const log = createLogger('server', 'server.ts')

export const LOCAL_DEVICE_LABEL = 'This Mac'

/** The host calling itself: capability probes and other in-process dispatch. */
export const INTERNAL_HANDLER_CTX: HandlerCtx = { clientId: 'internal', principal: INTERNAL_PRINCIPAL }

/**
 * The single dispatch core. The WebSocket transport forwards requests through
 * The server is transport-agnostic: it doesn't know about IPC channels,
 * BrowserWindow, or sockets. Transports are thin shims that translate
 * their wire format into method+args.
 */
export class SolusServer {
  private updateTrial = false

  get isVerifyingUpdate(): boolean { return this.updateTrial }

  setUpdateTrial(active: boolean): void { this.updateTrial = active }

  private handlers = new Map<RpcMethod, Handler>()
  private resources: ResourceAccess | undefined
  private roles: ReadonlySet<SolusRole> = ALL_ROLES

  /** Ownership and share lists, once the host has opened its database. */
  useResourceAccess(resources: ResourceAccess): void {
    this.resources = resources
  }

  /** The planes this host serves (`SOLUS_ROLES`); a method outside them is refused. */
  useRoles(roles: ReadonlySet<SolusRole>): void {
    this.roles = roles
  }

  register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): void {
    if (this.handlers.has(method)) {
      throw new Error(`SolusServer: duplicate handler for "${method}"`)
    }
    // SAFETY: The method key and handler share M, so later dispatch supplies that method's exact tuple.
    this.handlers.set(method, handler as Handler)
  }

  handle<M extends RpcMethod>(method: M, args: RpcArgs<M>, ctx: HandlerCtx): Promise<RpcResult<M>>
  async handle(method: RpcMethod, args: RpcInvocationArgs, ctx: HandlerCtx): Promise<RpcInvocationResult> {
    // Fail closed: a call that names no principal is refused before any handler runs.
    if (!ctx?.principal) throw new Error(`SolusServer: "${method}" was called without a principal`)
    // The host calling itself crosses no plane; a client's call must land on one this host serves.
    if (ctx.principal.kind !== 'system') assertPlaneServed(method, this.roles)
    await assertRpcAccess(method, ctx.principal, args, this.resources)
    if (this.updateTrial && method !== 'hostUpdateStatus') throw new Error('Solus is verifying an update. Try again after it restarts.')
    if (isDebugEnabled() && method !== 'activityLease') {
      if (method === 'typeSafeKeySet') {
        log.debug('rpc_method_invoked', { method, clientId: ctx.clientId })
      } else if (method === 'publishWork') {
        // SAFETY: Runtime dispatch pairs this method with publishWork's tuple.
        const request = args[1] as WorkPublishRequest | undefined
        log.debug('rpc_method_invoked', {
          method,
          clientId: ctx.clientId,
          workId: args[0],
          diagrams: request?.diagramAssets?.map((asset) => ({ workId: asset.workId, bytes: asset.base64.length })),
        })
      } else if (method === 'publishPlan') {
        // SAFETY: Runtime dispatch pairs this method with publishPlan's tuple.
        const request = args[0] as PlanPublishRequest
        log.debug('rpc_method_invoked', {
          method,
          clientId: ctx.clientId,
          sessionId: request.sessionId,
          planToolUseId: request.planToolUseId,
          contentLength: request.content.length,
          diagrams: request.diagramAssets?.map((asset) => ({ workId: asset.workId, bytes: asset.base64.length })),
        })
      } else {
        log.debug('rpc_method_invoked', { method, clientId: ctx.clientId, args })
      }
    }
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`SolusServer: no handler for "${method}"`)
    // Whose provider connections the handler acts with (cloud-service-model.md
    // §22): the calling person's, or the host's own for its owner and itself.
    const credentialUserId = principalOwnerId(ctx.principal)
    const run = () => withCredentialScope(credentialUserId === HOST_OWNER_USER_ID ? null : credentialUserId, () => handler(args, ctx))
    if (!isDebugEnabled()) return await run()
    // The part of a handler that runs before its first await is the part that
    // blocks every other request. Debug builds report it when it is long
    // enough to matter, so a slow boot names the handler that held the loop.
    const startedAt = performance.now()
    const pending = run()
    const blockedMs = Math.round(performance.now() - startedAt)
    if (blockedMs >= 20) log.warn('rpc_handler_blocked_loop', { method, clientId: ctx.clientId, blockedMs })
    return await pending
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
  clientId: string
  /** Who is calling. Built at admission; required — see `docs/plans/personal-uplink.md` P1. */
  principal: Principal
  /** Web-client device label, set after pairing. */
  deviceLabel?: string
  /**
   * Stable device identifier from the paired client session token. Used to scope
   * tabs per-device so one device's tabs don't appear on another device's snapshot.
   */
  deviceId?: string
}
