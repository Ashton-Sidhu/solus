import type { Session } from '@solus/contracts/types'
import { createAppContext } from '../app/create-app-context'

/**
 * Every session this client holds, keyed by Solus session id.
 *
 * A session is not a tab. It can have no tab (a headless agent, a draft that
 * just dispatched, a conversation closed while it still runs), one, or several
 * (a split chat). Tabs name a session by id and resolve it here; closing the
 * last tab on a session does not remove its record.
 *
 * The record objects are stable: event reduction, history, and the composer
 * mutate one session's properties in place, so a small update invalidates only
 * what reads that property rather than every surface reading the map.
 */
export class SessionRecords {
  byId = $state<Record<string, Session>>({})

  /**
   * Move a record to the id its host assigned. Refuses when another record
   * already answers to that id: re-keying would evict a live object out from
   * under whatever points at it. Tabs holding the old id are the caller's to
   * repoint — records do not know which tabs exist.
   */
  rekey(fromSessionId: string, toSessionId: string): boolean {
    const session = this.byId[fromSessionId]
    if (!session || fromSessionId === toSessionId || this.byId[toSessionId]) return false
    delete this.byId[fromSessionId]
    session.id = toSessionId
    this.byId[toSessionId] = session
    return true
  }
}

export const [getSessionRecords, setSessionRecords] = createAppContext<SessionRecords>('session-records')
