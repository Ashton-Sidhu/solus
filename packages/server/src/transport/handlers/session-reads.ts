import type { SessionReads } from '../../execution/sessions/session-forks'
import type { CallerCtx, SolusServer } from '../server'

/** Session reads with the access of one caller: each goes through the RPC and its checks. */
export function sessionReadsFor(server: SolusServer, caller: CallerCtx): SessionReads {
  return {
    sessionInfo: (sessionId) => server.handle('getSessionInfo', [sessionId], caller),
    loadPage: (request) => server.handle('loadSessionPage', [request], caller),
  }
}
