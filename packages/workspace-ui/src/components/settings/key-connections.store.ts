import { KeyConnectionStore } from '@solus/client-core/key-connection-store'
import { serverConnections } from '@solus/client-core/server-connections'
import type { VaultKeyRef } from '@solus/contracts/vault-keys'
import { accountStore } from '../../contexts/account/account.store.svelte'
import { accountAgentProfileRequests } from '../../contexts/account/account-sync.store.svelte'

const connections = new Map<string, KeyConnectionStore>()

/** Settings owns this cache; reading it does not start a request. */
export function keyConnectionFor(serverId: string, ref: VaultKeyRef): KeyConnectionStore {
  const cacheKey = `${serverId}:${ref.kind === 'provider' ? ref.provider : ref.kind}`
  let connection = connections.get(cacheKey)
  if (!connection) {
    connection = new KeyConnectionStore(ref, {
      host: () => serverConnections.apiFor(serverId),
      account: () => accountStore.isSignedIn ? accountAgentProfileRequests() : null,
      identity: () => {
        const state = accountStore.state
        return state.kind === 'signed-in' ? `${state.consoleUrl}:${state.identity.sub}` : state.kind
      }
    })
    connections.set(cacheKey, connection)
  }
  return connection
}
