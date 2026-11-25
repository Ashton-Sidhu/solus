import { isSessionBusyStatus, type SessionStatus } from '@solus/contracts/types'
import type { RunningServer } from '@solus/contracts/running-servers'

/**
 * The client shows the session's background row (desktop, web) or pill
 * (mobile), with its Stop: in `background`, and when background work the agent
 * did not mark (a dev server, its Monitor) still runs after the turn completed
 * (docs/background-work.md). A busy session has its own live row and Stop.
 */
export function showsBackgroundWork(status: SessionStatus, backgroundWorkRunning: boolean): boolean {
  return status === 'background' || (backgroundWorkRunning && !isSessionBusyStatus(status))
}

/**
 * Whether the session's background work is only servers that the Running
 * servers list already shows, so the person's setting
 * `hideServerBackgroundWork` can leave the background row out. The agent waits
 * on nothing (`isAwaited` is false: an awaited wait always shows its row),
 * every running task is a shell command, and the session's agent runs at least
 * as many servers. Solus cannot tell which command started which server, so
 * the count stands in for that. A task the host did not name keeps the row.
 */
export function backgroundWorkIsServers(
  isAwaited: boolean,
  tasks: readonly { kind?: string }[] | undefined,
  agentServerCount: number,
): boolean {
  if (isAwaited || !tasks?.length) return false
  return tasks.every((task) => task.kind === 'command') && agentServerCount >= tasks.length
}

/** The servers that one session's agent started, from its host's Running servers list. */
export function agentServersOf<Server extends Pick<RunningServer, 'startedBy'>>(servers: readonly Server[], sessionId: string): Server[] {
  return servers.filter((server) => server.startedBy.kind === 'agent' && server.startedBy.sessionId === sessionId)
}
