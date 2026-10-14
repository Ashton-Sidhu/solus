import { useCallback, useEffect } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'

/** A host's Access state for a settings screen: read on connect and on focus;
 *  a change the host refused says why. */
export function useHostAccess(hostId: string) {
  const app = useApp()
  const state = useListened(app.hostAccess.changes, () => app.hostAccess.stateOf(hostId))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const reload = useCallback(() => { void app.hostAccess.load(hostId) }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') reload()
  }, [phase, reload])

  useFocusEffect(reload)

  const report = (cause: unknown) => {
    Alert.alert('Not changed', cause instanceof Error ? cause.message : String(cause))
  }
  const access = app.hostAccess
  return {
    state,
    reload,
    setRemoteAccess: (next: boolean) => { void access.setRemoteAccess(hostId, next).catch(report) },
    setTrustLocalNetwork: (next: boolean) => { void access.setTrustLocalNetwork(hostId, next).catch(report) },
    generatePairCode: () => { void access.generatePairCode(hostId).catch(report) },
    revokeDevice: (deviceId: string) => { void access.revokeDevice(hostId, deviceId).catch(report) },
    setInsightsOptIn: (organizationId: string, next: boolean) => {
      void access.setInsightsOptIn(hostId, organizationId, next).catch(report)
    },
  }
}
