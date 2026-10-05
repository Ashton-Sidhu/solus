import { useCallback, useEffect } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'
import type { HostConfigPatch } from '@solus/contracts/host-config'

/** A host's own settings for a settings screen: read on connect and on focus,
 *  and changed with one patch of host-owned keys; a refused change says so. */
export function useHostSettings(hostId: string) {
  const app = useApp()
  const state = useListened(app.hostSettings.changes, () => app.hostSettings.stateOf(hostId))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const reload = useCallback(() => { void app.hostSettings.load(hostId) }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') reload()
  }, [phase, reload])

  useFocusEffect(reload)

  const update = (patch: HostConfigPatch) => {
    void app.hostSettings.update(hostId, patch).catch((cause: unknown) => {
      Alert.alert('Not changed', cause instanceof Error ? cause.message : String(cause))
    })
  }

  return { state, reload, update }
}
