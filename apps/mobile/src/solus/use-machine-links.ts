import { useSyncExternalStore } from 'react'
import { solus } from './runtime'

export function useMachineLinks() {
  useSyncExternalStore(solus.connections.machineLinksChanged.subscribe, solus.connections.machineLinksRevision)
  return solus.connections.machineLinks()
}
