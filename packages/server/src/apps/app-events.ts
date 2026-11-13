import type { AppsChangedEvent } from '@solus/contracts/apps'
import { createLogger } from '../logger'

const log = createLogger('apps', 'app-events.ts')

/**
 * The app events a server broadcasts (docs/plans/apps.md §5): `apps.changed`
 * when an app is deployed, changed, stopped, started, or deleted, and
 * `apps.dataChanged` when a mutation changed an app's data. A schedule or a
 * webhook changes an app with no client in the loop, so push is how an open
 * UI learns of it.
 */

type Listener<T> = (event: T) => void

const changedListeners = new Set<Listener<AppsChangedEvent>>()
const dataListeners = new Set<Listener<{ appId: string }>>()

function notify<T>(listeners: Set<Listener<T>>, event: T, name: string): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      log.error('app_listener_failed', { event: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export function onAppsChanged(listener: Listener<AppsChangedEvent>): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

export function emitAppsChanged(event: AppsChangedEvent): void {
  notify(changedListeners, event, 'apps.changed')
}

export function onAppDataChanged(listener: Listener<{ appId: string }>): () => void {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}

export function emitAppDataChanged(appId: string): void {
  notify(dataListeners, { appId }, 'apps.dataChanged')
}
