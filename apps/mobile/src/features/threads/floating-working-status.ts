// Adapted from T3 Code apps/mobile/src/features/threads/floating-working-status.ts (MIT, see UPSTREAM.md).
import type { HostConnectionPhase } from '../hosts/host-connections'

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and retries the host.
 */
export type FloatingWorkingStatus =
  | { readonly kind: 'working'; readonly startedAt: number }
  | { readonly kind: 'syncing'; readonly label: string }
  // The turn ended while a background task it started still runs.
  | { readonly kind: 'background'; readonly label: string; readonly accessibilityLabel: string; readonly waiting: boolean }
  // A new session the host has not started yet.
  | { readonly kind: 'preparing'; readonly label: string }
  | { readonly kind: 'connection'; readonly tone: 'reconnecting' | 'unavailable'; readonly label: string; readonly onPress: () => void }

/**
 * The pill's connection variant, or null once the host is connected and the
 * pill is free to report sync and working state instead. A T3 "environment"
 * is a Solus host.
 */
export function connectionFloatingStatus(input: {
  readonly connectionState: HostConnectionPhase | null
  readonly hostLabel: string | null
  readonly onReconnect: () => void
}): FloatingWorkingStatus | null {
  const hostLabel = input.hostLabel ?? 'Host'
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: 'connection',
    tone: 'unavailable',
    label,
    onPress: input.onReconnect,
  })

  switch (input.connectionState) {
    case 'connecting':
    case 'reconnecting':
      return { kind: 'connection', tone: 'reconnecting', label: `Reconnecting to ${hostLabel}...`, onPress: input.onReconnect }
    case 'offline':
      return unavailable(`${hostLabel} is offline`)
    case 'blocked':
      return unavailable(`${hostLabel} does not accept this device`)
    case 'waiting-for-compute':
      return unavailable(`${hostLabel} is not running`)
    case 'no-route':
      return unavailable(`${hostLabel} has no address yet`)
    case null:
      return unavailable(`${hostLabel} is not connected`)
    case 'connected':
      return null
  }
}

/** "12s", "3m 04s", "1h 2m": the running turn's age. */
export function formatWorkingDuration(startedAt: number, nowMs: number): string {
  if (!Number.isFinite(startedAt) || nowMs <= startedAt) return '0s'
  const totalSeconds = Math.floor((nowMs - startedAt) / 1_000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  if (totalSeconds >= 3_600) {
    const hours = Math.floor(totalSeconds / 3_600)
    const minutes = Math.floor((totalSeconds % 3_600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}m ${seconds}s`
}
