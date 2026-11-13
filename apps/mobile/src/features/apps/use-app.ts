import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { AppHostCall } from '@solus/client-core/app-files'
import type { HostApi } from '@solus/client-core/host-api'
import type { AppDeployReceipt, AppState } from '@solus/contracts/apps'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage } from '../settings/integrations'
import { eventChangesRead, type AppEvent, type AppReadName } from './app-events'

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
 * Calls `listener` for each `apps.changed`, `apps.dataChanged`, and
 * `apps.activity` event of one app while its host is connected. `appId` is
 * the id or the slug the screen was opened with; `recordId` is the app's id
 * once it is read.
 */
function useAppEvents(
  hostId: string,
  appId: string,
  recordId: string | null,
  connected: boolean,
  listener: (event: AppEvent) => void,
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
        if (names(event.appId)) latest.current({ kind: 'deleted' })
      } else if (names(event.app.id) || event.app.slug === appId) {
        latest.current({ kind: 'changed' })
      }
    })
    const stopData = current.events.subscribe('apps.dataChanged', (event) => {
      if (names(event.appId)) latest.current({ kind: 'data-changed' })
    })
    const stopActivity = current.events.subscribe('apps.activity', (event) => {
      if (names(event.appId)) latest.current({ kind: 'activity', kinds: event.kinds })
    })
    return () => {
      stopChanged()
      stopData()
      stopActivity()
    }
  }, [app, hostId, appId, recordId, connected])
}

/**
 * One app as its host has it (docs/plans/apps.md §9): read on connect, on
 * focus, and when the host says the app changed. With `followsActivity` it is
 * also read when the app's activity changes what its state counts, as the
 * Manage screens need; the app's own screen does not, so a call of its UI is
 * not one more read. `onEvent` also hears each event, so a screen can refresh
 * what it holds beside the app's state. A deleted app is `isDeleted` until
 * the host saves an app with its id again.
 */
export function useAppState(
  hostId: string,
  appId: string,
  options: { readonly followsActivity?: boolean; readonly onEvent?: (event: AppEvent) => void } = {},
) {
  const read = useCallback((api: HostApi): Promise<AppState> => api.appRead({ appId }), [appId])
  const { state, connected, reload } = useHostRead(hostId, read)
  const [isDeleted, setDeleted] = useState(false)

  useFocusEffect(reload)

  useAppEvents(hostId, appId, state.kind === 'loaded' ? state.value.app.id : null, connected, (event) => {
    if (event.kind === 'deleted') {
      setDeleted(true)
      return
    }
    if (event.kind === 'changed') setDeleted(false)
    if (event.kind === 'changed' || (options.followsActivity && eventChangesRead(event, 'state'))) reload()
    options.onEvent?.(event)
  })

  return { state, connected, isDeleted, reload }
}

/**
 * One read of an app for a Manage screen: done on connect, on focus, when
 * the app changed, and when `apps.activity` names what the read shows
 * (`APP_READ_ACTIVITY`). `appId` is the app's id on its host. `read` must
 * keep its identity between renders.
 */
export function useAppRead<T>(hostId: string, appId: string, name: AppReadName, read: (api: HostApi) => Promise<T>) {
  const { state, connected, reload } = useHostRead(hostId, read)

  useFocusEffect(reload)

  useAppEvents(hostId, appId, null, connected, (event) => {
    if (eventChangesRead(event, name)) reload()
  })

  return { state, connected, reload }
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

/**
 * `appCall` bound to one app: what a UI's call, an app file, and a run of an
 * operation from the Manage screens go through. A call for a host that is
 * not connected is refused with words the person reads.
 */
export function useAppHostCall(hostId: string, appId: string): AppHostCall {
  const app = useApp()
  return useCallback(
    (name, argumentsJson) => {
      const current = app.connections.connection(hostId)
      if (!current) return Promise.reject(new Error("This app's host is not connected."))
      return current.api.appCall({ appId, name, argumentsJson })
    },
    [app, hostId, appId],
  )
}

/**
 * Deploys one revision of an app. A deploy answers only when the build
 * ended, so it does not hold the screen and is not one of `useAppChange`'s
 * changes: `deploying` names the revision, and the host says `apps.changed`
 * when the version starts to build, so the Versions section shows it.
 */
export function useAppDeploy(hostId: string, appId: string) {
  const app = useApp()
  const [deploying, setDeploying] = useState<string | null>(null)
  /** The same revision as `deploying`, read at once, so a second tap starts no second build. */
  const deployingRef = useRef<string | null>(null)

  const deploy = async (commit: string): Promise<AppDeployReceipt> => {
    const current = app.connections.connection(hostId)
    if (!current || app.connections.state(hostId)?.readiness !== 'ready') throw new Error('This host cannot be reached now.')
    if (deployingRef.current) throw new Error('A deploy is in progress.')
    deployingRef.current = commit
    setDeploying(commit)
    return await (async () => current.api.appDeploy({ appId, commit }))().finally(() => {
      deployingRef.current = null
      setDeploying(null)
    })
  }

  return { deploying, deploy }
}
