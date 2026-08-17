import { readManifest, togglePinnedSession } from '../../sessions/pinned-sessions'
import type { SolusServer } from '../server'

/** Registers the pinned-sessions manifest handlers (sidebar pins + orb star). */
export function registerPinnedSessionsHandlers(server: SolusServer): void {
  server.register('pinnedSessionsList', () => readManifest())

  server.register('togglePinnedSession', (args) => {
    const [session] = args
    return togglePinnedSession(session)
  })
}
