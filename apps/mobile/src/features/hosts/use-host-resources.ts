import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { EMPTY_HOST_RESOURCE_VIEW, HostResourceWatch } from '@solus/client-core/host-resource-watch'
import { useApp, useListened } from '../../app/app-context'

/** One host's load, as desktop's Resources tab reads it. It runs only while the
 *  screen has focus, so a host does no sampling for a phone that does not look. */
export function useHostResources(hostId: string) {
  const app = useApp()
  const [view, setView] = useState(EMPTY_HOST_RESOURCE_VIEW)
  const ready = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')

  useFocusEffect(useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return undefined
    const watch = new HostResourceWatch({
      api: connection.api,
      events: connection.events,
      mayReadProcesses: () => app.connections.may(hostId, 'host.admin'),
      onChange: setView,
    })
    watch.start()
    return () => watch.stop()
  }, [app, hostId]))

  return { view, ready }
}
