import type { Session } from '@solus/contracts/types'
import { connectRequestStore } from '../connections/connect-request.store.svelte'
import { turnRefusalStore } from '../connections/turn-refusal.store.svelte'
import { agentAuthStore } from '../seats/agent-auth.store.svelte'
import { seatsStore } from '../seats/seats.store.svelte'

/**
 * The cards at the tail of a transcript (setup, host, connect, seat, sign-in,
 * refusal) answer an earlier send. A new send replaces them, so they leave.
 * Work still in progress stays: an active setup card and a sign-in that waits
 * on the browser. If the new send still needs a card, the host refuses it
 * again and the card comes back.
 */
export function clearSettledCards(session: Session): void {
  if (session.statusCard && session.statusCard.status !== 'active') session.statusCard = null
  const { serverId } = session.run
  if (connectRequestStore.visibleFor(serverId, session.id)) connectRequestStore.dismiss()
  if (turnRefusalStore.visibleFor(serverId, session.id)) turnRefusalStore.dismiss()
  if (seatsStore.visibleFor(serverId, session.id)) seatsStore.dismiss()
  const authPhase = agentAuthStore.flow?.phase
  if (agentAuthStore.visibleFor(serverId, session.id) && authPhase !== 'starting' && authPhase !== 'waiting') {
    agentAuthStore.dismiss()
  }
}
