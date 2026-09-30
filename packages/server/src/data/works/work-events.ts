import type { HostEventMap } from '@solus/contracts/host-events'
import { afterDatabaseCommit } from '../../db/database'
import { createLogger } from '../../logger'

const log = createLogger('folio', 'work-events.ts')

export type WorkChange = HostEventMap['works.changed']

type WorksChangedListener = (change: WorkChange) => void
const listeners = new Set<WorksChangedListener>()
/** Decides who hears a delete while they can still be found, and answers the
 * send, which counts the clients it reached. */
type WorkDeletedListener = (change: WorkChange) => Promise<() => Promise<number>>
const deletedListeners = new Set<WorkDeletedListener>()

/** Subscribe to every committed work write, from any caller: an API request,
 * an RPC, an outbox op, or an upstream pull. */
export function onWorksChanged(listener: WorksChangedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribe to every committed delete of a work through the API. */
export function onWorkDeleted(listener: WorkDeletedListener): () => void {
  deletedListeners.add(listener)
  return () => deletedListeners.delete(listener)
}

/**
 * Announce a person's delete of a work. Call it inside the delete's
 * transaction, before the work and its grants are removed: each listener
 * decides its audience now, from the grants that still exist, and sends only
 * after the outermost transaction commits, never when it rolls back.
 */
export async function announceWorkDeleted(change: Omit<WorkChange, 'deleted'>): Promise<void> {
  const deleted: WorkChange = { ...change, deleted: true }
  const sends = await Promise.all([...deletedListeners].map(async (listener) => {
    try {
      return await listener(deleted)
    } catch (error) {
      log.error('work_deleted_listener_failed', { workId: change.workId, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }))
  await afterDatabaseCommit(async () => {
    await Promise.all(sends.map((send) => send?.()))
  })
}

/**
 * Announce one work's write. Call it inside the write's transaction: the
 * listeners run after the outermost transaction commits, and never when it
 * rolls back (`afterDatabaseCommit`).
 */
export function emitWorkChanged(change: WorkChange): void {
  void afterDatabaseCommit(async () => {
    for (const listener of listeners) {
      try {
        listener(change)
      } catch (error) {
        log.error('works_changed_listener_failed', { workId: change.workId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}
