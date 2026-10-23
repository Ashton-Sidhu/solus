import { RECONNECT_ESCALATE_MS } from '@solus/client-core/connection-display'
import type { BlockedReason, HostPhase } from '@solus/client-core/host-supervisor'

/**
 * What the overlay is saying right now. The shape carries the meaning: a pill
 * for something that will probably resolve on its own, a card for something
 * that wants a decision.
 */
export type ConnectionOverlayMode = 'hidden' | 'reconnecting' | 'escalated' | 'blocked' | 'identity-mismatch' | 'update-required'

export interface ConnectionOverlayInput {
  phase: HostPhase
  blockedReason: BlockedReason | null
  /** When the active host last stopped being connected, or null while up. */
  offlineSince: number | null
  now: number
  isRemote: boolean
}

export function connectionOverlayMode({
  phase,
  blockedReason,
  offlineSince,
  now,
  isRemote,
}: ConnectionOverlayInput): ConnectionOverlayMode {
  // The local server is in-process. A blip there is a bug worth surfacing
  // elsewhere, not a network condition a user can retry their way out of.
  if (!isRemote) return 'hidden'
  if (phase === 'blocked') return blockedReason === 'identity-mismatch' || blockedReason === 'update-required' ? blockedReason : 'blocked'
  if (phase === 'connected') return 'hidden'
  if (offlineSince === null) return 'reconnecting'
  return now - offlineSince >= RECONNECT_ESCALATE_MS ? 'escalated' : 'reconnecting'
}
