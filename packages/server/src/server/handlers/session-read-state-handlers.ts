import { markUnread, markViewed } from '../../sessions/session-read-state'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import type { SolusServer } from '../server'

/**
 * Read state for a session, owned by the host rather than by whichever client
 * happened to open it.
 *
 * One method rather than a read/unread pair: the state is a single nullable
 * boundary, and the event that carries it back is a single nullable field too.
 * The two directions differ only in their rule — a read is monotonic, clearing
 * is not — and that belongs in the decider, not in the wire surface.
 *
 * Broadcasts rather than answering only its caller: the point of moving this
 * off the client is that reading a session on the desktop clears its indicator
 * on the phone too.
 */
export function registerSessionReadStateHandlers(
  server: SolusServer,
  deps: { events: HostEventPublisher },
): void {
  server.register('setSessionReadState', (args) => {
    const [sessionId, viewedAt] = args
    let settled: number | null = null
    if (viewedAt !== null) settled = markViewed(sessionId, viewedAt)
    else markUnread(sessionId)
    deps.events.broadcast('session.readStateChanged', { sessionId, viewedAt: settled })
    return settled
  })
}
