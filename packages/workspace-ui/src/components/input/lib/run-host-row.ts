import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { sessionCloudStateText, type SessionCloudState } from '@solus/client-core/session-cloud-state'

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
 * The host status note for a started session. A turn on another host
 * comes first: it decides where the next prompt goes. Then the offline host
 * with the newest turn, then "Not synced yet". A refused push is a card in the
 * conversation, not a note here.
 */
export function runHostRowNote(
  cloudState: SessionCloudState | null,
  offlineLabel: string | null,
  hostLabel: (serverId: string | null) => string,
): string | null {
  if (cloudState?.kind === 'running-elsewhere') return sessionCloudStateText(cloudState, hostLabel)
  if (offlineLabel) return `${offlineLabel} is offline`
  if (cloudState?.kind === 'not-synced') return sessionCloudStateText(cloudState, hostLabel)
  return null
}
