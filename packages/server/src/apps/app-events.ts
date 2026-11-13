import type { AppActivityEvent, AppActivityKind, AppsChangedEvent } from '@solus/contracts/apps'
import { createLogger } from '../logger'

const log = createLogger('apps', 'app-events.ts')

/**
 * The app events a server broadcasts (docs/plans/apps.md §5): `apps.changed`
 * when an app is deployed, changed, stopped, started, or deleted, and
 * `apps.dataChanged` when a mutation changed an app's data, and
 * `apps.activity` when its call log, its runs, its occurrences, or its files
 * changed. A schedule or a webhook changes an app with no client in the loop,
 * so push is how an open UI learns of it.
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

// ─── Activity ───

const ACTIVITY_WAIT_MS = 500
const activityListeners = new Set<Listener<AppActivityEvent>>()
/** The kinds that wait for each app's next event. */
const waitingActivity = new Map<string, Set<AppActivityKind>>()
let activityTimer: ReturnType<typeof setTimeout> | null = null

export function onAppActivity(listener: Listener<AppActivityEvent>): () => void {
  activityListeners.add(listener)
  return () => activityListeners.delete(listener)
}

/**
 * Says that an app's activity changed. A busy app makes many calls, and a
 * Manage page only reads a list again, so the host sends at most one event
 * for each app in `ACTIVITY_WAIT_MS`, with every kind that changed.
 */
export function emitAppActivity(appId: string, kind: AppActivityKind): void {
  const kinds = waitingActivity.get(appId) ?? new Set<AppActivityKind>()
  kinds.add(kind)
  waitingActivity.set(appId, kinds)
  if (activityTimer) return
  activityTimer = setTimeout(() => {
    activityTimer = null
    const waiting = [...waitingActivity]
    waitingActivity.clear()
    for (const [id, changed] of waiting) notify(activityListeners, { appId: id, kinds: [...changed] }, 'apps.activity')
  }, ACTIVITY_WAIT_MS)
  activityTimer.unref?.()
}
