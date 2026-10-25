// Adapted from T3 Code apps/mobile/src/features/threads/floating-working-status.ts (MIT, see UPSTREAM.md).

/** A control the pill carries beside its label. */
export interface FloatingStatusAction {
  readonly label: string
  readonly accessibilityLabel: string
  readonly disabled: boolean
  readonly onPress: () => void
}

/**
 * What the floating pill says. Syncing, working, and the other states share
 * one element so the label swaps in place instead of one pill fading out for
 * another.
 */
export type FloatingWorkingStatus =
  | { readonly kind: 'working'; readonly startedAt: number }
  | { readonly kind: 'syncing'; readonly label: string }
  // The turn ended while a background task it started still runs.
  | { readonly kind: 'background'; readonly label: string; readonly accessibilityLabel: string; readonly waiting: boolean; readonly action: FloatingStatusAction }
  // A new session the host has not started yet.
  | { readonly kind: 'preparing'; readonly label: string }

/**
 * The pill while the turn has ended but work it started still runs. Its Stop
 * ends only that work, as the desktop and web background row does; it stays
 * there when the composer holds a draft and shows Send in place of Stop. A
 * viewer cannot stop the session, so the control is disabled for them.
 */
export function backgroundFloatingStatus(input: {
  readonly mayDrive: boolean
  readonly stopping: boolean
  readonly onStop: () => void
}): FloatingWorkingStatus {
  return {
    kind: 'background',
    label: 'Background task running',
    accessibilityLabel: 'A background task the agent started is still running',
    waiting: true,
    action: {
      label: input.stopping ? 'Stopping...' : 'Stop',
      accessibilityLabel: input.stopping ? 'Stopping the background work' : 'Stop the background work',
      disabled: !input.mayDrive || input.stopping,
      onPress: input.onStop,
    },
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
