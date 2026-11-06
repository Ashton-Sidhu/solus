import { hostBalancePreference, type HostBalancing } from '@solus/client-core/host-balance'
import type { SavedServerUplink } from '@solus/client-core/server-registry'
import type { HostBalancePreference } from '@solus/contracts/settings'
import type { RunConfig } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import { checkoutPlace, runHost } from '../../../contexts/workspace/run-location'
import { canRunOnHost } from './managed-host'
import { checkoutPathOn, runOnHostAction } from './run-on-hosts'

export interface BalanceCandidate {
  serverId: string
  /** Where the run works on that host. */
  path: string
  preference: HostBalancePreference
}

interface BalanceServer {
  id: string
  installationId?: string
  readiness: string
  uplink?: SavedServerUplink
}

export interface BalanceCandidatesInput {
  run: RunConfig
  servers: readonly BalanceServer[]
  checkouts: readonly ProjectRef[]
  balancing: HostBalancing
  /** False when the host says it cannot run the run's agent. */
  runsAgent: (serverId: string) => boolean
}

/**
 * The hosts Auto balance may choose (docs/plans/resource-telemetry.md D6): up,
 * able to run work, not Manual only, and already holding the work. A host that
 * would need a clone is left out, because a clone is a large action that a
 * person chooses. A chat runs anywhere.
 */
export function balanceCandidates(input: BalanceCandidatesInput): BalanceCandidate[] {
  const { run, servers, checkouts, balancing, runsAgent } = input
  const selectedHostId = runHost(run)
  const place = checkoutPlace(run)
  const candidates: BalanceCandidate[] = []
  for (const server of servers) {
    const preference = hostBalancePreference(balancing, server)
    if (preference === 'manual' || server.readiness !== 'ready') continue
    if (!canRunOnHost(server.uplink) || !runsAgent(server.id)) continue
    const action = runOnHostAction({ hostId: server.id, selectedHostId, run, checkouts, cloneRepoKey: null })
    if (action.kind === 'clone' || action.kind === 'choose-folder') continue
    const path = action.kind === 'checkout'
      ? action.path
      : action.kind === 'chat'
        ? NEW_CHAT_DIRECTORY
        : checkoutPathOn(run, server.id, checkouts) ?? place.path
    candidates.push({ serverId: server.id, path, preference })
  }
  return candidates
}
