import type { ConnectionStatus } from './ws-transport'

export interface ConnectionDisplayOptions {
  attempt?: number
  hasConnected?: boolean
}

export function presentedConnectionStatus(
  status: ConnectionStatus,
  { attempt = 0, hasConnected = false }: ConnectionDisplayOptions = {},
): ConnectionStatus {
  if (status === 'reconnecting' && !hasConnected && attempt <= 1) return 'connecting'
  return status
}

export function connectionStatusLabel(
  status: ConnectionStatus,
  { attempt = 0, hasConnected = false }: ConnectionDisplayOptions = {},
): string {
  const presented = presentedConnectionStatus(status, { attempt, hasConnected })
  if (presented === 'connected') return 'Connected'
  if (presented === 'blocked') return 'Sign-in required'
  if (presented === 'reconnecting') {
    return attempt > 0 ? `Reconnecting (attempt ${attempt})...` : 'Reconnecting...'
  }
  if (presented === 'connecting') {
    return attempt > 1 ? `Connecting (attempt ${attempt})...` : 'Connecting...'
  }
  return 'Disconnected'
}

/**
 * A reconnect running this long has stopped reading as a blip. Past it the pill
 * escalates to a card, so the user is offered the local host instead of
 * watching a counter climb with nothing to do about it.
 */
export const RECONNECT_ESCALATE_MS = 12_000

export interface ConnectionFailureCopy {
  /** Names the situation. */
  title: string
  /** Names the likely cause and what to do about it. */
  detail: string
}

/**
 * socket.io reports failures as mechanism strings — "xhr poll error",
 * "websocket error", "timeout". Each names the layer that gave up, never a
 * reason the user can act on, so lead with a cause and keep the raw text for
 * the details block.
 */
export function describeConnectionFailure(hostLabel: string, error: unknown): ConnectionFailureCopy {
  const message = error instanceof Error ? error.message : String(error)
  if (/token|unauthori[sz]ed/i.test(message)) {
    return {
      title: `${hostLabel} needs pairing again`,
      detail: 'The saved session token was rejected. Pair with this host again to pick up where you left off.',
    }
  }
  if (/bridge is unavailable/i.test(message)) {
    return {
      title: 'Solus could not start',
      detail: 'The desktop bridge did not load. Restarting Solus usually clears this.',
    }
  }
  return {
    title: `Solus can't reach ${hostLabel}`,
    detail: 'The host did not answer. It may be asleep, or no longer on this network.',
  }
}

/** `9s`, `1m 04s` — a counter that stays the same width as it climbs. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
}
