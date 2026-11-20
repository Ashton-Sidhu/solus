import { tasksStoreFor } from './tasks-store'
import { useCallback, useSyncExternalStore } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useApp } from '../../app/app-context'
import { useAppForeground } from '../../lib/appState'
import type { TaskInvolvement } from '@solus/contracts/task-data'

export function useTasks(hostId: string, query = '', involvement: TaskInvolvement = 'all') {
  const app = useApp(),
    store = tasksStoreFor(app, hostId),
    foreground = useAppForeground()
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.current,
    () => store.current
  )
  useFocusEffect(
    useCallback(() => {
      if (!foreground) return
      let lastSession = ''
      let reloadTimer: ReturnType<typeof setTimeout> | undefined
      const load = () => {
        void store.load(false, query, involvement)
      }
      const timer = setTimeout(load, 250)
      const interval = setInterval(load, 5 * 60_000)
      let stops: Array<() => void> = []
      const reloadSoon = () => {
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(load, 100)
      }
      const subscribe = () => {
        const status = app.connections.state(hostId)
        const session = `${status?.readiness}:${status?.sessionGeneration}`
        if (session === lastSession) return
        const isReconnect = lastSession !== ''
        lastSession = session
        for (const stop of stops) stop()
        const connection = app.connections.connection(hostId)
        stops = connection
          ? [
              connection.events.subscribe('tasks.sourcesChanged', reloadSoon),
              connection.events.subscribe('tasks.invalidated', reloadSoon)
            ]
          : []
        if (isReconnect) reloadSoon()
      }
      subscribe()
      const stopConnection = app.connections.changes.subscribe(subscribe)
      const stopSettings = app.personal.changes.subscribe(load)
      return () => {
        clearTimeout(timer)
        clearTimeout(reloadTimer)
        clearInterval(interval)
        stopConnection()
        stopSettings()
        for (const stop of stops) stop()
      }
    }, [app, store, hostId, query, involvement, foreground])
  )
  return { store, state }
}
