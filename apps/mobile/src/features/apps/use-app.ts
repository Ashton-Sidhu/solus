import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { HostApi } from '@solus/client-core/host-api'
import type { AppState } from '@solus/contracts/apps'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage } from '../settings/integrations'

/** One read from a host. */
export type Loadable<T> =
  | { kind: 'loading' }
  | { kind: 'loaded'; value: T }
  | { kind: 'error'; message: string }

/**
 * One read from a host, done on connect, on reconnect, and when `read`
 * changes. The value stays on screen while a later read runs. A reply that
 * arrives after a newer request, or from a connection that has gone, is
 * dropped. `read` must keep its identity between renders.
 */
export function useHostRead<T>(hostId: string, read: (api: HostApi) => Promise<T>) {
  const app = useApp()
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')
  const [state, setState] = useState<Loadable<T>>({ kind: 'loading' })
  const request = useRef(0)

  const reload = useCallback(() => {
    const current = app.connections.connection(hostId)
    if (!current || app.connections.state(hostId)?.readiness !== 'ready') return
    const id = ++request.current
    const isNewest = () => id === request.current && app.connections.connection(hostId) === current
    setState((previous) => (previous.kind === 'loaded' ? previous : { kind: 'loading' }))
    read(current.api).then(
      (value) => { if (isNewest()) setState({ kind: 'loaded', value }) },
      (cause: unknown) => { if (isNewest()) setState({ kind: 'error', message: errorMessage(cause) }) },
    )
  }, [app, hostId, read])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  return { state, connected, reload }
}

/**
 * Calls `listener` for each `apps.changed` and `apps.dataChanged` event of
 * one app while its host is connected. `appId` is the id or the slug the
 * screen was opened with; `recordId` is the app's id once it is read.
 */
function useAppEvents(
  hostId: string,
  appId: string,
  recordId: string | null,
  connected: boolean,
  listener: (event: 'changed' | 'deleted' | 'data-changed') => void,
) {
  const app = useApp()
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  })
  useEffect(() => {
    const current = connected ? app.connections.connection(hostId) : null
    if (!current) return
    const names = (id: string) => id === recordId || id === appId
    const stopChanged = current.events.subscribe('apps.changed', (event) => {
      if (event.kind === 'deleted') {
        if (names(event.appId)) latest.current('deleted')
      } else if (names(event.app.id) || event.app.slug === appId) {
        latest.current('changed')
      }
    })
    const stopData = current.events.subscribe('apps.dataChanged', (event) => {
      if (names(event.appId)) latest.current('data-changed')
    })
    return () => {
      stopChanged()
      stopData()
    }
  }, [app, hostId, appId, recordId, connected])
}

/**
 * One app as its host has it (docs/plans/apps.md §9): read on connect, on
 * focus, and when the host says the app changed. `onEvent` also hears each
 * event, so a screen can refresh what it holds beside the app's state.
 * A deleted app is `isDeleted` until the host saves an app with its id again.
 */
export function useAppState(hostId: string, appId: string, onEvent?: (event: 'changed' | 'data-changed') => void) {
  const read = useCallback((api: HostApi): Promise<AppState> => api.appRead({ appId }), [appId])
  const { state, connected, reload } = useHostRead(hostId, read)
  const [isDeleted, setDeleted] = useState(false)

  useFocusEffect(reload)

  useAppEvents(hostId, appId, state.kind === 'loaded' ? state.value.app.id : null, connected, (event) => {
    if (event === 'deleted') {
      setDeleted(true)
      return
    }
    if (event === 'changed') {
      setDeleted(false)
      reload()
    }
    onEvent?.(event)
  })

  return { state, connected, isDeleted, reload }
}

/**
 * Runs one change of an app at a time. A refused change throws, and the
 * screen says why. The host says `apps.changed` after a change, so each
 * screen that shows the app reads it again; nothing is kept here.
 */
export function useAppChange(hostId: string) {
  const app = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  /** The same change as `busy`, read at once, so a second tap waits for the first. */
  const busyRef = useRef<string | null>(null)

  const change = async <T,>(name: string, run: (api: HostApi) => Promise<T>): Promise<T> => {
    const current = app.connections.connection(hostId)
    if (!current || app.connections.state(hostId)?.readiness !== 'ready') throw new Error('This host cannot be reached now.')
    if (busyRef.current) throw new Error('Another change is in progress.')
    busyRef.current = name
    setBusy(name)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so finally sees both.
    return await (async () => run(current.api))().finally(() => {
      busyRef.current = null
      setBusy(null)
    })
  }

  return { busy, change }
}

const CALL_LOG_LIMIT = 50

/**
 * What the app's sheet lists beside the app's state: its versions, its
 * schedules, its webhooks, the newest calls of its call log, and the sessions
 * linked to it. `reloadAll` reads every list again; `reloadFor` reads the
 * lists that one event of the app can change.
 */
export function useAppLists(hostId: string, appId: string) {
  const readVersions = useCallback((api: HostApi) => api.appVersions({ appId }), [appId])
  const readSchedules = useCallback((api: HostApi) => api.appSchedules({ appId }), [appId])
  const readWebhooks = useCallback((api: HostApi) => api.appWebhooks({ appId }), [appId])
  const readCalls = useCallback((api: HostApi) => api.appCalls({ appId, limit: CALL_LOG_LIMIT }), [appId])
  const readSessions = useCallback((api: HostApi) => api.appSessions({ appId }), [appId])
  const versions = useHostRead(hostId, readVersions)
  const schedules = useHostRead(hostId, readSchedules)
  const webhooks = useHostRead(hostId, readWebhooks)
  const calls = useHostRead(hostId, readCalls)
  const sessions = useHostRead(hostId, readSessions)
  const reloadVersions = versions.reload
  const reloadSchedules = schedules.reload
  const reloadWebhooks = webhooks.reload
  const reloadCalls = calls.reload
  const reloadSessions = sessions.reload

  const reloadAll = useCallback(() => {
    reloadVersions()
    reloadSchedules()
    reloadWebhooks()
    reloadCalls()
    reloadSessions()
  }, [reloadVersions, reloadSchedules, reloadWebhooks, reloadCalls, reloadSessions])

  /** A deploy changes what the app declares; a mutation adds a call, and may be a run of a schedule. */
  const reloadFor = (event: 'changed' | 'data-changed') => {
    if (event === 'changed') reloadAll()
    else {
      reloadCalls()
      reloadSchedules()
    }
  }

  return { versions: versions.state, schedules: schedules.state, webhooks: webhooks.state, calls: calls.state, sessions: sessions.state, reloadAll, reloadFor }
}
