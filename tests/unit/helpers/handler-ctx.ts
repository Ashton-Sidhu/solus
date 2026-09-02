import type { HandlerCtx } from '@solus/server/server/server'

/**
 * Every RPC dispatch names its principal (docs/plans/personal-uplink.md, P1). A test
 * that drives handlers in-process stands in for the desktop renderer, the local owner
 * with no paired device — the caller every method is open to.
 */
export const TEST_HANDLER_CTX: HandlerCtx = {
  clientId: 'test',
  principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Test' },
}

export function localOwnerCtx(clientId: string): HandlerCtx {
  return { clientId, principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Test' } }
}
