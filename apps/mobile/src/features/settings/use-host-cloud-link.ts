import { useCallback, useEffect } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'

/** A host's Solus Cloud registration and link for a settings screen: read on
 *  connect and on focus; a refused registration, link, or unlink says why. */
export function useHostCloudLink(hostId: string) {
  const app = useApp()
  const state = useListened(app.hostCloudLink.changes, () => app.hostCloudLink.stateOf(hostId))
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const reload = useCallback(() => { void app.hostCloudLink.load(hostId) }, [app, hostId])

  useEffect(() => {
    if (readiness === 'ready') reload()
  }, [readiness, reload])

  useFocusEffect(reload)

  const report = (title: string) => (cause: unknown) => {
    Alert.alert(title, cause instanceof Error ? cause.message : String(cause))
  }
  const register = () => { void app.hostCloudLink.register(hostId).catch(report('Not registered')) }
  const setLinked = (isLinked: boolean) => {
    const change = isLinked ? app.hostCloudLink.link(hostId) : app.hostCloudLink.unlink(hostId)
    void change.catch(report(isLinked ? 'Not reachable from the internet' : 'Still reachable from the internet'))
  }

  return { state, register, setLinked }
}
