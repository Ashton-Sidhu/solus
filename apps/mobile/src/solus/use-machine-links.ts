import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { solus, useSolusWorkspace } from './runtime'

export function useMachineLinks() {
  useSyncExternalStore(solus.connections.machineLinksChanged.subscribe, solus.connections.machineLinksRevision)
  return solus.connections.machineLinks()
}

/** Why the host's links are not shown; null when `useMachineLinks()` has them. */
export function useMachineLinksHidden(hostId: string) {
  useSyncExternalStore(solus.connections.machineLinksChanged.subscribe, solus.connections.machineLinksRevision)
  return solus.connections.machineLinksHidden(hostId)
}

export function refreshMachineLinks(hostId: string): void {
  solus.connections.refreshMachineLinks(hostId)
}

/** Reads the health of the links that these machines hold, every 30 s while the app is in the foreground. */
export function useLinkHealth(installationIds: readonly string[]) {
  const reader = solus.connections.linkHealth
  const health = useSyncExternalStore(reader.changes.subscribe, reader.current)
  const [isActive, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  const key = installationIds.join('\n')
  useEffect(() => {
    if (!isActive || !key) return
    return reader.watch(key.split('\n'))
  }, [reader, isActive, key])
  return health
}

/** Reads the health of the links again now, after a link changed. */
export function readLinkHealth(installationIds: readonly string[]): void {
  void solus.connections.linkHealth.read(installationIds)
}

/** The installation ids of the machines this phone has an environment for. */
export function useKnownMachineIds(): ReadonlySet<string> {
  const { environments } = useSolusWorkspace()
  return useMemo(() => new Set<string>(environments.map(({ environmentId }) => environmentId)), [environments])
}
