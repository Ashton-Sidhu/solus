import { isWaitingForHost, type HostReadiness } from '@solus/client-core/host-readiness'

/**
 * What the overlay says about the host that serves a web client's window
 * (docs/plans/host-readiness.md). A pill for a state that will probably
 * resolve on its own, a card for one that wants a decision.
 */
export type ConnectionOverlayMode = 'hidden' | 'waiting' | 'card'

export function connectionOverlayMode(readiness: HostReadiness): ConnectionOverlayMode {
  if (readiness === 'ready' || readiness === 'gone') return 'hidden'
  return isWaitingForHost(readiness) ? 'waiting' : 'card'
}
