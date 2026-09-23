import { isManagedHost } from '../server/managed-mode'

/**
 * Whether this host's agent-tool writes of tasks and works belong to the cloud
 * (docs/plans/cloud-service-model.md §16). Set by the runner delivery once the
 * host holds a runner grant for an organization's workspace service, cleared when
 * the link goes; read by the task and work tools before every write. A signed-out
 * or unlinked host applies locally as it always did.
 */

let organizationId: string | null = null

/**
 * Whether an agent's task writes on this host go to the organization's
 * workspace service. Tasks are local first (docs/plans/project-model.md §4):
 * only a cloud instance — a managed host linked to an organization — writes
 * them to the cloud; a person's own linked machine keeps its tasks, and a
 * person pushes one to the cloud on purpose.
 */
export function tasksAreCloudOwned(): boolean {
  return organizationId !== null && isManagedHost()
}

/** The organization whose workspace service owns this host's agent writes, or null when they are the host's own. */
export function cloudOwnedOrganization(): string | null {
  return organizationId
}

export function setCloudOwnedOrganization(next: string | null): void {
  organizationId = next
}
