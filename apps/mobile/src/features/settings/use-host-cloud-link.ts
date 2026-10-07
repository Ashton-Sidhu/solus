import { useCallback, useEffect } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'

/** A host's Solus Cloud link for a settings screen: read on connect and on
 *  focus; a refused link or unlink says why. */
export function useHostCloudLink(hostId: string) {
  const app = useApp()
  const state = useListened(app.hostCloudLink.changes, () => app.hostCloudLink.stateOf(hostId))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const reload = useCallback(() => { void app.hostCloudLink.load(hostId) }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') reload()
  }, [phase, reload])

  useFocusEffect(reload)

  const report = (title: string) => (cause: unknown) => {
    Alert.alert(title, cause instanceof Error ? cause.message : String(cause))
  }
  const link = () => { void app.hostCloudLink.link(hostId).catch(report('Not linked')) }
  const unlink = () => { void app.hostCloudLink.unlink(hostId).catch(report('Not unlinked')) }

  return { state, link, unlink }
}
