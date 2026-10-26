import { isSessionBusyStatus, type SessionStatus } from '@solus/contracts/types'

/**
 * The client shows the session's background row (desktop, web) or pill
 * (mobile), with its Stop: in `background`, and when background work the agent
 * did not mark (a dev server, its Monitor) still runs after the turn completed
 * (docs/background-work.md). A busy session has its own live row and Stop.
 */
export function showsBackgroundWork(status: SessionStatus, backgroundWorkRunning: boolean): boolean {
  return status === 'background' || (backgroundWorkRunning && !isSessionBusyStatus(status))
}
