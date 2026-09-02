import type { RpcMethod } from '@solus/contracts/rpc'
import type { Principal, PrincipalKind } from './principal'

/**
 * The one access rule of a single-owner host (docs/plans/personal-uplink.md, P2):
 * methods that change how the host is reached, or drive its window, must come from a
 * trusted local connection. A grant proves the owner's identity, not their presence
 * at the machine, and a compromised account must not be able to open the host wider.
 * The exhaustive read/write/admin map arrives with organizations.
 */
export const LOCAL_ONLY_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // Window and shortcut control
  'isVisible',
  'switchMode',
  'getAppGlobalShortcuts',
  'setAppGlobalShortcuts',
  'restartApp',
  // How the host is reached
  'connectionsSetRemoteAccess',
  'connectionsSetTrustLocalNetwork',
  'connectionsGeneratePairToken',
  'connectionsBootstrapDiscoveredServer',
  // The cloud link itself (its status is a read, open to any owner)
  'uplinkLink',
  'uplinkUnlink',
])

export class RpcAccessError extends Error {
  readonly code = 'FORBIDDEN' as const

  constructor(readonly method: RpcMethod, readonly principalKind: PrincipalKind) {
    super(`"${method}" is only available to a local connection`)
    this.name = 'RpcAccessError'
  }
}

export function assertRpcAccess(method: RpcMethod, principal: Principal): void {
  if (LOCAL_ONLY_RPC_METHODS.has(method) && principal.kind !== 'local-owner') {
    throw new RpcAccessError(method, principal.kind)
  }
}
