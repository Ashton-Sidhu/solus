import { useSyncExternalStore } from 'react'
import { solus } from './runtime'

/** The hosts this phone owns, with the machines each one paired (docs/host-pairing.md). */
export function usePairingHolders() {
  useSyncExternalStore(solus.connections.pairingsChanged.subscribe, solus.connections.pairingsRevision)
  return solus.connections.pairingHolders()
}
