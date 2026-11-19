import type { HostReadinessState } from '@solus/client-core/host-readiness'

/** A host this client cannot reach now: past its grace, unreachable, or removed. */
export function isHostOffline(state: Pick<HostReadinessState, 'away' | 'readiness'>): boolean {
  return state.away || state.readiness === 'unreachable' || state.readiness === 'gone'
}

/**
 * The host the composer of a started session names as offline
 * (docs/plans/portable-sessions.md §10): the one with the newest turn, or the
 * run host when no other host has a newer one. Null when it can be reached.
 */
export function offlineLastRunHost(input: {
  newestServerId: string | null
  runServerId: string
  isOffline(serverId: string): boolean
}): string | null {
  const serverId = input.newestServerId ?? input.runServerId
  return input.isOffline(serverId) ? serverId : null
}

/**
 * Whether a started session keeps its composer while its run host is away:
 * the person can type, and choose another host in Run on. Without another
 * host to choose, or while a turn holds the host, the host's state takes the
 * composer's place as before.
 */
export function keepsComposerWhileAway(input: { hasStarted: boolean; isRunHostLocked: boolean; hasOtherHost: boolean }): boolean {
  return input.hasStarted && !input.isRunHostLocked && input.hasOtherHost
}
