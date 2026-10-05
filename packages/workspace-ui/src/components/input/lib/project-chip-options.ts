import type { LogicalProject, ProjectRef } from '../../../contexts/projects/project-catalog'

/** One row of the project chip: a project, never one of its checkouts. */
export interface ProjectChipOption {
  /** The project: its repository key, or a local-only folder's key. */
  key: string
  label: string
  /** The checkout the next session opens in, on a host that is online. */
  checkout: ProjectRef
  /** The host named beside the label when that checkout is not on the host
   *  the run is on, so choosing the project visibly moves the run. */
  hostLabel: string | null
}

/**
 * The project chip lists projects, and the Run on picker beside it chooses the
 * machine (docs/plans/project-model.md). A project opens in its checkout on the
 * run's host when that host is online and holds one, else in its most recently
 * used checkout on another online host. A project whose every checkout is on an
 * offline host is not listed: nothing could open it, and on a client that
 * reaches a host from afar it is often a machine the person is not using now.
 */
export function projectChipOptions(
  projects: readonly LogicalProject[],
  selectedHostId: string,
  isOnline: (serverId: string) => boolean,
  hostLabelFor: (serverId: string) => string,
): ProjectChipOption[] {
  return projects.flatMap((project): ProjectChipOption[] => {
    const online = project.checkouts.filter((checkout) => isOnline(checkout.serverId))
    const chosen = online.find((checkout) => checkout.serverId === selectedHostId) ?? online[0]
    if (!chosen) return []
    const checkout = { serverId: chosen.serverId, projectRoot: chosen.projectRoot }
    return [{
      key: project.key,
      label: project.label,
      checkout,
      hostLabel: checkout.serverId !== selectedHostId ? hostLabelFor(checkout.serverId) : null,
    }]
  })
}
