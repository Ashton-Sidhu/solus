import type { HandlerCtx } from '@solus/server/transport/server'
import { actorFor } from '@solus/server/admission/actor'

/**
 * Every RPC dispatch names its principal (docs/plans/personal-uplink.md, P1). A test
 * that drives handlers in-process stands in for the desktop renderer, the local owner
 * with no paired device — the caller every method is open to. `SolusServer.handle()`
 * resolves the actor; a test that calls a handler directly carries it here.
 */
const LOCAL_OWNER = { kind: 'local-owner', deviceId: null, deviceLabel: 'Test' } as const

export const TEST_HANDLER_CTX: HandlerCtx = { clientId: 'test', principal: LOCAL_OWNER, actor: actorFor(LOCAL_OWNER) }

export function localOwnerCtx(clientId: string): HandlerCtx {
  return { clientId, principal: LOCAL_OWNER, actor: actorFor(LOCAL_OWNER) }
}
