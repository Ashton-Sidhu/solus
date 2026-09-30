import type { SolusServer } from '../server'
import type { Watch } from '@solus/contracts/watch-types'
import {
  cancelWatch,
  listWatchesForSession,
  loadWatch,
  pauseWatch,
  resumeWatch,
} from '../../watches/watches-store'

/** A watch the caller may change: it must belong to the session access was
 *  checked against. */
function ownedBy(sessionId: string, watchId: string): Watch | null {
  const watch = loadWatch(watchId)
  return watch && watch.sessionId === sessionId ? watch : null
}

/** RPC surface for the watch list, card, and panel (docs/plans/watches.md §8). */
export function registerWatchHandlers(server: SolusServer): void {
  server.register('watchList', async (args) => listWatchesForSession(args[0]))
  server.register('watchPause', async (args) => ownedBy(args[0], args[1]) ? pauseWatch(args[1]) : null)
  server.register('watchResume', async (args) => ownedBy(args[0], args[1]) ? resumeWatch(args[1]) : null)
  server.register('watchCancel', async (args) => ownedBy(args[0], args[1]) ? cancelWatch(args[1], 'user') : null)
}
