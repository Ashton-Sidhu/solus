import type { Session, StatusCardState } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { sessionSyncCardView, type SessionSyncCardNames } from '@solus/client-core/session-sync-card'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { sessionListStore } from '../../../contexts/workspace/session-list.store.svelte'
import { runHost } from '../../../contexts/workspace/run-location'
import { agentLabel } from '../../../lib/agentAvailability'

/**
 * The names a session's sync card uses: the host the session comes from (the
 * one with its newest turn), the run host, and the agent. A host this client
 * cannot name is called by its role, never by an id.
 */
export function sessionSyncNames(input: {
  runServerId: string
  /** The host with the newest turn, as the session list store answers. */
  newestServerId: string | null
  labelOf(serverId: string): string | undefined
  provider: string
}): SessionSyncCardNames {
  const { runServerId, newestServerId, labelOf } = input
  const sourceHost = newestServerId && newestServerId !== runServerId ? labelOf(newestServerId) : undefined
  return {
    sourceHost: sourceHost ?? 'the last host',
    runHost: labelOf(runServerId) ?? 'this host',
    provider: input.provider,
  }
}

/** A host's name. The catalog names a host that is offline too, which is
 *  when a card needs it most. */
export function knownHostLabel(serverId: string): string | undefined {
  return hostCatalog.find(serverId)?.label
    ?? serverConnections.connectionFor(serverId)?.target.label
}

/** A status card as a session keeps it: a sync card names its hosts and agent
 *  when it arrives; every other card is kept as it came. */
export function presentedStatusCard(session: Pick<Session, 'id' | 'run'>, card: StatusCardState): StatusCardState {
  const runServerId = serverConnections.resolveId(runHost(session.run))
  return sessionSyncCardView(card, sessionSyncNames({
    runServerId,
    newestServerId: sessionListStore.newestHostFor(session.id, runServerId),
    labelOf: knownHostLabel,
    provider: agentLabel(session.run.provider ?? 'claude-code'),
  }))
}
