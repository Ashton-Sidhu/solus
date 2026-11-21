import { useCallback, useEffect, useState } from 'react'
import {
  shownBackgroundRecords,
  upsertById,
  type BackgroundKind,
  type BackgroundRecord,
  type SessionRecordTopic,
} from '@solus/client-core/background-item'
import type { HostApi } from '@solus/client-core/host-api'
import { useApp, useListened } from '../../app/app-context'

export interface SessionHostRecordsView<T> {
  /** The live records, and those that ended since the newest turn started. */
  readonly records: readonly T[]
  /** The api of the host, for a command on one of the records. */
  readonly hostApi: () => HostApi
}

/**
 * A thread's background records of one kind (docs/plans/mcp-first-class.md
 * §11.5, §12.5), as desktop's `SessionHostRecords` reads them: the list when
 * the host is ready, then each change event of the kind. A host that is not
 * ready shows none, so no row keeps a state the host may no longer have.
 * Mobile keeps no turn start times, so an ended row shows until the next turn
 * starts here (`turnActive`). `kind` is a module constant, so the effect does
 * not run again on each render.
 */
export function useSessionHostRecords<T extends BackgroundRecord, Topic extends SessionRecordTopic>(
  hostId: string,
  sessionId: string,
  turnActive: boolean,
  kind: BackgroundKind<T, Topic>,
): SessionHostRecordsView<T> {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [records, setRecords] = useState<readonly T[]>([])
  const [since, setSince] = useState(() => Date.now())
  useEffect(() => {
    if (turnActive) setSince(Date.now())
  }, [turnActive])
  useEffect(() => {
    const connection = app.connections.connection(hostId)
    setRecords([])
    if (readiness !== 'ready' || !connection) return
    let current = true
    // An older host has no such method: no row.
    void kind.list(connection.api, sessionId).then((list) => { if (current) setRecords(list) }, () => undefined)
    const stop = connection.events.subscribe(kind.topic, (event) => {
      if (event.sessionId !== sessionId) return
      setRecords((list) => upsertById(list, kind.recordOf(event)))
    })
    return () => {
      current = false
      stop()
    }
  }, [app, hostId, kind, readiness, sessionId])
  const hostApi = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('This host is not connected.')
    return connection.api
  }, [app, hostId])
  return { records: shownBackgroundRecords(kind, records, since), hostApi }
}
