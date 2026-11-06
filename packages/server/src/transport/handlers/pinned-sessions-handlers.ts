import { isHostOwner } from '../../admission/principal'
import { readManifest, togglePinnedSession } from '../../data/sessions/pinned-sessions'
import type { SolusServer } from '../server'

/**
 * Registers the pinned-sessions manifest handlers (sidebar pins + orb star). The
 * pins are the host owner's own: a member or a guest gets none, and cannot pin.
 */
export function registerPinnedSessionsHandlers(server: SolusServer): void {
  server.register('pinnedSessionsList', (_args, ctx) => isHostOwner(ctx.principal) ? readManifest() : [])

  server.register('togglePinnedSession', (args, ctx) => {
    if (!isHostOwner(ctx.principal)) throw new Error('Only the owner of this host pins sessions here.')
    const [session] = args
    return togglePinnedSession(session)
  })
}
