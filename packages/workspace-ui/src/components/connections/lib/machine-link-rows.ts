import { lastReachedText, machineLinkStateText, pairedHostRoute, type MachineLinkState, type MachineLinkView } from '@solus/client-core/host-linking'
import { routeKindLabel } from '@solus/client-core/host-route-control'
import type { HostLinkHealth, HostPairing } from '@solus/contracts/host-pairing'

/** One direction of a link, as a row of the Machine links section shows it. */
export interface LinkDirectionText {
  /** "Mac → NAS". */
  title: string
  state: MachineLinkState
  stateText: string
  /** "Owner access · Expires Dec 24 · Last reached 4 min ago · Linked Nov 2". */
  facts: string
  /** Every address of the link, the one it uses first. */
  addresses: string[]
  /** Why the link does not work; null when nothing failed. */
  error: string | null
}

const dateOf = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function directionText(from: string, to: string, pairing: HostPairing, health: HostLinkHealth | undefined, state: MachineLinkState, now: number): LinkDirectionText {
  const route = pairedHostRoute(pairing)
  const facts = [
    'Owner access',
    ...(route ? [routeKindLabel(route.kind)] : []),
    ...(health?.expiresAt ? [`Expires ${dateOf(health.expiresAt)}`] : []),
    ...(health ? [lastReachedText(health, now)] : []),
    `Linked ${dateOf(pairing.pairedAt)}`,
  ]
  const addresses = [...new Set([...(pairing.url ? [pairing.url] : []), ...pairing.listing.routes.map((other) => other.url)])]
  const error = state.kind === 'failing' ? state.detail : state.kind === 'unreachable' || state.kind === 'expired' ? state.detail : null
  return { title: `${from} → ${to}`, state, stateText: machineLinkStateText(state), facts: facts.join(' · '), addresses, error }
}

/** The directions of one link: one, or two for a two-way link. */
export function linkDirections(view: MachineLinkView, now: number): LinkDirectionText[] {
  return [
    directionText(view.sourceLabel, view.targetLabel, view.pairing, view.health, view.state, now),
    ...(view.back ? [directionText(view.targetLabel, view.sourceLabel, view.back.pairing, view.back.health, view.back.state, now)] : []),
  ]
}
