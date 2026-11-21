import { useCallback, useEffect, useState } from 'react'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { shownBackgroundRecords } from '@solus/client-core/background-item'
import { RESOURCE_WATCHES } from '@solus/client-core/resource-watch-row'
import { useApp, useListened } from '../../app/app-context'

export interface ResourceWatchesView {
  /** The live resource watches, and those that ended since the newest turn started. */
  readonly watches: readonly ResourceWatch[]
  readonly stop: (watch: ResourceWatch) => Promise<void>
}

/**
 * A thread's resource watches (docs/plans/mcp-first-class.md §11.5), as
 * desktop's `resourceWatchesStore` reads them: the list when the host is ready,
 * then each `integration.resourceWatchChanged`. A host that is not ready shows
 * none. Mobile keeps no turn start times, so an ended row shows until the next
 * turn starts here (`turnActive`), as `useMcpTasks` does.
 */
export function useResourceWatches(hostId: string, sessionId: string, turnActive: boolean): ResourceWatchesView {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [watches, setWatches] = useState<readonly ResourceWatch[]>([])
  const [since, setSince] = useState(() => Date.now())
  useEffect(() => {
    if (turnActive) setSince(Date.now())
  }, [turnActive])
  useEffect(() => {
    const connection = app.connections.connection(hostId)
    setWatches([])
    if (readiness !== 'ready' || !connection) return
    let current = true
    // An older host has no such method: no row.
    void connection.api.integrationResourceWatchList({ sessionId }).then((list) => { if (current) setWatches(list) }, () => undefined)
    const stop = connection.events.subscribe('integration.resourceWatchChanged', (event) => {
      if (event.sessionId !== sessionId) return
      setWatches((list) => {
        const index = list.findIndex((entry) => entry.id === event.watch.id)
        return index === -1 ? [...list, event.watch] : list.with(index, event.watch)
      })
    })
    return () => {
      current = false
      stop()
    }
  }, [app, hostId, readiness, sessionId])
  const stop = useCallback(async (watch: ResourceWatch) => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('This host is not connected.')
    await connection.api.integrationResourceWatchStop({ sessionId: watch.sessionId, id: watch.id })
  }, [app, hostId])
  return { watches: shownBackgroundRecords(RESOURCE_WATCHES, watches, since), stop }
}
