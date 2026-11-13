import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage, isUnsupportedMethodError } from '../settings/integrations'
import { sortApps, type AppListState } from './apps'

/** The apps of one host, as the Apps list shows the host. */
export interface HostApps {
  readonly hostId: string
  readonly label: string
  readonly connected: boolean
  readonly list: AppListState
}

const LOADING: AppListState = { kind: 'loading' }

/**
 * The apps of one host, or of every host this device knows when `onlyHostId`
 * is null (docs/plans/apps.md §9). Each connected host is read on connect, on
 * focus, and when it says `apps.changed`. A host that is not connected is not
 * read, and its old rows do not show. A reply that arrives after a newer
 * request, or from a connection that has gone, is dropped.
 */
export function useApps(onlyHostId: string | null) {
  const app = useApp()
  const knownHosts = useListened(app.registry.changes, app.registry.hosts)
  const hostIds = onlyHostId ? [onlyHostId] : knownHosts.map((host) => host.id)
  const hostIdsKey = hostIds.join('\n')
  /** The connected hosts as one text, so a change of any other host changes nothing here. */
  const connectedKey = useListened(app.connections.changes, () =>
    hostIdsKey.split('\n').filter((hostId) => hostId && app.connections.state(hostId)?.readiness === 'ready').join('\n'),
  )
  const [lists, setLists] = useState<ReadonlyMap<string, AppListState>>(() => new Map())
  /** The newest request of each host; an older answer does not land. */
  const requests = useRef(new Map<string, number>())

  const reloadHost = useCallback((hostId: string) => {
    const current = app.connections.connection(hostId)
    if (!current) return
    const read = (requests.current.get(hostId) ?? 0) + 1
    requests.current.set(hostId, read)
    const land = (list: AppListState) => {
      if (requests.current.get(hostId) !== read || app.connections.connection(hostId) !== current) return
      setLists((previous) => new Map(previous).set(hostId, list))
    }
    setLists((previous) => (previous.get(hostId)?.kind === 'loaded' ? previous : new Map(previous).set(hostId, LOADING)))
    current.api.appList().then(
      (apps) => land({ kind: 'loaded', apps: sortApps(apps) }),
      (cause: unknown) => {
        const message = errorMessage(cause)
        land(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
      },
    )
  }, [app])

  const reload = useCallback(() => {
    for (const hostId of connectedKey.split('\n')) if (hostId) reloadHost(hostId)
  }, [connectedKey, reloadHost])

  useEffect(reload, [reload])

  useFocusEffect(reload)

  useEffect(() => {
    const stops = connectedKey.split('\n').filter(Boolean).map((hostId) =>
      // The summary of a list row holds what the host counts (the last call, what needs the owner), so the list is read again.
      app.connections.connection(hostId)?.events.subscribe('apps.changed', () => reloadHost(hostId)),
    )
    return () => {
      for (const stop of stops) stop?.()
    }
  }, [app, connectedKey, reloadHost])

  const connected = new Set(connectedKey.split('\n'))
  const hosts = hostIds.map((hostId): HostApps => ({
    hostId,
    label: knownHosts.find((host) => host.id === hostId)?.label ?? 'This host',
    connected: connected.has(hostId),
    list: lists.get(hostId) ?? LOADING,
  }))
  return { hosts, reload }
}
