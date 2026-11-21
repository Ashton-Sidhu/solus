import { HostProjectLists, type HostListsSource, type HostProjectListsOptions, type KeptList } from '@solus/client-core/host-project-lists'
import { useEffect } from 'react'
import { useListened } from '../../app/app-context'
import type { SolusApp } from '../../app/solus-app'
import { Listeners } from '../../lib/listeners'

/** The client-core `HostProjectLists` on this phone's hosts, with the `Listeners` a screen reads it through. */
export interface PhoneHostProjectLists<T> {
  readonly lists: HostProjectLists<T>
  readonly changes: Listeners
}

/**
 * This phone's hosts as the lists reach them: a host's connection while it is
 * ready, its reconnects (a new connection, or a reset of the server session,
 * which loses the events sent while away), and its removal.
 */
function phoneSource(app: SolusApp): HostListsSource {
  const readyConnection = (hostId: string) => (app.connections.state(hostId)?.readiness === 'ready' ? app.connections.connection(hostId) : null)
  return {
    connection: readyConnection,
    watchReconnects: (hostId, reconnected) => {
      let seen = readyConnection(hostId)
      let stopReset = seen?.onReset(reconnected)
      const stopChanges = app.connections.changes.subscribe(() => {
        const current = readyConnection(hostId)
        if (current === seen) return
        seen = current
        stopReset?.()
        stopReset = current?.onReset(reconnected)
        if (current) reconnected()
      })
      return () => { stopChanges(); stopReset?.() }
    },
    onForgotten: (forgotten) => app.registry.onHostRemoved(forgotten),
  }
}

/** One set of lists for each app, so every sheet of a kind shares them. */
export function phoneHostProjectLists<T>(kept: WeakMap<SolusApp, PhoneHostProjectLists<T>>, app: SolusApp, options: HostProjectListsOptions<T>): PhoneHostProjectLists<T> {
  const known = kept.get(app)
  if (known) return known
  const changes = new Listeners()
  const lists = new HostProjectLists<T>({ ...options, source: phoneSource(app), map: () => new Map(), onChange: () => changes.notify() })
  const created = { lists, changes }
  kept.set(app, created)
  return created
}

/** The kept list of one host and project; read when a sheet first asks, or again after its first read failed. */
export function useHostProjectList<T>({ lists, changes }: PhoneHostProjectLists<T>, hostId: string, projectPath: string): KeptList<T> | undefined {
  useEffect(() => { lists.ensure(hostId, projectPath) }, [lists, hostId, projectPath])
  return useListened(changes, () => lists.keptFor(hostId, projectPath))
}
