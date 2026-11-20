import { isHostOwner } from '../../admission/principal'
import { readPinnedSessions, togglePinnedSession } from '../../data/sessions/pinned-sessions'
import { hostUserKey } from '../../host/host-user'
import type { SolusServer } from '../server'

/**
 * Registers the pinned-sessions handlers (sidebar pins + orb star). The pins
 * here are the host owner's own: a member or a guest gets none, and cannot pin.
 */
export function registerPinnedSessionsHandlers(server: SolusServer): void {
  server.register('pinnedSessionsList', (_args, ctx) => isHostOwner(ctx.principal) ? readPinnedSessions(hostUserKey()) : [])

  server.register('togglePinnedSession', (args, ctx) => {
    if (!isHostOwner(ctx.principal)) throw new Error('Only the owner of this host pins sessions here.')
    const [session] = args
    return togglePinnedSession(hostUserKey(), session)
  })
}
