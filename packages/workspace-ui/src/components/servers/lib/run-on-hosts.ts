import type { RunConfig } from '@solus/contracts/types'
import type { ProjectRef } from '../../../contexts/projects/project-catalog'

/**
 * What choosing a host in the Run on picker does for the run's project. The
 * picker answers one question — which machine runs this project — and each
 * row says ahead of the click what that machine will use.
 */
export type RunOnHostAction =
  /** The run is already on this host. */
  | { kind: 'current' }
  /** The host holds a checkout of the project: the run moves into it. */
  | { kind: 'checkout'; path: string }
  /** The host has no checkout: Send copies the repository there. */
  | { kind: 'clone' }
  /** The project has no remote to copy, so the person picks a folder there. */
  | { kind: 'choose-folder' }

export interface RunOnHostInput {
  hostId: string
  /** The host the next session starts on, a queued choice included. */
  selectedHostId: string
  run: RunConfig
  /** The known checkouts of the run's project on every host, most recently
   *  used first. */
  checkouts: readonly ProjectRef[]
  /** The repository a host can copy, or null when the project has no hosted remote. */
  cloneRepoKey: string | null
}

export function runOnHostAction(input: RunOnHostInput): RunOnHostAction {
  if (input.hostId === input.selectedHostId) return { kind: 'current' }
  const path = checkoutPathOn(input.run, input.hostId, input.checkouts)
  if (path) return { kind: 'checkout', path }
  return input.cloneRepoKey ? { kind: 'clone' } : { kind: 'choose-folder' }
}

/** The folder on `hostId` that holds the run's project. A dispatched run's
 *  home remembers its own checkout; any other host is named by the catalog. */
export function checkoutPathOn(run: RunConfig, hostId: string, checkouts: readonly ProjectRef[]): string | null {
  if (run.projectGroupPath && run.taskServerId === hostId) return run.projectGroupPath
  return checkouts.find((checkout) => checkout.serverId === hostId)?.projectRoot ?? null
}

/** The second line of a row: what the host will use. The current host needs none. */
export function runOnHostNote(action: RunOnHostAction): string | null {
  switch (action.kind) {
    case 'checkout': return 'Uses its checkout'
    case 'clone': return 'Copies the repository'
    case 'choose-folder': return 'Choose a folder'
    case 'current': return null
  }
}

/** Hosts in the order a person decides: where the run is, then hosts that
 *  already hold the project, then the rest. Equal hosts keep their order. */
export function orderRunOnHosts<Host>(hosts: readonly Host[], actionFor: (host: Host) => RunOnHostAction): Host[] {
  const rank = (host: Host) => {
    const kind = actionFor(host).kind
    return kind === 'current' ? 0 : kind === 'checkout' ? 1 : 2
  }
  return hosts
    .map((host, index) => ({ host, index, rank: rank(host) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ host }) => host)
}
